import { haversineKm } from "./geo";
import { bookableAirlines, isBookable, type Bookability } from "./programs";
import { RouteFlag, type Snapshot } from "./snapshot";
import type { AllianceId, CurrencyId, ProgramId } from "./types";

/**
 * Filter selections. OR within a dimension, AND across dimensions. Empty = no restriction.
 * `airlines` holds airline keys (IATA code, or `wiki:<Title>` for airlines without one).
 */
export interface NetworkFilters {
  currencies: CurrencyId[];
  programs: ProgramId[];
  alliances: AllianceId[];
  airlines: string[];
}

export const NO_FILTERS: NetworkFilters = {
  currencies: [],
  programs: [],
  alliances: [],
  airlines: [],
};

export const hasFilters = (f: NetworkFilters) =>
  f.currencies.length + f.programs.length + f.alliances.length + f.airlines.length > 0;

/** Lookups built once per snapshot. */
export interface NetworkIndex {
  snapshot: Snapshot;
  airportIndex: Map<string, number>;
  /** Directed routes leaving each airport (route indices). */
  out: number[][];
  bookability: Map<ProgramId, Bookability>;
}

export function buildIndex(snapshot: Snapshot): NetworkIndex {
  const airportIndex = new Map(snapshot.airports.code.map((c, i) => [c, i]));
  const out: number[][] = snapshot.airports.code.map(() => []);
  snapshot.routes.o.forEach((o, i) => out[o]!.push(i));
  const alliances = new Map(snapshot.alliances.map((a) => [a.id, a]));
  const bookability = new Map(snapshot.programs.map((p) => [p.id, bookableAirlines(p, alliances)]));
  return { snapshot, airportIndex, out, bookability };
}

/** Programs reachable from the selected bank currencies. */
export function programsForCurrencies(s: Snapshot, currencies: CurrencyId[]): ProgramId[] {
  const ids = new Set<ProgramId>();
  for (const c of s.currencies)
    if (currencies.includes(c.id)) for (const p of c.partners) ids.add(p.program);
  return [...ids];
}

/** Programs (among `programs`) under which route `i` is potentially bookable. */
export function programsCovering(idx: NetworkIndex, i: number, programs: ProgramId[]): ProgramId[] {
  const s = idx.snapshot;
  const iata = s.airlines.iata[s.routes.al[i]!];
  if (!iata) return [];
  const viaBrand = (s.routes.flags[i]! & RouteFlag.Brand) !== 0;
  return programs.filter((p) => {
    const b = idx.bookability.get(p);
    return !!b && isBookable(b, iata, viaBrand);
  });
}

/** A predicate over route indices for the given filters. */
export function routeFilter(idx: NetworkIndex, f: NetworkFilters): (i: number) => boolean {
  if (!hasFilters(f)) return () => true;
  const s = idx.snapshot;
  const viaCurrency = f.currencies.length ? programsForCurrencies(s, f.currencies) : null;
  const alliances = new Set(f.alliances);
  const airlines = new Set(f.airlines);
  return (i) => {
    const al = s.routes.al[i]!;
    if (airlines.size && !airlines.has(s.airlines.key[al]!)) return false;
    if (alliances.size && !alliances.has(s.airlines.alliance[al] as AllianceId)) return false;
    if (f.programs.length && !programsCovering(idx, i, f.programs).length) return false;
    if (viaCurrency && !programsCovering(idx, i, viaCurrency).length) return false;
    return true;
  };
}

/** Programs to report coverage for: the selected ones, or all reachable from selected currencies. */
export function programsInPlay(s: Snapshot, f: NetworkFilters): ProgramId[] {
  if (f.programs.length) return f.programs;
  if (f.currencies.length) return programsForCurrencies(s, f.currencies);
  return [];
}

export interface Destination {
  dest: number;
  /** Route indices, one per airline. */
  routes: number[];
  km: number;
  /** Every airline on it flies only seasonally. */
  seasonal: boolean;
  /** The reverse direction (dest → origin) also exists in the data for at least one airline. */
  returns: boolean;
}

export function distanceKm(s: Snapshot, a: number, b: number): number {
  return haversineKm(
    s.airports.lat[a]!,
    s.airports.lon[a]!,
    s.airports.lat[b]!,
    s.airports.lon[b]!,
  );
}

/** Nonstop destinations from an airport that pass the filter, nearest first. */
export function destinationsFrom(
  idx: NetworkIndex,
  origin: number,
  pass: (i: number) => boolean,
): Destination[] {
  const s = idx.snapshot;
  const byDest = new Map<number, number[]>();
  for (const i of idx.out[origin] ?? []) {
    if (!pass(i)) continue;
    const d = s.routes.d[i]!;
    byDest.set(d, [...(byDest.get(d) ?? []), i]);
  }
  return [...byDest]
    .map(([dest, routes]) => ({
      dest,
      routes,
      km: distanceKm(s, origin, dest),
      seasonal: routes.every((i) => (s.routes.flags[i]! & RouteFlag.Seasonal) !== 0),
      returns: (idx.out[dest] ?? []).some((j) => s.routes.d[j] === origin),
    }))
    .sort((a, b) => a.km - b.km);
}

/** Number of filtered destinations per airport (for sizing and dimming dots). */
export function destinationCounts(idx: NetworkIndex, pass: (i: number) => boolean): Uint16Array {
  const s = idx.snapshot;
  const counts = new Uint16Array(s.airports.code.length);
  for (let a = 0; a < idx.out.length; a++) {
    const seen = new Set<number>();
    for (const i of idx.out[a]!) if (pass(i)) seen.add(s.routes.d[i]!);
    counts[a] = seen.size;
  }
  return counts;
}

export interface Itinerary {
  /** Airports along the way: [origin, dest] nonstop or [origin, hub, dest]. */
  stops: number[];
  /** Route indices per leg (each leg may have several airlines). */
  legs: number[][];
  km: number;
  /** Total distance divided by the direct distance. */
  detour: number;
  /** Programs (in play) that cover every leg with at least one airline. */
  programs: ProgramId[];
}

export interface RoutingResult {
  nonstop: Itinerary | null;
  oneStop: Itinerary[];
  /** One-stop options hidden for exceeding the detour limit. */
  hidden: number;
}

/**
 * Nonstop and one-stop itineraries from `from` to `to` over **directed** routes only:
 * a leg A→B needs a route listed A→B; B→A is never used in its place.
 */
export function findItineraries(
  idx: NetworkIndex,
  from: number,
  to: number,
  pass: (i: number) => boolean,
  opts: { maxDetour?: number; programs?: ProgramId[] } = {},
): RoutingResult {
  const s = idx.snapshot;
  const maxDetour = opts.maxDetour ?? 1.5;
  const programs = opts.programs ?? [];
  const direct = Math.max(distanceKm(s, from, to), 1);

  const coverage = (legs: number[][]) =>
    programs.filter((p) =>
      legs.every((leg) => leg.some((i) => programsCovering(idx, i, [p]).length)),
    );

  const legTo = (a: number, b: number) =>
    (idx.out[a] ?? []).filter((i) => s.routes.d[i] === b && pass(i));

  const nonstopLegs = legTo(from, to);
  const nonstop = nonstopLegs.length
    ? {
        stops: [from, to],
        legs: [nonstopLegs],
        km: direct,
        detour: 1,
        programs: coverage([nonstopLegs]),
      }
    : null;

  const firstLegs = new Map<number, number[]>();
  for (const i of idx.out[from] ?? []) {
    const hub = s.routes.d[i]!;
    if (hub === to || hub === from || !pass(i)) continue;
    firstLegs.set(hub, [...(firstLegs.get(hub) ?? []), i]);
  }

  const oneStop: Itinerary[] = [];
  let hidden = 0;
  for (const [hub, leg1] of firstLegs) {
    const leg2 = legTo(hub, to);
    if (!leg2.length) continue;
    const km = distanceKm(s, from, hub) + distanceKm(s, hub, to);
    const detour = km / direct;
    if (detour > maxDetour) {
      hidden++;
      continue;
    }
    const legs = [leg1, leg2];
    const covered = coverage(legs);
    // With programs in play, an option only counts if one program covers both legs.
    if (programs.length && !covered.length) continue;
    oneStop.push({ stops: [from, hub, to], legs, km, detour, programs: covered });
  }
  oneStop.sort((a, b) => a.km - b.km);
  return { nonstop, oneStop, hidden };
}
