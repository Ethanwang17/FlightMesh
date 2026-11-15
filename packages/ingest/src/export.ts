import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RouteFlag, type AllianceId, type Snapshot } from "@flightmesh/shared";
import { loadCurated } from "./curated";
import { ensureDir, paths, REPO_ROOT } from "./paths";
import {
  applyRenames,
  checkPublish,
  countsOf,
  diffRoutes,
  renamedAirlines,
  type CheckResult,
} from "./publish";

/** Published snapshots kept in data/snapshots (plus latest.json). */
const KEEP_SNAPSHOTS = 8;

export const ATTRIBUTION = [
  "Routes: Wikipedia airport articles, by Wikipedia contributors, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
  "Airport and airline identifiers: Wikidata, CC0",
  "Airport names and locations: OurAirports, public domain",
];

/** Where the web app reads the snapshot from. Overridable for the Docker volume. */
export const publishDir = () =>
  process.env.FLIGHTMESH_PUBLISH_DIR ?? join(REPO_ROOT, "apps", "web", "public", "data");

export function buildSnapshot(db: DatabaseSync, now = new Date()): Snapshot {
  const curated = loadCurated();
  const allianceOf = new Map<string, AllianceId>();
  for (const a of curated.alliances) for (const m of a.members) allianceOf.set(m, a.id);

  const routes = db
    .prepare(
      `SELECT r.origin, r.dest, r.airline, r.seasonal, r.basis, r.conflict, r.brand
       FROM routes r JOIN airports o ON o.iata = r.origin JOIN airports d ON d.iata = r.dest
       WHERE r.active = 1 ORDER BY r.origin, r.dest, r.airline`,
    )
    .all() as {
    origin: string;
    dest: string;
    airline: string;
    seasonal: number;
    basis: string;
    conflict: string | null;
    brand: number;
  }[];

  const airportRows = new Map(
    (
      db.prepare("SELECT iata, name, city, country, lat, lon FROM airports").all() as {
        iata: string;
        name: string;
        city: string;
        country: string;
        lat: number;
        lon: number;
      }[]
    ).map((a) => [a.iata, a]),
  );
  const airlineRows = new Map(
    (
      db.prepare("SELECT key, iata, name FROM airlines").all() as {
        key: string;
        iata: string | null;
        name: string;
      }[]
    ).map((a) => [a.key, a]),
  );

  const s: Snapshot = {
    version: 1,
    generatedAt: now.toISOString(),
    license: "CC BY-SA 4.0",
    attribution: ATTRIBUTION,
    airports: { code: [], name: [], city: [], country: [], lat: [], lon: [] },
    airlines: { key: [], iata: [], name: [], alliance: [] },
    routes: { o: [], d: [], al: [], flags: [] },
    alliances: curated.alliances,
    programs: curated.programs,
    currencies: curated.currencies,
  };

  const airportIdx = new Map<string, number>();
  const airport = (code: string) => {
    let i = airportIdx.get(code);
    if (i === undefined) {
      const a = airportRows.get(code)!;
      i = s.airports.code.push(code) - 1;
      s.airports.name.push(a.name);
      s.airports.city.push(a.city);
      s.airports.country.push(a.country);
      s.airports.lat.push(Math.round(a.lat * 1e4) / 1e4);
      s.airports.lon.push(Math.round(a.lon * 1e4) / 1e4);
      airportIdx.set(code, i);
    }
    return i;
  };
  const airlineIdx = new Map<string, number>();
  const airline = (key: string) => {
    let i = airlineIdx.get(key);
    if (i === undefined) {
      const a = airlineRows.get(key);
      const iata = a?.iata ?? (key.includes(":") ? null : key);
      i = s.airlines.key.push(key) - 1;
      s.airlines.iata.push(iata);
      s.airlines.name.push(a?.name ?? key.replace(/^(wiki|name):/, ""));
      s.airlines.alliance.push(iata ? (allianceOf.get(iata) ?? null) : null);
      airlineIdx.set(key, i);
    }
    return i;
  };

  for (const r of routes) {
    s.routes.o.push(airport(r.origin));
    s.routes.d.push(airport(r.dest));
    s.routes.al.push(airline(r.airline));
    s.routes.flags.push(
      (r.seasonal ? RouteFlag.Seasonal : 0) |
        (r.brand ? RouteFlag.Brand : 0) |
        (r.basis === "reverse_only" ? RouteFlag.ReverseOnly : 0) |
        (r.conflict ? RouteFlag.Conflict : 0) |
        (r.basis === "override" ? RouteFlag.Override : 0),
    );
  }
  return s;
}

export interface ExportResult extends CheckResult {
  published: boolean;
  file: string | null;
  routes: number;
  airports: number;
  added: number;
  removed: number;
  reportFile: string;
}

/**
 * Build a snapshot, compare it with the last published one, and publish it only if the checks
 * pass (or `force`). A refused build leaves the live snapshot untouched.
 */
export function exportSnapshot(
  db: DatabaseSync,
  opts: { force?: boolean; now?: Date } = {},
): ExportResult {
  const now = opts.now ?? new Date();
  const snapDir = ensureDir(paths.snapshots);
  const latest = join(snapDir, "latest.json");
  const prev = existsSync(latest) ? (JSON.parse(readFileSync(latest, "utf8")) as Snapshot) : null;

  const next = buildSnapshot(db, now);
  const renames = prev ? renamedAirlines(prev, next) : new Map<string, string>();
  const checks = checkPublish(prev ? applyRenames(countsOf(prev), renames) : null, countsOf(next));
  const changes = diffRoutes(prev, next);
  const publish = checks.failures.length === 0 || !!opts.force;

  const body = JSON.stringify(next);
  const sha256 = createHash("sha256").update(body).digest("hex");
  let file: string | null = null;
  if (publish) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    file = join(snapDir, `snapshot-${stamp}.json`);
    writeFileSync(file, body);
    writeFileSync(latest, body);
    copyFileSync(file, join(ensureDir(publishDir()), "snapshot.json"));
    const old = readdirSync(snapDir)
      .filter((f) => f.startsWith("snapshot-"))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_SNAPSHOTS)))
      unlinkSync(join(snapDir, f));
  }

  const reports = ensureDir(paths.reports);
  const lines = [
    `Publish report — ${now.toISOString()}`,
    "",
    publish
      ? checks.failures.length
        ? "PUBLISHED with --force despite failed checks"
        : "PUBLISHED"
      : "NOT PUBLISHED: checks failed. The previous snapshot stays live. Review, then re-run with --force if the changes are real.",
    `routes ${next.routes.o.length} · airports ${next.airports.code.length} · airlines ${next.airlines.key.length} · ` +
      `${(body.length / 1e6).toFixed(2)} MB`,
    prev
      ? `previous: routes ${prev.routes.o.length}, published ${prev.generatedAt}`
      : "previous: none (first publish)",
    "",
    ...(renames.size
      ? [
          `Airlines re-identified (not counted as losses): ${[...renames].map(([a, b]) => `${a} → ${b}`).join(", ")}`,
          "",
        ]
      : []),
    `Failures (${checks.failures.length})`,
    ...checks.failures.map((f) => `  - ${f}`),
    "",
    `Warnings (${checks.warnings.length})`,
    ...checks.warnings.map((w) => `  - ${w}`),
    "",
    `Routes added: ${changes.added.length}, removed: ${changes.removed.length} (full lists in changes.txt)`,
    ...changes.added.slice(0, 25).map((r) => `  + ${r}`),
    ...changes.removed.slice(0, 25).map((r) => `  - ${r}`),
  ];
  const reportFile = join(reports, "publish.txt");
  writeFileSync(reportFile, lines.join("\n") + "\n");
  writeFileSync(
    join(reports, "changes.txt"),
    [
      `# ${now.toISOString()}`,
      ...changes.added.map((r) => `+ ${r}`),
      ...changes.removed.map((r) => `- ${r}`),
    ].join("\n") + "\n",
  );

  db.prepare(
    "INSERT INTO snapshots (generated_at, file, sha256, routes, airports, published, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    now.toISOString(),
    file,
    sha256,
    next.routes.o.length,
    next.airports.code.length,
    publish ? 1 : 0,
    JSON.stringify({
      failures: checks.failures,
      warnings: checks.warnings.length,
      added: changes.added.length,
      removed: changes.removed.length,
    }),
  );

  return {
    ...checks,
    published: publish,
    file,
    routes: next.routes.o.length,
    airports: next.airports.code.length,
    added: changes.added.length,
    removed: changes.removed.length,
    reportFile,
  };
}
