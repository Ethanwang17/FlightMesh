#!/usr/bin/env -S npx tsx
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCurated, knownAirlineCodes, validateCurated } from "./curated";
import { backupDatabase } from "./backup";
import { openDb } from "./db";
import { exportSnapshot } from "./export";
import { ensureDir, paths, REPO_ROOT } from "./paths";
import { writeRoutesReport } from "./report";
import { ingestAirports } from "./sources/ourairports";
import { deriveRoutes, ingestRoutes } from "./sources/routes";
import { ingestWikidata } from "./sources/wikidata";

const USAGE = `Usage: pnpm ingest <command>

Commands:
  airports    Load airports from OurAirports
  wikidata    Load airline codes and Wikipedia title mappings from Wikidata
  validate    Check curated JSON against itself and the airlines table
  reference   airports + wikidata + validate
  routes      Read changed Wikipedia pages and derive routes
              [--only AMS,SEA] [--limit N] [--full] [--accept AMS,SEA]
  derive      Re-derive routes from stored listings (no page fetches)
  report      Write the routes report, unresolved.csv and conflicts.csv
  export      Build the snapshot and publish it if the checks pass   [--force]
  refresh     reference + routes + report + export + backup (the weekly job)   [--force]
  backup      Copy the database to data/backups (keeps the newest 8)
  stats       Print table counts`;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function runRoutes(db: ReturnType<typeof openDb>): Promise<void> {
  const only = flag("only")?.split(",").filter(Boolean);
  const accept = flag("accept")?.split(",").filter(Boolean);
  const limit = flag("limit") ? Number(flag("limit")) : undefined;
  const full = process.argv.includes("--full");
  console.log(
    `routes: ${only ? only.join(",") : limit ? `first ${limit} airports` : "all airports"}${full ? " (full refetch)" : ""}`,
  );
  const s = await ingestRoutes(db, { only, limit, full, accept });
  console.log(
    `routes: ${s.checked} pages checked, ${s.fetched} fetched, ${s.unchanged} unchanged, ${s.failed} failed, ` +
      `${s.guarded.length} guarded${s.guarded.length ? ` (${s.guarded.join(",")})` : ""}`,
  );
  console.log(
    `routes: ${s.routes} directed routes, ${s.conflicts} conflicts, ${s.unresolved} unresolved links, ` +
      `${s.charter} charter listings and ${s.defunct} listings of defunct airlines left out`,
  );
}

function runExport(db: ReturnType<typeof openDb>): number {
  const r = exportSnapshot(db, { force: process.argv.includes("--force") });
  console.log(
    `export: ${r.published ? "published" : "NOT published"} — ${r.routes} routes, ${r.airports} airports, ` +
      `+${r.added} / −${r.removed} routes, ${r.failures.length} failures, ${r.warnings.length} warnings`,
  );
  for (const f of r.failures) console.log(`  FAIL ${f}`);
  console.log(`  details: ${r.reportFile}`);
  return r.published ? 0 : 2;
}

function runReport(db: ReturnType<typeof openDb>): void {
  const { text, file } = writeRoutesReport(db);
  console.log(text);
  console.log(`Report written to ${file}`);
}

// Optional local settings (e.g. FLIGHTMESH_CONTACT). Git-ignored.
const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(cmd: string | undefined): Promise<number> {
  const db = openDb();
  try {
    switch (cmd) {
      case "airports":
        console.log(`airports: ${await ingestAirports(db)} loaded`);
        return 0;
      case "wikidata": {
        const r = await ingestWikidata(db);
        console.log(
          `wikidata: ${r.airports} airport titles, ${r.airlines} airlines, ${r.airlineTitles} airline titles, ${r.dissolved} dissolved`,
        );
        return 0;
      }
      case "validate":
        return validate(db);
      case "reference":
        console.log(`airports: ${await ingestAirports(db)} loaded`);
        {
          const r = await ingestWikidata(db);
          console.log(
            `wikidata: ${r.airports} airport titles, ${r.airlines} airlines, ${r.airlineTitles} airline titles`,
          );
        }
        return validate(db);
      case "routes":
        await runRoutes(db);
        return 0;
      case "derive": {
        const s = await deriveRoutes(db, new Date(), console.log);
        console.log(
          `derive: ${s.routes} directed routes, ${s.conflicts} conflicts, ${s.unresolved} unresolved links`,
        );
        return 0;
      }
      case "report":
        runReport(db);
        return 0;
      case "export":
        return runExport(db);
      case "backup":
        console.log(`backup: ${backupDatabase(db)}`);
        return 0;
      case "refresh":
      case "all": {
        console.log(`airports: ${await ingestAirports(db)} loaded`);
        const r = await ingestWikidata(db);
        console.log(
          `wikidata: ${r.airports} airport titles, ${r.airlines} airlines, ${r.airlineTitles} airline titles, ${r.dissolved} dissolved`,
        );
        if (validate(db)) return 1;
        await runRoutes(db);
        runReport(db);
        const code = runExport(db);
        console.log(`backup: ${backupDatabase(db)}`);
        return code;
      }
      case "stats":
        for (const table of [
          "airports",
          "airlines",
          "wiki_titles",
          "pages",
          "page_listings",
          "routes",
          "conflicts",
        ]) {
          const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
          console.log(`${table.padEnd(12)} ${n}`);
        }
        return 0;
      default:
        console.log(USAGE);
        return cmd ? 1 : 0;
    }
  } finally {
    db.close();
  }
}

function validate(db: ReturnType<typeof openDb>): number {
  const data = loadCurated();
  const report = validateCurated(data, knownAirlineCodes(db));
  const lines = [
    `Curated data validation — ${new Date().toISOString()}`,
    `${data.alliances.length} alliances, ${data.programs.length} programs, ${data.currencies.length} currencies, ${Object.keys(data.aliases).length} aliases`,
    "",
    `Errors (${report.errors.length})`,
    ...report.errors.map((e) => `  - ${e}`),
    "",
    `Warnings (${report.warnings.length})`,
    ...report.warnings.map((w) => `  - ${w}`),
  ];
  const file = join(ensureDir(paths.reports), "curated-validation.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nReport written to ${file}`);
  return report.errors.length ? 1 : 0;
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
