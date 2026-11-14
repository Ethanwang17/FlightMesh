import type { DatabaseSync } from "node:sqlite";
import { loadCurated, loadOverrides } from "../curated";
import { setMeta, tx } from "../db";
import { contact } from "../http";
import {
  estimateMinutes,
  fetchLatestRevisions,
  fetchSectionHtml,
  fetchSections,
  resolveRedirectTitles,
} from "../wikipedia/api";
import { parseDestinationTables, type ParsedRow } from "../wikipedia/parse";
import {
  collectEvidence,
  resolveAirline,
  resolveRoutes,
  titlesNeedingRedirects,
  type Lookups,
  type Overrides,
  type PageInput,
  type Unresolved,
} from "../wikipedia/resolve";
import { pickDestinationsSection } from "../wikipedia/sections";
import { refreshAirlineStatus } from "./airlineStatus";

const REDIRECT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Page guard: a page that used to list at least this many destinations and now parses to under
 * half as many is treated as a parse failure (or vandalism) and keeps its previous listings.
 */
export const GUARD_MIN_PREVIOUS = 5;
export const GUARD_MIN_RATIO = 0.5;

export interface RouteIngestOptions {
  /** Only these airports (IATA), scheduled or not. Skips the second pass. */
  only?: string[];
  limit?: number;
  /** Refetch every page even if its revision hasn't changed. */
  full?: boolean;
  /** Accept these pages' new listings even if the guard trips (after checking them by hand). */
  accept?: string[];
  /** Reference date for begins/ends notes. Default: now. */
  today?: Date;
  log?: (line: string) => void;
}

export interface RouteIngestSummary {
  checked: number;
  fetched: number;
  unchanged: number;
  guarded: string[];
  failed: number;
  routes: number;
  conflicts: number;
  unresolved: number;
  charter: number;
  defunct: number;
}

type Log = (line: string) => void;

/** Total destinations in a page's rows: what the guard compares. */
export const destinationCount = (rows: ParsedRow[]) =>
  rows.reduce((n, r) => n + r.destinations.length, 0);

/** Pure guard decision, exported for tests. */
export function guardTrips(previous: number, next: number): boolean {
  return previous >= GUARD_MIN_PREVIOUS && next < previous * GUARD_MIN_RATIO;
}

export async function ingestRoutes(
  db: DatabaseSync,
  opts: RouteIngestOptions = {},
): Promise<RouteIngestSummary> {
  const log = opts.log ?? console.log;
  const today = opts.today ?? new Date();
  const summary: RouteIngestSummary = {
    checked: 0,
    fetched: 0,
    unchanged: 0,
    guarded: [],
    failed: 0,
    routes: 0,
    conflicts: 0,
    unresolved: 0,
    charter: 0,
    defunct: 0,
  };

  let todo: { iata: string; title: string }[];
  if (opts.only?.length) {
    const only = new Set(opts.only.map((c) => c.toUpperCase()));
    todo = allPages(db).filter((a) => only.has(a.iata));
  } else {
    todo = db
      .prepare(
        "SELECT iata, wikipedia_title AS title FROM airports WHERE wikipedia_title IS NOT NULL AND scheduled = 1 ORDER BY iata",
      )
      .all() as { iata: string; title: string }[];
  }
  if (opts.limit) todo = todo.slice(0, opts.limit);

  await refreshPages(db, todo, opts, summary, log);

  // Second pass: airports that other pages fly to but OurAirports doesn't flag as scheduled.
  if (!opts.only?.length && !opts.limit) {
    const extra = referencedWithoutPages(db);
    if (extra.length) {
      log(
        `  ${extra.length} more airports are listed as destinations but not flagged scheduled; reading their pages too`,
      );
      await refreshPages(db, extra, opts, summary, log);
    }
  }

  const derived = await deriveRoutes(db, today, log);
  Object.assign(summary, derived);
  setMeta(db, "routes_ingested_at", new Date().toISOString());
  return summary;
}

function allPages(db: DatabaseSync): { iata: string; title: string }[] {
  return db
    .prepare(
      "SELECT iata, wikipedia_title AS title FROM airports WHERE wikipedia_title IS NOT NULL ORDER BY iata",
    )
    .all() as { iata: string; title: string }[];
}

/** Destination airports in current listings that have a Wikipedia title but no page row yet. */
function referencedWithoutPages(db: DatabaseSync): { iata: string; title: string }[] {
  const lookups = baseLookups(db);
  const redirects = cachedRedirects(db);
  const seen = new Set(
    (db.prepare("SELECT iata FROM pages").all() as { iata: string }[]).map((r) => r.iata),
  );
  const referenced = new Set<string>();
  for (const page of loadPages(db)) {
    for (const row of page.rows) {
      for (const d of row.destinations) {
        const code =
          lookups.airportByTitle.get(d.title) ??
          lookups.airportByTitle.get(redirects.get(d.title) ?? "");
        if (code && !seen.has(code)) referenced.add(code);
      }
    }
  }
  return allPages(db).filter((a) => referenced.has(a.iata));
}

async function refreshPages(
  db: DatabaseSync,
  airports: { iata: string; title: string }[],
  opts: RouteIngestOptions,
  summary: RouteIngestSummary,
  log: Log,
): Promise<void> {
  if (!airports.length) return;
  const accept = new Set((opts.accept ?? []).map((c) => c.toUpperCase()));
  log(
    `  checking ${airports.length} pages for new revisions (${Math.ceil(airports.length / 50)} requests)…`,
  );
  const revisions = await fetchLatestRevisions(airports.map((a) => a.title));

  const prevPage = db.prepare("SELECT revid, status FROM pages WHERE iata = ?");
  const prevListings = db.prepare("SELECT rows_json FROM page_listings WHERE iata = ?");
  const savePage = db.prepare(`
    INSERT INTO pages (iata, title, revid, rev_ts, status, section, rows, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(iata) DO UPDATE SET title = excluded.title, revid = excluded.revid, rev_ts = excluded.rev_ts,
      status = excluded.status, section = excluded.section, rows = excluded.rows, error = excluded.error,
      checked_at = excluded.checked_at
  `);
  const saveListings = db.prepare(`
    INSERT INTO page_listings (iata, revid, rev_ts, rows_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(iata) DO UPDATE SET revid = excluded.revid, rev_ts = excluded.rev_ts,
      rows_json = excluded.rows_json, updated_at = excluded.updated_at
  `);
  const dropListings = db.prepare("DELETE FROM page_listings WHERE iata = ?");

  const changed = airports.filter((a) => {
    const rev = revisions.get(a.title);
    const prev = prevPage.get(a.iata) as { revid: number | null; status: string } | undefined;
    return opts.full || !rev || !prev || prev.revid !== rev.revid || prev.status === "error";
  });
  const cost = changed.length * 2;
  log(
    `  ${changed.length} changed or new, ${airports.length - changed.length} unchanged. ` +
      `About ${estimateMinutes(cost)} min${contact() ? "" : " (no FLIGHTMESH_CONTACT: slow tier)"}.`,
  );

  const now = () => new Date().toISOString();
  const changedSet = new Set(changed.map((a) => a.iata));
  for (const a of airports) {
    summary.checked++;
    const rev = revisions.get(a.title);
    if (!changedSet.has(a.iata)) {
      summary.unchanged++;
      db.prepare("UPDATE pages SET status = 'unchanged', checked_at = ? WHERE iata = ?").run(
        now(),
        a.iata,
      );
      continue;
    }
    const prevRows = (() => {
      const r = prevListings.get(a.iata) as { rows_json: string } | undefined;
      return r ? destinationCount(JSON.parse(r.rows_json) as ParsedRow[]) : 0;
    })();

    if (!rev) {
      savePage.run(a.iata, a.title, null, null, "missing", null, prevRows, "page not found", now());
      continue;
    }
    try {
      const sections = await fetchSections(a.iata, rev.revid);
      if (!sections.ok) throw new Error(`sections: ${sections.code}`);
      const section = pickDestinationsSection(sections.value);
      let rows: ParsedRow[] = [];
      if (section) {
        const html = await fetchSectionHtml(a.iata, rev.revid, section);
        if (!html.ok) throw new Error(`section ${section}: ${html.code}`);
        rows = parseDestinationTables(html.value);
      }
      summary.fetched++;
      const count = destinationCount(rows);
      if (guardTrips(prevRows, count) && !accept.has(a.iata)) {
        summary.guarded.push(a.iata);
        savePage.run(
          a.iata,
          rev.title,
          rev.revid,
          rev.timestamp,
          "guarded",
          section,
          prevRows,
          `guard: ${prevRows} → ${count} destinations; kept the previous listings (accept with --accept ${a.iata})`,
          now(),
        );
        continue;
      }
      tx(db, () => {
        if (count) saveListings.run(a.iata, rev.revid, rev.timestamp, JSON.stringify(rows), now());
        else dropListings.run(a.iata);
        savePage.run(
          a.iata,
          rev.title,
          rev.revid,
          rev.timestamp,
          section ? "ok" : "no_section",
          section,
          count,
          null,
          now(),
        );
      });
    } catch (err) {
      summary.failed++;
      const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
      // Keep the previous listings; record the failure so the next run retries the page.
      savePage.run(
        a.iata,
        a.title,
        prevPage.get(a.iata) ? (prevPage.get(a.iata) as { revid: number }).revid : null,
        null,
        "error",
        null,
        prevRows,
        `${String(err)}${cause}`,
        now(),
      );
    }
    if (summary.fetched % 100 === 0 && summary.fetched)
      log(`  fetched ${summary.fetched}/${changed.length} pages`);
  }
}

function baseLookups(db: DatabaseSync): Omit<Lookups, "redirects"> {
  const titleMap = (kind: string) =>
    new Map(
      (
        db.prepare("SELECT title, code FROM wiki_titles WHERE kind = ?").all(kind) as {
          title: string;
          code: string;
        }[]
      ).map((r) => [r.title, r.code]),
    );
  const airlineTitleByCode = new Map(
    (
      db
        .prepare(
          "SELECT iata, wikipedia_title FROM airlines WHERE iata IS NOT NULL AND wikipedia_title IS NOT NULL",
        )
        .all() as {
        iata: string;
        wikipedia_title: string;
      }[]
    ).map((r) => [r.iata, r.wikipedia_title]),
  );
  return {
    airlineByTitle: titleMap("airline"),
    airportByTitle: titleMap("airport"),
    aliases: loadCurated().aliases,
    airlineTitleByCode,
  };
}

function loadPages(db: DatabaseSync): PageInput[] {
  return (
    db.prepare("SELECT iata, rev_ts, rows_json FROM page_listings").all() as {
      iata: string;
      rev_ts: string;
      rows_json: string;
    }[]
  ).map((r) => ({ origin: r.iata, revTs: r.rev_ts, rows: JSON.parse(r.rows_json) as ParsedRow[] }));
}

function cachedRedirects(db: DatabaseSync): Map<string, string> {
  const cutoff = new Date(Date.now() - REDIRECT_TTL_MS).toISOString();
  return new Map(
    (
      db.prepare("SELECT source, target FROM wiki_redirects WHERE checked_at >= ?").all(cutoff) as {
        source: string;
        target: string;
      }[]
    ).map((r) => [r.source, r.target]),
  );
}

/** Redirect targets for titles, using the SQLite cache and fetching only stale or new ones. */
async function loadRedirects(
  db: DatabaseSync,
  titles: string[],
  log: Log,
): Promise<Map<string, string>> {
  const cached = cachedRedirects(db);
  const missing = titles.filter((t) => !cached.has(t));
  if (missing.length) {
    log(`  resolving ${missing.length} link titles through redirects…`);
    const resolved = await resolveRedirectTitles(missing);
    const now = new Date().toISOString();
    const save = db.prepare(`
      INSERT INTO wiki_redirects (source, target, checked_at) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET target = excluded.target, checked_at = excluded.checked_at
    `);
    tx(db, () => {
      for (const [source, target] of resolved) {
        save.run(source, target, now);
        cached.set(source, target);
      }
    });
  }
  return cached;
}

/** Turn every stored page's listings into directed routes and conflicts, and store them. */
export async function deriveRoutes(
  db: DatabaseSync,
  today: Date,
  log: Log,
): Promise<
  Pick<RouteIngestSummary, "routes" | "conflicts" | "unresolved" | "charter" | "defunct">
> {
  const pages = loadPages(db);
  const base = baseLookups(db);
  const needed = new Set(pages.flatMap((p) => titlesNeedingRedirects(p.rows, base)));
  const lookups: Lookups = { ...base, redirects: await loadRedirects(db, [...needed], log) };

  const airlineTitles = new Set<string>();
  for (const p of pages)
    for (const row of p.rows) {
      const ref = resolveAirline(row.airlineTitle, row.airlineText, lookups);
      if (ref.title) airlineTitles.add(ref.title);
    }
  const defunctTitles = await refreshAirlineStatus(db, [...airlineTitles], today, log);

  const ov = loadOverrides();
  const overrides: Overrides = {
    add: ov.add,
    remove: ov.remove,
    suspended: ov.suspended,
    movedAirports: ov.movedAirports,
    closedAirports: ov.closedAirports,
  };
  const moved = new Map(ov.movedAirports.map((m) => [m.from, m.to]));
  const countryOf = new Map(
    (
      db.prepare("SELECT iata, country FROM airports").all() as { iata: string; country: string }[]
    ).map((r) => [r.iata, r.country]),
  );

  const { evidence, unresolved, charter, defunct } = collectEvidence(pages, lookups, today, {
    defunctTitles,
    moved,
  });
  const usablePages = new Set(
    pages.filter((p) => destinationCount(p.rows) > 0).map((p) => moved.get(p.origin) ?? p.origin),
  );
  const { routes, conflicts } = resolveRoutes({
    evidence,
    usablePages,
    overrides,
    countryOf,
    today,
  });

  // Names for airlines that have no IATA code (kept on the map, never in a program).
  const names = new Map<string, string>();
  for (const e of evidence.values())
    if (!e.airline.iata) names.set(e.airline.key, e.airline.title ?? e.airline.key.slice(5));

  const now = new Date().toISOString();
  tx(db, () => {
    db.exec("UPDATE routes SET active = 0");
    const upsert = db.prepare(`
      INSERT INTO routes (origin, dest, airline, seasonal, basis, conflict, brand, active, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(origin, dest, airline) DO UPDATE SET seasonal = excluded.seasonal, basis = excluded.basis,
        conflict = excluded.conflict, brand = excluded.brand, active = 1, last_seen = excluded.last_seen
    `);
    for (const r of routes)
      upsert.run(
        r.origin,
        r.dest,
        r.airline,
        r.seasonal ? 1 : 0,
        r.basis,
        r.conflict,
        r.brand ? 1 : 0,
        now,
        now,
      );

    const airline = db.prepare(
      "INSERT INTO airlines (key, iata, icao, name, wikidata_id, wikipedia_title) VALUES (?, NULL, NULL, ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name",
    );
    for (const [key, name] of names)
      airline.run(key, name, key.startsWith("wiki:") ? key.slice(5) : null);

    db.exec("DELETE FROM conflicts");
    const conflict = db.prepare(`
      INSERT INTO conflicts (a, b, airline, a_status, a_date, a_note, a_rev_ts, b_status, b_date, b_note, b_rev_ts, verdict, rule)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of conflicts)
      conflict.run(
        c.a,
        c.b,
        c.airline,
        c.aSays.status,
        c.aSays.date,
        c.aSays.note,
        c.aSays.revTs,
        c.bSays.status,
        c.bSays.date,
        c.bSays.note,
        c.bSays.revTs,
        c.verdict,
        c.rule,
      );

    db.exec("DELETE FROM unresolved");
    const insert = db.prepare(
      "INSERT INTO unresolved (kind, title, text, count, example_page) VALUES (?, ?, ?, ?, ?)",
    );
    for (const u of aggregate(unresolved)) insert.run(u.kind, u.title, u.text, u.count, u.page);
  });

  return {
    routes: routes.length,
    conflicts: conflicts.length,
    unresolved: unresolved.length,
    charter,
    defunct,
  };
}

function aggregate(items: Unresolved[]): (Unresolved & { count: number })[] {
  const out = new Map<string, Unresolved & { count: number }>();
  for (const u of items) {
    const key = `${u.kind}|${u.title}|${u.text}`;
    const cur = out.get(key);
    if (cur) cur.count++;
    else out.set(key, { ...u, count: 1 });
  }
  return [...out.values()];
}
