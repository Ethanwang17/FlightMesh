import { decodeRoutes, type Snapshot } from "@flightmesh/shared";

/**
 * Publish checks: lightweight, and they only block on large, concentrated losses (the signature
 * of a scraping or mapping bug, not of real schedule changes). See docs/PLAN.md "Publish checks".
 * Each group fails only when BOTH the relative and the absolute loss are exceeded, so small
 * airports and airlines never block a publish.
 */
export const LIMITS = {
  global: { fail: 0.05, warn: 0.02 },
  airport: { minSize: 40, fail: [0.4, 20], warn: [0.2, 10] },
  airline: { minSize: 40, fail: [0.5, 25], warn: [0.25, 10] },
  country: { minSize: 100, fail: [0.25, 40], warn: [0.1, 20] },
  /** A group that doubles AND gains this many routes is probably a mis-mapped code. */
  suspiciousGain: 40,
} as const;

export interface Counts {
  routes: number;
  airports: number;
  byAirport: Map<string, number>;
  byAirline: Map<string, number>;
  byCountry: Map<string, number>;
}

export function countsOf(s: Snapshot): Counts {
  const countryOf = new Map(s.airports.code.map((c, i) => [c, s.airports.country[i]!]));
  const byAirport = new Map<string, number>();
  const byAirline = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of decodeRoutes(s)) {
    bump(byAirport, r.origin);
    if (r.dest !== r.origin) bump(byAirport, r.dest);
    bump(byAirline, r.airline);
    const a = countryOf.get(r.origin)!;
    const b = countryOf.get(r.dest)!;
    bump(byCountry, a);
    if (b !== a) bump(byCountry, b);
  }
  return { routes: s.routes.o.length, airports: byAirport.size, byAirport, byAirline, byCountry };
}

export interface CheckResult {
  failures: string[];
  warnings: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Compare a new build with the last published one. No previous build: everything passes. */
export function checkPublish(prev: Counts | null, next: Counts): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!prev) return { failures, warnings };

  for (const [label, a, b] of [
    ["directed routes", prev.routes, next.routes],
    ["airports with routes", prev.airports, next.airports],
  ] as const) {
    const change = a ? Math.abs(b - a) / a : 0;
    const msg = `${label}: ${a} → ${b} (${b >= a ? "+" : "−"}${pct(change)})`;
    if (change > LIMITS.global.fail) failures.push(msg);
    else if (change > LIMITS.global.warn) warnings.push(msg);
  }

  const groups = [
    ["airport", prev.byAirport, next.byAirport, LIMITS.airport],
    ["airline", prev.byAirline, next.byAirline, LIMITS.airline],
    ["country", prev.byCountry, next.byCountry, LIMITS.country],
  ] as const;
  for (const [kind, before, after, lim] of groups) {
    for (const [key, a] of before) {
      if (a < lim.minSize) continue;
      const b = after.get(key) ?? 0;
      const lost = a - b;
      if (lost <= 0) continue;
      const rel = lost / a;
      const msg = `${kind} ${key}: ${a} → ${b} routes (−${lost}, −${pct(rel)})`;
      if (rel > lim.fail[0] && lost > lim.fail[1]) failures.push(msg);
      else if (rel > lim.warn[0] && lost > lim.warn[1]) warnings.push(msg);
    }
    for (const [key, b] of after) {
      const a = before.get(key) ?? 0;
      const gained = b - a;
      if (gained > LIMITS.suspiciousGain && b >= 2 * a) {
        // A brand-new key with many routes is usually a code that started resolving (fine);
        // an existing one that doubles is more often a mis-mapped code.
        const msg = `${kind} ${key}: ${a} → ${b} routes (+${gained})`;
        if (a > 0) failures.push(`${msg}: doubled; check for a mis-mapped code`);
        else warnings.push(`${msg}: new`);
      }
    }
  }
  return { failures, warnings };
}

export interface Changes {
  added: string[];
  removed: string[];
}

/** Routes added and removed, as "AAA→BBB XX", busiest airports first. */
export function diffRoutes(prev: Snapshot | null, next: Snapshot): Changes {
  const key = (r: { origin: string; dest: string; airline: string }) =>
    `${r.origin}→${r.dest} ${r.airline}`;
  const before = new Set(prev ? decodeRoutes(prev).map(key) : []);
  const afterRoutes = decodeRoutes(next);
  const after = new Set(afterRoutes.map(key));
  const size = countsOf(next).byAirport;
  const weight = (k: string) => -(size.get(k.slice(0, 3)) ?? 0) - (size.get(k.slice(4, 7)) ?? 0);
  const sort = (xs: string[]) => xs.sort((x, y) => weight(x) - weight(y) || x.localeCompare(y));
  return {
    added: sort([...after].filter((k) => !before.has(k))),
    removed: sort([...before].filter((k) => !after.has(k))),
  };
}
