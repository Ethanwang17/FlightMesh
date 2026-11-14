import type { DatabaseSync } from "node:sqlite";
import { setMeta, tx } from "../db";
import { fetchTextCached } from "../http";
import { titleFromWikipediaUrl } from "../wiki";

const ENDPOINT = "https://query.wikidata.org/sparql";

/** Airports (instances of airport or a subclass) with an IATA code and an English article. */
const AIRPORTS_QUERY = `
SELECT DISTINCT ?item ?iata ?article WHERE {
  ?item wdt:P238 ?iata ; wdt:P31/wdt:P279* wd:Q1248784 .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
}`;

/**
 * ICAO codes of items with an IATA airport code. Kept separate: adding it to the query above
 * makes the query service time out.
 */
const AIRPORT_ICAO_QUERY = `SELECT ?item ?icao WHERE { ?item wdt:P238 ?iata ; wdt:P239 ?icao . }`;

/** Everything with an airline IATA code. Includes defunct airlines, filtered in code. */
const AIRLINES_QUERY = `
SELECT ?item ?itemLabel ?iata ?icao ?article ?dissolved ?sitelinks WHERE {
  ?item wdt:P229 ?iata .
  ?item wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?item wdt:P230 ?icao }
  OPTIONAL { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

type Binding = Record<string, { value: string } | undefined>;

interface SparqlResult {
  results: { bindings: Binding[] };
}

async function runQuery(query: string, cacheKey: string): Promise<Binding[]> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
  const text = await fetchTextCached(url, {
    cacheKey,
    headers: { Accept: "application/sparql-results+json" },
  });
  return (JSON.parse(text) as SparqlResult).results.bindings;
}

const qid = (uri: string | undefined) => uri?.split("/").pop() ?? null;

export interface WikidataAirport {
  qid: string;
  iata: string;
  icao: string | null;
  title: string;
}

/** Item QID → ICAO code. */
export function parseIcaoBindings(rows: Binding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const id = qid(r.item?.value);
    const icao = r.icao?.value.trim().toUpperCase();
    if (id && icao && /^[A-Z0-9]{4}$/.test(icao)) out.set(id, icao);
  }
  return out;
}

export function parseAirportBindings(
  rows: Binding[],
  icaoByQid: ReadonlyMap<string, string> = new Map(),
): WikidataAirport[] {
  const out: WikidataAirport[] = [];
  for (const r of rows) {
    const iata = r.iata?.value.trim().toUpperCase();
    const title = titleFromWikipediaUrl(r.article?.value);
    const id = qid(r.item?.value);
    if (!iata || !/^[A-Z]{3}$/.test(iata) || !title || !id) continue;
    const icao = icaoByQid.get(id) ?? null;
    out.push({ qid: id, iata, icao, title });
  }
  return out;
}

/** Civil airports often share their IATA code with an air base on the same field. */
const MILITARY = /\b(air (base|station|force)|joint base|naval|army|list of)\b/i;

export interface OurAirport {
  iata: string;
  icao: string | null;
  /** Title from OurAirports' wikipedia_link (often a redirect, now and then a disambiguation page). */
  title: string | null;
}

export interface AirportTitleChoice {
  /** The article each airport's page is read from. */
  pageTitle: Map<string, { title: string; qid: string | null }>;
  /** Every title that safely means this airport, for resolving destination links. */
  titles: Map<string, string>;
}

/**
 * Choose each airport's Wikipedia article and the titles that identify it.
 * - A Wikidata item is trusted for a code only if it isn't a military field and its ICAO code
 *   agrees with OurAirports when both have one (Wikidata now and then gives a small field another
 *   airport's code).
 * - Page: OurAirports' title if Wikidata agrees, else the Wikidata item with the same ICAO, else
 *   the only remaining Wikidata title, else OurAirports' title.
 * - A title claimed by two different airports is dropped from link resolution (ambiguous).
 */
export function chooseAirportTitles(
  ours: OurAirport[],
  wikidata: WikidataAirport[],
): AirportTitleChoice {
  const byCode = new Map<string, WikidataAirport[]>();
  for (const w of wikidata) {
    if (MILITARY.test(w.title)) continue;
    byCode.set(w.iata, [...(byCode.get(w.iata) ?? []), w]);
  }

  const pageTitle = new Map<string, { title: string; qid: string | null }>();
  const claims = new Map<string, Set<string>>();
  const claim = (title: string, code: string) =>
    claims.set(title, (claims.get(title) ?? new Set()).add(code));

  for (const a of ours) {
    const agreeing = (byCode.get(a.iata) ?? []).filter(
      (w) => !w.icao || !a.icao || w.icao === a.icao,
    );
    const sameIcao = agreeing.filter((w) => a.icao && w.icao === a.icao);
    const distinct = [...new Set(agreeing.map((w) => w.title))];
    const fromOurs = a.title ? agreeing.find((w) => w.title === a.title) : undefined;
    const chosen =
      fromOurs ??
      sameIcao[0] ??
      (distinct.length === 1 ? agreeing[0] : undefined) ??
      (a.title ? { title: a.title, qid: null } : undefined);
    if (chosen)
      pageTitle.set(a.iata, { title: chosen.title, qid: "qid" in chosen ? chosen.qid : null });
    if (a.title) claim(a.title, a.iata);
    for (const w of agreeing) claim(w.title, a.iata);
  }

  const titles = new Map<string, string>();
  for (const [title, codes] of claims) if (codes.size === 1) titles.set(title, [...codes][0]!);
  return { pageTitle, titles };
}

export interface WikidataAirline {
  qid: string;
  iata: string;
  icao: string | null;
  name: string;
  title: string | null;
  sitelinks: number;
}

/**
 * Collapse SPARQL rows (one per item × ICAO × dissolved combination) into one record per
 * item, dropping defunct airlines. IATA codes get reused once an airline folds, so defunct
 * carriers must not claim a code.
 */
export function parseAirlineBindings(rows: Binding[]): WikidataAirline[] {
  const byItem = new Map<string, WikidataAirline>();
  const dissolved = new Set<string>();

  for (const r of rows) {
    const id = qid(r.item?.value);
    const iata = r.iata?.value.trim().toUpperCase();
    if (!id || !iata || !/^[A-Z0-9]{2}$/.test(iata)) continue;
    if (r.dissolved?.value) {
      dissolved.add(id);
      continue;
    }
    if (byItem.has(id)) continue;
    const icao = r.icao?.value.trim().toUpperCase();
    byItem.set(id, {
      qid: id,
      iata,
      icao: icao && /^[A-Z]{3}$/.test(icao) ? icao : null,
      name: r.itemLabel?.value ?? id,
      title: titleFromWikipediaUrl(r.article?.value),
      sitelinks: Number(r.sitelinks?.value ?? 0),
    });
  }

  return [...byItem.values()].filter((a) => !dissolved.has(a.qid));
}

/** English article titles of airlines Wikidata records as dissolved. */
export function dissolvedAirlineTitles(rows: Binding[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const title = titleFromWikipediaUrl(r.article?.value);
    if (r.dissolved?.value && title) out.add(title);
  }
  return out;
}

/**
 * Pick the canonical airline for each IATA code: the active item with the most sitelinks.
 * Subsidiaries that fly under a parent's code (e.g. regional brands) lose to the parent.
 */
export function pickCanonicalAirlines(airlines: WikidataAirline[]): Map<string, WikidataAirline> {
  const best = new Map<string, WikidataAirline>();
  for (const a of airlines) {
    const cur = best.get(a.iata);
    if (!cur || a.sitelinks > cur.sitelinks) best.set(a.iata, a);
  }
  return best;
}

export async function ingestWikidata(
  db: DatabaseSync,
): Promise<{ airports: number; airlines: number; airlineTitles: number; dissolved: number }> {
  const icaoByQid = parseIcaoBindings(
    await runQuery(AIRPORT_ICAO_QUERY, "wikidata-airport-icao.json"),
  );
  const airportRows = parseAirportBindings(
    await runQuery(AIRPORTS_QUERY, "wikidata-airports.json"),
    icaoByQid,
  );
  const airlineBindings = await runQuery(AIRLINES_QUERY, "wikidata-airlines.json");
  const airlineRows = parseAirlineBindings(airlineBindings);
  const canonical = pickCanonicalAirlines(airlineRows);

  const ours = db
    .prepare("SELECT iata, icao, wikipedia_title AS title FROM airports")
    .all() as unknown as OurAirport[];
  const choice = chooseAirportTitles(ours, airportRows);

  const setPage = db.prepare(
    "UPDATE airports SET wikipedia_title = ?, wikidata_id = ? WHERE iata = ?",
  );
  const airportTitle = db.prepare(`
    INSERT INTO wiki_titles (kind, title, code) VALUES ('airport', ?, ?)
    ON CONFLICT(kind, title) DO UPDATE SET code = excluded.code
  `);
  const airline = db.prepare(`
    INSERT INTO airlines (key, iata, icao, name, wikidata_id, wikipedia_title) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET icao = excluded.icao, name = excluded.name,
      wikidata_id = excluded.wikidata_id, wikipedia_title = excluded.wikipedia_title
  `);
  const airlineTitle = db.prepare(`
    INSERT INTO wiki_titles (kind, title, code) VALUES ('airline', ?, ?)
    ON CONFLICT(kind, title) DO UPDATE SET code = excluded.code
  `);
  const dissolved = db.prepare(`
    INSERT INTO airline_status (title, source, revid, defunct, ceased, checked_at)
    VALUES (?, 'wikidata', NULL, 1, NULL, ?)
    ON CONFLICT(title, source) DO UPDATE SET checked_at = excluded.checked_at
  `);

  const now = new Date().toISOString();
  const activeTitles = new Set(airlineRows.map((a) => a.title).filter(Boolean));
  const gone = [...dissolvedAirlineTitles(airlineBindings)].filter((t) => !activeTitles.has(t));
  let airlineTitles = 0;
  tx(db, () => {
    db.exec("DELETE FROM wiki_titles WHERE kind = 'airport'");
    for (const [iata, page] of choice.pageTitle) setPage.run(page.title, page.qid, iata);
    for (const [title, code] of choice.titles) airportTitle.run(title, code);
    for (const a of canonical.values()) airline.run(a.iata, a.iata, a.icao, a.name, a.qid, a.title);
    // Every active item's article resolves to its code, so subsidiary brands map to the
    // code they fly under.
    for (const a of airlineRows) {
      if (!a.title) continue;
      airlineTitle.run(a.title, a.iata);
      airlineTitles++;
    }
    db.exec("DELETE FROM airline_status WHERE source = 'wikidata'");
    for (const t of gone) dissolved.run(t, now);
  });

  setMeta(db, "wikidata_ingested_at", now);
  return {
    airports: choice.titles.size,
    airlines: canonical.size,
    airlineTitles,
    dissolved: gone.length,
  };
}
