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
      db.prepare("SELECT title, revid FROM airline_status WHERE source = 'article'").all() as {
        title: string;
        revid: number | null;
      }[]
    ).map((r) => [r.title, r.revid]),
  );
  const revisions = await fetchLatestRevisions(titles);
  const changed = titles.filter((t) => {
    const rev = revisions.get(t);
    return rev && known.get(t) !== rev.revid;
  });
  if (changed.length) log(`  checking ${changed.length} airline articles for "ceased operations"…`);

  const now = new Date().toISOString();
  const save = db.prepare(`
    INSERT INTO airline_status (title, source, revid, defunct, ceased, checked_at)
    VALUES (?, 'article', ?, ?, ?, ?)
    ON CONFLICT(title, source) DO UPDATE SET revid = excluded.revid, defunct = excluded.defunct,
      ceased = excluded.ceased, checked_at = excluded.checked_at
  `);
  for (const [i, title] of changed.entries()) {
    if (i && i % 50 === 0) log(`  airline articles ${i}/${changed.length}`);
    const rev = revisions.get(title)!;
    try {
      const lead = await fetchArticleLead(rev.revid);
      if (!lead.ok) continue;
      const j = judgeAirline(lead.value, today);
      tx(db, () => save.run(title, rev.revid, j.defunct ? 1 : 0, j.ceased, now));
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
