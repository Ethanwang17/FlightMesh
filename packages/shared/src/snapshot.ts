import type { AllianceId, Alliance, Currency, Program } from "./types";

/** Bits in `routes.flags`. */
export const RouteFlag = {
  /** Flown only part of the year. */
  Seasonal: 1,
  /** Listed under a brand or subsidiary (e.g. American Eagle), not the airline's own name. */
  Brand: 2,
  /** Known only from the other airport's page; that airport's own page has no usable table. */
  ReverseOnly: 4,
  /** The two airports' pages disagreed; a rule settled it (see the pipeline's conflicts report). */
  Conflict: 8,
  /** Added by a curated override. */
  Override: 16,
} as const;

/**
 * The data file the web app loads. Columnar (one array per field) to keep it small.
 * Routes are **directed**: `o[i] → d[i]` on airline `al[i]`. A route flown both ways appears twice.
 *
 * Derived from Wikipedia (CC BY-SA 4.0), Wikidata (CC0) and OurAirports (public domain).
 */
export interface Snapshot {
  version: 1;
  generatedAt: string;
  license: string;
  attribution: string[];
  airports: {
    code: string[];
    name: string[];
    city: string[];
    country: string[];
    lat: number[];
    lon: number[];
  };
  airlines: {
    /** IATA code, or `wiki:<Title>` / `name:<text>` for airlines without one. */
    key: string[];
    iata: (string | null)[];
    name: string[];
    alliance: (AllianceId | null)[];
  };
  routes: {
    /** Index into airports. */
    o: number[];
    d: number[];
    /** Index into airlines. */
    al: number[];
    flags: number[];
  };
  alliances: Alliance[];
  programs: Program[];
  currencies: Currency[];
}

export interface DecodedRoute {
  origin: string;
  dest: string;
  airline: string;
  flags: number;
}

/** Expand the columnar routes into objects (handy for tests and small tools). */
export function decodeRoutes(s: Snapshot): DecodedRoute[] {
  return s.routes.o.map((o, i) => ({
    origin: s.airports.code[o]!,
    dest: s.airports.code[s.routes.d[i]!]!,
    airline: s.airlines.key[s.routes.al[i]!]!,
    flags: s.routes.flags[i]!,
  }));
}
