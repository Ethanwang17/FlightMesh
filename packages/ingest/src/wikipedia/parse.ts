import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { normalizeTitle } from "../wiki";

/** How a destination is flown, from the "Seasonal:" / "Charter:" labels before it. */
export type Mode = "scheduled" | "seasonal" | "charter" | "seasonal_charter";

export interface ParsedDestination {
  /** Linked article title, normalized. */
  title: string;
  /** Visible link text, e.g. "Mexico City–Benito Juárez". */
  text: string;
  mode: Mode;
  seasonal: boolean;
  charter: boolean;
  /** Text in parentheses right after the link, e.g. "begins 29 March 2027" or "via Muscat". */
  note: string;
}

export interface ParsedRow {
  airlineTitle: string | null;
  airlineText: string;
  destinations: ParsedDestination[];
}

/**
 * Tables under any heading matching this are not current scheduled passenger routes:
 * cargo, statistics, and route lists from the past or the future.
 */
const EXCLUDED_HEADING =
  /cargo|freight|charter|statistic|traffic|busiest|top destinations|market share|map|histor|former|previous|\bbefore\b|prior to|defunct|ceased|terminated|chronolog|future|planned|proposed|helicopter|incident|accident/i;
const NON_ARTICLE =
  /^(File|Image|Help|Wikipedia|Template|Category|Special|Portal|Talk|Wiktionary):/i;
const LABEL = /(seasonal\s+charter|charter|seasonal|year[- ]round|regular)\s*:/gi;

function modeFor(label: string): Mode | null {
  const l = label.toLowerCase().replace(/\s+/g, " ");
  if (l.startsWith("seasonal charter")) return "seasonal_charter";
  if (l.startsWith("charter")) return "charter";
  if (l.startsWith("seasonal")) return "seasonal";
  if (l.startsWith("year") || l.startsWith("regular")) return "scheduled";
  return null;
}

/** Article title from an internal /wiki/ link, or null for red links, anchors and other namespaces. */
function linkTitle(href: string | undefined): string | null {
  if (!href || !href.startsWith("/wiki/") || href.includes("redlink=1")) return null;
  const title = normalizeTitle(href.slice("/wiki/".length));
  return title && !NON_ARTICLE.test(title) ? title : null;
}

const HEADING_LEVEL: Record<string, number> = { h2: 2, h3: 3, h4: 4, h5: 5 };

/**
 * Parse "Airlines and destinations" tables out of rendered HTML.
 * Pure: no network, no lookups. Resolution to codes and note classification happen later.
 */
export function parseDestinationTables(html: string): ParsedRow[] {
  const $ = cheerio.load(html);
  // Footnotes, "citation needed" tags and hidden sort keys add noise between links.
  $("sup, style, .mw-editsection, .sortkey, .noprint").remove();

  const rows: ParsedRow[] = [];
  // Heading text by level, so a table under "Former destinations > Passenger" is skipped too.
  const headings: string[] = [];

  $("h2, h3, h4, h5, table.wikitable").each((_, el) => {
    const level = HEADING_LEVEL[el.tagName];
    if (level) {
      headings.length = level;
      headings[level - 1] = $(el).text();
      return;
    }
    if (headings.some((h) => h && EXCLUDED_HEADING.test(h))) return;

    const headerCells = $(el).find("tr").first().children("th, td");
    const headers = headerCells.map((_, c) => $(c).text().trim().toLowerCase()).get();
    const airlineCol = headers.findIndex((h) => h.includes("airline"));
    const destCol = headers.findIndex((h) => h.includes("destination"));
    if (airlineCol < 0 || destCol < 0) return;

    $(el)
      .find("tr")
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr).children("th, td");
        if (cells.length <= Math.max(airlineCol, destCol) || $(tr).children("td").length === 0)
          return;

        const airlineCell = cells.eq(airlineCol);
        const airlineLink = airlineCell
          .find("a")
          .toArray()
          .map((a) => linkTitle(a.attribs.href))
          .find((t) => t !== null);

        const destinations = walkDestinations(cells.get(destCol)!);
        if (!destinations.length) return;
        rows.push({
          airlineTitle: airlineLink ?? null,
          airlineText: airlineCell.text().replace(/\s+/g, " ").trim(),
          destinations,
        });
      });
  });

  return rows;
}

/** Text content of a node. (cheerio.load(node) would re-parent it and break the walk.) */
function textOf(node: AnyNode): string {
  if (node.type === "text") return node.data;
  if (node.type === "tag") return node.children.map(textOf).join("");
  return "";
}

/**
 * Walk a destination cell in document order.
 * - A "Seasonal:" / "Charter:" / "Year-round:" label sets the mode for every destination after it.
 * - Text in parentheses after a destination is its note. Links inside the parentheses belong to
 *   the note, so "Dubai (via Muscat)" is one destination with the note "via Muscat".
 * - A comma or <br> outside parentheses ends the current destination's note.
 */
function walkDestinations(cell: AnyNode): ParsedDestination[] {
  const out: ParsedDestination[] = [];
  let mode: Mode = "scheduled";
  let pending: ParsedDestination | null = null;
  let depth = 0;

  const text = (s: string) => {
    let outside = "";
    for (const ch of s) {
      if (ch === "(") {
        depth++;
        if (pending) pending.note += ch;
        continue;
      }
      if (depth > 0) {
        if (pending) pending.note += ch;
        if (ch === ")") depth--;
        continue;
      }
      outside += ch;
      // Only a comma ends a destination's note; newlines in HTML source are just whitespace.
      if (ch === ",") pending = null;
    }
    for (const m of outside.matchAll(LABEL)) {
      pending = null;
      mode = modeFor(m[1]!) ?? mode;
    }
  };

  const visit = (node: AnyNode) => {
    if (node.type === "text") return text(node.data);
    if (node.type !== "tag") return;

    if (node.name === "br") {
      if (depth === 0) pending = null;
      return;
    }

    if ((node.name === "b" || node.name === "strong") && depth === 0) {
      const label = modeFor(textOf(node).trim());
      if (label) {
        pending = null;
        mode = label;
        return;
      }
    }

    if (node.name === "a") {
      const title = linkTitle(node.attribs.href);
      if (title && depth > 0) {
        if (pending) pending.note += textOf(node);
        return;
      }
      if (title) {
        pending = {
          title,
          text: textOf(node).trim(),
          mode,
          seasonal: mode === "seasonal" || mode === "seasonal_charter",
          charter: mode === "charter" || mode === "seasonal_charter",
          note: "",
        };
        out.push(pending);
        return;
      }
    }

    for (const child of node.children) visit(child);
  };

  if (cell.type === "tag") for (const child of cell.children) visit(child);
  for (const d of out) d.note = d.note.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return out;
}
