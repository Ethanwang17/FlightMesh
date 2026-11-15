import { classifyNote, NEGATIVE, NOT_YET, type ListingStatus } from "./dates";
import type { Mode, ParsedRow } from "./parse";

// ---------------------------------------------------------------------------------------------
// Lookups

export interface Lookups {
  airlineByTitle: ReadonlyMap<string, string>;
  airportByTitle: ReadonlyMap<string, string>;
  /** Redirect source title → target title. */
  redirects: ReadonlyMap<string, string>;
  /** Curated airline aliases (brand/subsidiary → marketing code), matched on title or text. */
  aliases: Readonly<Record<string, string>>;
  /** IATA code → the airline's own article title, to tell a brand listing from the mainline. */
  airlineTitleByCode?: ReadonlyMap<string, string>;
}

export interface AirlineRef {
  /** IATA code when known, else `wiki:<Title>` or `name:<text>`. */
  key: string;
  iata: string | null;
  /** Canonical article title, when the listing links one. */
  title: string | null;
  /** Listed under a brand or subsidiary rather than the airline's own article. */
  brand: boolean;
}

const target = (title: string, l: Lookups) => l.redirects.get(title) ?? title;

export function resolveAirline(rawTitle: string | null, text: string, l: Lookups): AirlineRef {
  // Some tables link a generic list ("List of airlines of Iran"), not the airline: use the text.
  const isList = (t: string) => /^List of /i.test(t);
  const title = rawTitle && !isList(rawTitle) && !isList(target(rawTitle, l)) ? rawTitle : null;
  if (title) {
    const t = target(title, l);
    const alias = l.aliases[title] ?? l.aliases[t];
    if (alias) return { key: alias, iata: alias, title: t, brand: true };
    const code = l.airlineByTitle.get(title) ?? l.airlineByTitle.get(t);
    if (code) {
      const own = l.airlineTitleByCode?.get(code);
      return { key: code, iata: code, title: t, brand: own !== undefined && own !== t };
    }
    const textAlias = l.aliases[text];
    if (textAlias) return { key: textAlias, iata: textAlias, title: t, brand: true };
    return { key: `wiki:${t}`, iata: null, title: t, brand: false };
  }
  const alias = l.aliases[text];
  if (alias) return { key: alias, iata: alias, title: null, brand: true };
  return { key: `name:${text}`, iata: null, title: null, brand: false };
}

export function resolveAirport(title: string, l: Lookups): string | null {
  return l.airportByTitle.get(title) ?? l.airportByTitle.get(target(title, l)) ?? null;
}

/** Titles that aren't directly known and need a redirect lookup. */
export function titlesNeedingRedirects(rows: ParsedRow[], l: Omit<Lookups, "redirects">): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (
      row.airlineTitle &&
      !l.aliases[row.airlineTitle] &&
      !l.airlineByTitle.has(row.airlineTitle)
    ) {
      out.add(row.airlineTitle);
    }
    for (const d of row.destinations) if (!l.airportByTitle.has(d.title)) out.add(d.title);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Evidence: what each airport's own page says about its departures

export interface PageInput {
  /** Airport the page is about (its departures). */
  origin: string;
  /** Timestamp of the page revision the rows come from. */
  revTs: string;
  rows: ParsedRow[];
}

export interface Evidence {
  status: ListingStatus;
  date: string | null;
  note: string;
  seasonal: boolean;
  revTs: string;
  airline: AirlineRef;
}

const RANK: Record<ListingStatus, number> = {
  current: 0,
  via: 1,
  resuming: 2,
  future: 3,
  suspended: 4,
  ended: 5,
};

const isCharter = (m: Mode) => m === "charter" || m === "seasonal_charter";

export interface Overrides {
  add: { origin: string; dest: string; airline: string; seasonal?: boolean; bothWays?: boolean }[];
  remove: { origin: string; dest: string; airline?: string; bothWays?: boolean }[];
  suspended: { airline: string; airport?: string; country?: string; until?: string }[];
  movedAirports: { from: string; to: string }[];
  closedAirports: { iata: string; until?: string }[];
}

export const NO_OVERRIDES: Overrides = {
  add: [],
  remove: [],
  suspended: [],
  movedAirports: [],
  closedAirports: [],
};

export interface Unresolved {
  kind: "airline" | "airport";
  title: string;
  text: string;
  page: string;
}

/** Collect evidence keyed `origin|dest|airlineKey`, best listing per key. */
export function collectEvidence(
  pages: PageInput[],
  l: Lookups,
  today: Date,
  opts: { defunctTitles?: ReadonlySet<string>; moved?: ReadonlyMap<string, string> } = {},
): { evidence: Map<string, Evidence>; unresolved: Unresolved[]; charter: number; defunct: number } {
  const evidence = new Map<string, Evidence>();
  const unresolved: Unresolved[] = [];
  const moved = opts.moved ?? new Map<string, string>();
  let charter = 0;
  let defunct = 0;

  for (const page of pages) {
    const origin = moved.get(page.origin) ?? page.origin;
    for (const row of page.rows) {
      const airline = resolveAirline(row.airlineTitle, row.airlineText, l);
      if (airline.title && opts.defunctTitles?.has(airline.title)) {
        defunct += row.destinations.length;
        continue;
      }
      if (!airline.iata) {
        unresolved.push({
          kind: "airline",
          title: row.airlineTitle ?? "",
          text: row.airlineText,
          page: page.origin,
        });
      }
      for (const d of row.destinations) {
        if (isCharter(d.mode)) {
          charter++;
          continue;
        }
        const raw = resolveAirport(d.title, l);
        if (!raw) {
          unresolved.push({ kind: "airport", title: d.title, text: d.text, page: page.origin });
          continue;
        }
        const dest = moved.get(raw) ?? raw;
        if (dest === origin) continue;
        const { status, date } = classifyNote(d.note, d.mode, today);
        const key = `${origin}|${dest}|${airline.key}`;
        const prev = evidence.get(key);
        const next: Evidence = {
          status,
          date,
          note: d.note,
          seasonal: d.seasonal,
          revTs: page.revTs,
          airline,
        };
        if (!prev || RANK[status] < RANK[prev.status]) {
          evidence.set(key, next);
        } else if (prev.status === "current" && status === "current" && !d.seasonal) {
          prev.seasonal = false; // listed year-round as well as seasonally
        }
      }
    }
  }
  return { evidence, unresolved, charter, defunct };
}

// ---------------------------------------------------------------------------------------------
// Resolution: directed routes and conflicts

export type Basis = "own_page" | "reverse_only" | "resolved" | "override";

export interface DirectedRoute {
  origin: string;
  dest: string;
  airline: string;
  seasonal: boolean;
  basis: Basis;
  /** Set when the two pages disagreed: the rule that decided it. */
  conflict: ConflictRule | null;
  brand: boolean;
}

export type ConflictRule = "dated-other-side" | "later-date" | "fresher-page" | "unresolved";

export interface Side {
  status: ListingStatus;
  date: string | null;
  note: string;
  revTs: string;
}

export interface Conflict {
  a: string;
  b: string;
  airline: string;
  aSays: Side;
  bSays: Side;
  verdict: "active" | "inactive";
  rule: ConflictRule;
}

/** Freshness only decides when one page revision is at least this much newer. */
const FRESHNESS_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

const side = (e: Evidence): Side => ({
  status: e.status,
  date: e.date,
  note: e.note,
  revTs: e.revTs,
});

/**
 * Decide a contradiction between a page listing the route as current (`pos`) and the other end's
 * page saying it's suspended, ended, or not started (`neg`). See docs/PLAN.md "Conflict resolution".
 */
export function decideConflict(
  pos: Evidence,
  neg: Evidence,
): { verdict: "active" | "inactive"; rule: ConflictRule } {
  if (neg.date && !pos.date) return { verdict: "inactive", rule: "dated-other-side" };
  if (pos.date && !neg.date) return { verdict: "active", rule: "dated-other-side" };
  if (pos.date && neg.date) {
    return { verdict: neg.date > pos.date ? "inactive" : "active", rule: "later-date" };
  }
  const diff = Date.parse(neg.revTs) - Date.parse(pos.revTs);
  if (diff > FRESHNESS_MARGIN_MS) return { verdict: "inactive", rule: "fresher-page" };
  if (diff < -FRESHNESS_MARGIN_MS) return { verdict: "active", rule: "fresher-page" };
  // Too close to call: keep it (a doubtful route is cheaper than a hidden real one) and flag it.
  return { verdict: "active", rule: "unresolved" };
}

export interface ResolveInput {
  evidence: ReadonlyMap<string, Evidence>;
  /** Airports whose own page produced usable listings this run. */
  usablePages: ReadonlySet<string>;
  overrides?: Overrides;
  /** IATA → ISO country, for country-wide suspension overrides. */
  countryOf?: ReadonlyMap<string, string>;
  today: Date;
}

export function resolveRoutes(input: ResolveInput): {
  routes: DirectedRoute[];
  conflicts: Conflict[];
} {
  const { evidence, usablePages, today } = input;
  const ov = input.overrides ?? NO_OVERRIDES;
  const routes: DirectedRoute[] = [];
  const conflicts: Conflict[] = [];
  const done = new Set<string>();

  const route = (
    origin: string,
    dest: string,
    e: Evidence,
    basis: Basis,
    conflict: ConflictRule | null,
  ) =>
    routes.push({
      origin,
      dest,
      airline: e.airline.key,
      seasonal: e.seasonal,
      basis,
      conflict,
      brand: e.airline.brand,
    });

  for (const key of evidence.keys()) {
    const [o, d, airline] = key.split("|") as [string, string, string];
    const pairKey = o < d ? `${o}|${d}|${airline}` : `${d}|${o}|${airline}`;
    if (done.has(pairKey)) continue;
    done.add(pairKey);

    const [a, b] = o < d ? [o, d] : [d, o];
    const ea = evidence.get(`${a}|${b}|${airline}`); // a's page about a → b
    const eb = evidence.get(`${b}|${a}|${airline}`); // b's page about b → a

    const pos = (e?: Evidence) => e?.status === "current";
    const neg = (e?: Evidence) => !!e && (NEGATIVE.has(e.status) || NOT_YET.has(e.status));

    if ((pos(ea) && neg(eb)) || (pos(eb) && neg(ea))) {
      const [p, n] = pos(ea) ? [ea!, eb!] : [eb!, ea!];
      const { verdict, rule } = decideConflict(p, n);
      conflicts.push({ a, b, airline, aSays: side(ea!), bSays: side(eb!), verdict, rule });
      if (verdict === "active") {
        route(a, b, p, pos(ea) ? "own_page" : "resolved", rule);
        route(b, a, p, pos(eb) ? "own_page" : "resolved", rule);
      }
      continue;
    }

    // No contradiction: each page decides its own direction.
    const direction = (from: string, to: string, own?: Evidence, other?: Evidence) => {
      if (pos(own)) return route(from, to, own!, "own_page", null);
      if (own) return; // via, suspended, ended or not started on its own page
      // Nothing on `from`'s page. Infer from the other end only if `from` has no usable page.
      if (!usablePages.has(from) && pos(other)) route(from, to, other!, "reverse_only", null);
    };
    direction(a, b, ea, eb);
    direction(b, a, eb, ea);
  }

  return { routes: applyOverrides(routes, ov, input.countryOf, today), conflicts };
}

function applyOverrides(
  routes: DirectedRoute[],
  ov: Overrides,
  countryOf: ReadonlyMap<string, string> | undefined,
  today: Date,
): DirectedRoute[] {
  const iso = today.toISOString().slice(0, 10);
  const live = <T extends { until?: string }>(r: T) => !r.until || r.until > iso;
  const closed = new Set(ov.closedAirports.filter(live).map((c) => c.iata));
  const suspended = ov.suspended.filter(live);
  const removed = (r: DirectedRoute) =>
    ov.remove.some(
      (x) =>
        (!x.airline || x.airline === r.airline) &&
        ((x.origin === r.origin && x.dest === r.dest) ||
          (!!x.bothWays && x.origin === r.dest && x.dest === r.origin)),
    );
  const isSuspended = (r: DirectedRoute) =>
    suspended.some(
      (s) =>
        s.airline === r.airline &&
        ((!s.airport && !s.country) ||
          (s.airport !== undefined && (s.airport === r.origin || s.airport === r.dest)) ||
          (s.country !== undefined &&
            (countryOf?.get(r.origin) === s.country || countryOf?.get(r.dest) === s.country))),
    );

  const out = routes.filter(
    (r) => !closed.has(r.origin) && !closed.has(r.dest) && !removed(r) && !isSuspended(r),
  );
  const have = new Set(out.map((r) => `${r.origin}|${r.dest}|${r.airline}`));
  for (const x of ov.add) {
    const pairs: [string, string][] = x.bothWays
      ? [
          [x.origin, x.dest],
          [x.dest, x.origin],
        ]
      : [[x.origin, x.dest]];
    for (const [origin, dest] of pairs) {
      if (have.has(`${origin}|${dest}|${x.airline}`)) continue;
      out.push({
        origin,
        dest,
        airline: x.airline,
        seasonal: !!x.seasonal,
        basis: "override",
        conflict: null,
        brand: false,
      });
    }
  }
  return out;
}
