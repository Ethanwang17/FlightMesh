#!/usr/bin/env -S npx tsx
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCurated, knownAirlineCodes, validateCurated } from "./curated";
import { openDb } from "./db";
import { ensureDir, paths } from "./paths";
import { ingestAirports } from "./sources/ourairports";
import { ingestWikidata } from "./sources/wikidata";

const USAGE = `Usage: pnpm ingest <command>

Commands:
  airports    Load airports from OurAirports
  wikidata    Load airline codes and Wikipedia title mappings from Wikidata
  validate    Check curated JSON against itself and the airlines table
  reference   airports + wikidata + validate
  stats       Print table counts`;

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
          `wikidata: ${r.airports} airport titles, ${r.airlines} airlines, ${r.airlineTitles} airline titles`,
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
      case "stats":
        for (const table of ["airports", "airlines", "wiki_titles", "routes"]) {
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
