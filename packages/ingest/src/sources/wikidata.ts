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
  title: string;
}

export function parseAirportBindings(rows: Binding[]): WikidataAirport[] {
  const out: WikidataAirport[] = [];
  for (const r of rows) {
    const iata = r.iata?.value.trim().toUpperCase();
    const title = titleFromWikipediaUrl(r.article?.value);
    const id = qid(r.item?.value);
    if (!iata || !/^[A-Z]{3}$/.test(iata) || !title || !id) continue;
    out.push({ qid: id, iata, title });
  }
  return out;
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
): Promise<{ airports: number; airlines: number; airlineTitles: number }> {
  const airportRows = parseAirportBindings(
    await runQuery(AIRPORTS_QUERY, "wikidata-airports.json"),
  );
  const airlineRows = parseAirlineBindings(
    await runQuery(AIRLINES_QUERY, "wikidata-airlines.json"),
  );
  const canonical = pickCanonicalAirlines(airlineRows);

  const knownAirports = new Set(
    (db.prepare("SELECT iata FROM airports").all() as { iata: string }[]).map((r) => r.iata),
  );

  // Titles from OurAirports take precedence; Wikidata only fills gaps.
  const airportTitle = db.prepare(
    "INSERT OR IGNORE INTO wiki_titles (kind, title, code) VALUES ('airport', ?, ?)",
  );
  const airportQid = db.prepare(
    "UPDATE airports SET wikidata_id = ? WHERE iata = ? AND (wikipedia_title = ? OR wikipedia_title IS NULL)",
  );
  const fillAirportTitle = db.prepare(
    "UPDATE airports SET wikipedia_title = ? WHERE iata = ? AND wikipedia_title IS NULL",
  );
  const airline = db.prepare(`
    INSERT INTO airlines (iata, icao, name, wikidata_id, wikipedia_title) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(iata) DO UPDATE SET icao = excluded.icao, name = excluded.name,
      wikidata_id = excluded.wikidata_id, wikipedia_title = excluded.wikipedia_title
  `);
  const airlineTitle = db.prepare(`
    INSERT INTO wiki_titles (kind, title, code) VALUES ('airline', ?, ?)
    ON CONFLICT(kind, title) DO UPDATE SET code = excluded.code
  `);

  let airports = 0;
  let airlineTitles = 0;
  tx(db, () => {
    for (const a of airportRows) {
      if (!knownAirports.has(a.iata)) continue;
      airportTitle.run(a.title, a.iata);
      airportQid.run(a.qid, a.iata, a.title);
      fillAirportTitle.run(a.title, a.iata);
      airports++;
    }
    for (const a of canonical.values()) {
      airline.run(a.iata, a.icao, a.name, a.qid, a.title);
    }
    // Every active item's article resolves to its code, so subsidiary brands map to the
    // code they fly under.
    for (const a of airlineRows) {
      if (!a.title) continue;
      airlineTitle.run(a.title, a.iata);
      airlineTitles++;
    }
  });

  setMeta(db, "wikidata_ingested_at", new Date().toISOString());
  return { airports, airlines: canonical.size, airlineTitles };
}
