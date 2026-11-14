import { parse } from "csv-parse/sync";
import type { DatabaseSync } from "node:sqlite";
import { setMeta, tx } from "../db";
import { fetchTextCached } from "../http";
import { titleFromWikipediaUrl } from "../wiki";

const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

/** Higher rank wins when two rows share an IATA code. */
const TYPE_RANK: Record<string, number> = {
  large_airport: 4,
  medium_airport: 3,
  small_airport: 2,
  seaplane_base: 1,
};

interface OurAirportsRow {
  ident: string;
  type: string;
  name: string;
  latitude_deg: string;
  longitude_deg: string;
  iso_country: string;
  municipality: string;
  scheduled_service: string;
  icao_code: string;
  gps_code: string;
  iata_code: string;
  wikipedia_link: string;
}

export interface AirportRecord {
  iata: string;
  icao: string | null;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: string;
  /** OurAirports' scheduled_service flag. Crowd-maintained, so used to pick pages to fetch, not as truth. */
  scheduled: boolean;
  wikipediaTitle: string | null;
}

/**
 * Keep every open airport with an IATA code, one row per code (scheduled service first, then the
 * larger type). Airports flagged without scheduled service are kept so that route listings
 * pointing at them still resolve when the flag is wrong.
 * Pure function so it can be tested without the network.
 */
export function selectAirports(csv: string): AirportRecord[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as OurAirportsRow[];
  const byIata = new Map<string, AirportRecord>();

  for (const r of rows) {
    const iata = r.iata_code?.trim().toUpperCase();
    if (!iata || !/^[A-Z]{3}$/.test(iata)) continue;
    const rank = TYPE_RANK[r.type];
    if (rank === undefined) continue; // heliports, closed, balloonports

    const lat = Number(r.latitude_deg);
    const lon = Number(r.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const record: AirportRecord = {
      iata,
      icao: icaoOf(r),
      name: r.name.trim(),
      city: r.municipality?.trim() ?? "",
      country: r.iso_country.trim(),
      lat,
      lon,
      type: r.type,
      scheduled: r.scheduled_service === "yes",
      wikipediaTitle: titleFromWikipediaUrl(r.wikipedia_link),
    };

    const existing = byIata.get(iata);
    const score = (a: AirportRecord) => (a.scheduled ? 10 : 0) + (TYPE_RANK[a.type] ?? 0);
    if (!existing || score(record) > score(existing)) byIata.set(iata, record);
  }

  return [...byIata.values()].sort((a, b) => a.iata.localeCompare(b.iata));
}

/** ICAO code from the icao_code column, else a 4-letter GPS code (often the same thing). */
function icaoOf(r: OurAirportsRow): string | null {
  const icao = r.icao_code?.trim().toUpperCase();
  if (icao) return icao;
  const gps = r.gps_code?.trim().toUpperCase();
  return gps && /^[A-Z]{4}$/.test(gps) ? gps : null;
}

export async function ingestAirports(db: DatabaseSync): Promise<number> {
  const csv = await fetchTextCached(AIRPORTS_URL, { cacheKey: "ourairports-airports.csv" });
  const airports = selectAirports(csv);

  const upsert = db.prepare(`
    INSERT INTO airports (iata, icao, name, city, country, lat, lon, type, scheduled, wikipedia_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(iata) DO UPDATE SET
      icao = excluded.icao, name = excluded.name, city = excluded.city,
      country = excluded.country, lat = excluded.lat, lon = excluded.lon,
      type = excluded.type, scheduled = excluded.scheduled, wikipedia_title = excluded.wikipedia_title
  `);
  const title = db.prepare(`
    INSERT INTO wiki_titles (kind, title, code) VALUES ('airport', ?, ?)
    ON CONFLICT(kind, title) DO UPDATE SET code = excluded.code
  `);

  tx(db, () => {
    for (const a of airports) {
      upsert.run(
        a.iata,
        a.icao,
        a.name,
        a.city,
        a.country,
        a.lat,
        a.lon,
        a.type,
        a.scheduled ? 1 : 0,
        a.wikipediaTitle,
      );
      if (a.wikipediaTitle) title.run(a.wikipediaTitle, a.iata);
    }
  });
  setMeta(db, "airports_ingested_at", new Date().toISOString());
  return airports.length;
}
