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
  wikipediaTitle: string | null;
}

/**
 * Keep airports that have an IATA code and scheduled service, one row per IATA code.
 * Pure function so it can be tested without the network.
 */
export function selectAirports(csv: string): AirportRecord[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as OurAirportsRow[];
  const byIata = new Map<string, AirportRecord>();

  for (const r of rows) {
    const iata = r.iata_code?.trim().toUpperCase();
    if (!iata || !/^[A-Z]{3}$/.test(iata)) continue;
    if (r.scheduled_service !== "yes") continue;
    const rank = TYPE_RANK[r.type];
    if (rank === undefined) continue; // heliports, closed, balloonports

    const lat = Number(r.latitude_deg);
    const lon = Number(r.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const record: AirportRecord = {
      iata,
      icao: r.icao_code?.trim() || null,
      name: r.name.trim(),
      city: r.municipality?.trim() ?? "",
      country: r.iso_country.trim(),
      lat,
      lon,
      type: r.type,
      wikipediaTitle: titleFromWikipediaUrl(r.wikipedia_link),
    };

    const existing = byIata.get(iata);
    if (!existing || rank > (TYPE_RANK[existing.type] ?? 0)) byIata.set(iata, record);
  }

  return [...byIata.values()].sort((a, b) => a.iata.localeCompare(b.iata));
}

export async function ingestAirports(db: DatabaseSync): Promise<number> {
  const csv = await fetchTextCached(AIRPORTS_URL, { cacheKey: "ourairports-airports.csv" });
  const airports = selectAirports(csv);

  const upsert = db.prepare(`
    INSERT INTO airports (iata, icao, name, city, country, lat, lon, type, wikipedia_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(iata) DO UPDATE SET
      icao = excluded.icao, name = excluded.name, city = excluded.city,
      country = excluded.country, lat = excluded.lat, lon = excluded.lon,
      type = excluded.type, wikipedia_title = excluded.wikipedia_title
  `);
  const title = db.prepare(`
    INSERT INTO wiki_titles (kind, title, code) VALUES ('airport', ?, ?)
    ON CONFLICT(kind, title) DO UPDATE SET code = excluded.code
  `);

  tx(db, () => {
    for (const a of airports) {
      upsert.run(a.iata, a.icao, a.name, a.city, a.country, a.lat, a.lon, a.type, a.wikipediaTitle);
      if (a.wikipediaTitle) title.run(a.wikipediaTitle, a.iata);
    }
  });
  setMeta(db, "airports_ingested_at", new Date().toISOString());
  return airports.length;
}
