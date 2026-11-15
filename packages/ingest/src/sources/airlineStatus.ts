import * as cheerio from "cheerio";
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db";
import { fetchArticleLead, fetchLatestRevisions, type ArticleLead } from "../wikipedia/api";
import { parseLooseDate } from "../wikipedia/dates";

export interface Defunctness {
  defunct: boolean;
  /** The infobox's "Ceased operations" text, when present. */
  ceased: string | null;
}

export interface AirlineCodes {
  iata: string | null;
  icao: string | null;
}

/** Bump when the article parsing changes, so cached articles are re-read once. */
export const ARTICLE_PARSER_VERSION = 2;

/**
 * IATA and ICAO codes from an airline infobox's codes table (IATA | ICAO | Call sign headers,
 * values in the next row). Wikidata lacks codes for many newer airlines; their articles have them.
 */
export function infoboxCodes(html: string): AirlineCodes {
  const $ = cheerio.load(html);
  $("sup").remove();
  const table = $("table.infobox-airline-codes").first();
  const out: AirlineCodes = { iata: null, icao: null };
  if (!table.length) return out;
  const headers = table
    .find("tr")
    .first()
    .children("th")
    .map((_, th) => $(th).text().trim().toUpperCase())
    .get();
  const values = table
    .find("tr")
    .eq(1)
    .children("td")
    .map((_, td) => $(td).text().trim().toUpperCase())
    .get();
  const iata = values[headers.indexOf("IATA")]?.match(/\b[A-Z0-9]{2}\b/)?.[0];
  const icao = values[headers.indexOf("ICAO")]?.match(/\b[A-Z]{3}\b/)?.[0];
  if (iata && /[A-Z]/.test(iata)) out.iata = iata;
  if (icao) out.icao = icao;
  return out;
}

const STOPWORDS = new Set([
  "air",
  "airline",
  "airlines",
  "airways",
  "aviation",
  "the",
  "de",
  "of",
  "and",
  "linhas",
  "aereas",
  "lineas",
  "aerea",
  "aereo",
]);
const words = (title: string) =>
  new Set(
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );

/**
 * Whether an airline's own infobox code can be used for it. IATA codes get reused, so a code
 * already held by a different airline is only accepted when the two clearly belong together
 * (share a distinctive name word: "LATAM Chile" and "LATAM Airlines").
 */
export function canAdoptCode(
  title: string,
  iata: string,
  holderTitle: string | undefined,
): boolean {
  if (!holderTitle) return true;
  if (holderTitle === title) return true;
  const a = words(title);
  return [...words(holderTitle)].some((w) => a.has(w));
}

/**
 * Whether an airline article says the airline no longer flies:
 * - its infobox has a "Ceased operations" date that has passed, or
 * - it is in a "Defunct airlines…" category and its first paragraph is in the past tense
 *   ("Fly540 was a low-cost airline…").
 * Airport pages lag behind these articles, so this catches airlines still listed after shutting down.
 */
export function judgeAirline(lead: ArticleLead, today: Date): Defunctness {
  const $ = cheerio.load(lead.html);
  let ceased: string | null = null;
  $("table.infobox tr").each((_, tr) => {
    const th = $(tr).find("th").first().text().trim();
    if (/ceased operations/i.test(th))
      ceased = $(tr).find("td").first().text().replace(/\s+/g, " ").trim();
  });
  if (ceased) {
    const date = parseLooseDate(ceased);
    if (date && date <= today) return { defunct: true, ceased };
  }
  const inDefunctCategory = lead.categories.some((c) => /^Defunct airlines/i.test(c));
  const intro = $("p")
    .toArray()
    .map((p) => $(p).text().trim())
    .find((t) => t.length > 40);
  const pastTense = !!intro && /\b(was|were) (a|an|the)\b/i.test(intro.slice(0, 300));
  return { defunct: inDefunctCategory && pastTense, ceased };
}

/**
 * Check every airline article linked from current listings, re-reading only articles whose
 * revision changed. Returns the titles judged defunct (by article or by Wikidata).
 */
export async function refreshAirlineStatus(
  db: DatabaseSync,
  titles: string[],
  today: Date,
  log: (s: string) => void,
): Promise<Set<string>> {
  const known = new Map(
    (
      db
        .prepare("SELECT title, revid, parsed_v FROM airline_status WHERE source = 'article'")
        .all() as { title: string; revid: number | null; parsed_v: number }[]
    ).map((r) => [r.title, r.parsed_v >= ARTICLE_PARSER_VERSION ? r.revid : null]),
  );
  const revisions = await fetchLatestRevisions(titles);
  const changed = titles.filter((t) => {
    const rev = revisions.get(t);
    return rev && known.get(t) !== rev.revid;
  });
  if (changed.length) log(`  checking ${changed.length} airline articles for "ceased operations"…`);

  const now = new Date().toISOString();
  const save = db.prepare(`
    INSERT INTO airline_status (title, source, revid, defunct, ceased, checked_at, iata, icao, parsed_v)
    VALUES (?, 'article', ?, ?, ?, ?, ?, ?, ${ARTICLE_PARSER_VERSION})
    ON CONFLICT(title, source) DO UPDATE SET revid = excluded.revid, defunct = excluded.defunct,
      ceased = excluded.ceased, checked_at = excluded.checked_at, iata = excluded.iata,
      icao = excluded.icao, parsed_v = excluded.parsed_v
  `);
  for (const [i, title] of changed.entries()) {
    if (i && i % 50 === 0) log(`  airline articles ${i}/${changed.length}`);
    const rev = revisions.get(title)!;
    try {
      const lead = await fetchArticleLead(rev.revid);
      if (!lead.ok) continue;
      const j = judgeAirline(lead.value, today);
      const codes = infoboxCodes(lead.value.html);
      tx(db, () =>
        save.run(title, rev.revid, j.defunct ? 1 : 0, j.ceased, now, codes.iata, codes.icao),
      );
    } catch (err) {
      log(`  airline status: ${title}: ${String(err)}`);
    }
  }

  return new Set(
    (
      db.prepare("SELECT DISTINCT title FROM airline_status WHERE defunct = 1").all() as {
        title: string;
      }[]
    ).map((r) => r.title),
  );
}
