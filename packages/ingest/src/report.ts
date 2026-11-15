import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensureDir, paths } from "./paths";

type Row = Record<string, string | number | null>;

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

function table(rows: Row[], cols: string[]): string[] {
  if (!rows.length) return ["  (none)"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => "  " + vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  return [
    line(cols),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(cols.map((c) => String(r[c] ?? "")))),
  ];
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Build the routes sanity report and write it plus unresolved.csv and conflicts.csv to data/reports. */
export function writeRoutesReport(db: DatabaseSync): { text: string; file: string } {
  const one = <T extends Row>(sql: string) => db.prepare(sql).get() as T;
  const all = (sql: string) => db.prepare(sql).all() as Row[];

  const totals = one<{
    routes: number;
    seasonal: number;
    origins: number;
    airlines: number;
    pairs: number;
  }>(`
    SELECT COUNT(*) AS routes, SUM(seasonal) AS seasonal, COUNT(DISTINCT origin) AS origins,
           COUNT(DISTINCT airline) AS airlines,
           COUNT(DISTINCT MIN(origin, dest) || MAX(origin, dest)) AS pairs
    FROM routes WHERE active = 1`);
  const twoWay = one<{ n: number }>(`
    SELECT COUNT(*) AS n FROM routes r WHERE r.active = 1 AND EXISTS (
      SELECT 1 FROM routes b WHERE b.active = 1 AND b.origin = r.dest AND b.dest = r.origin AND b.airline = r.airline)`);
  const noIata = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM routes WHERE active = 1 AND airline LIKE '%:%'`,
  );

  const lines = [
    `Routes report — ${new Date().toISOString()}`,
    "",
    "Totals (active directed routes)",
    `  routes            ${totals.routes}`,
    `  airport pairs     ${totals.pairs}`,
    `  seasonal          ${totals.seasonal ?? 0} (${pct(totals.seasonal ?? 0, totals.routes)})`,
    `  origin airports   ${totals.origins}`,
    `  airlines          ${totals.airlines}`,
    `  without IATA code ${noIata.n} routes (kept on the map, never in a program)`,
    `  flown both ways   ${pct(twoWay.n, totals.routes)} (same airline has the reverse route)`,
    "",
    "Routes by basis",
    ...table(
      all(
        "SELECT basis, COUNT(*) AS routes FROM routes WHERE active = 1 GROUP BY basis ORDER BY routes DESC",
      ),
      ["basis", "routes"],
    ),
    "",
    "Pages by status (latest run)",
    ...table(
      all("SELECT status, COUNT(*) AS pages FROM pages GROUP BY status ORDER BY pages DESC"),
      ["status", "pages"],
    ),
    "",
    "Pages the guard kept on their previous listings (check, then --accept IATA)",
    ...table(all("SELECT iata, title, error FROM pages WHERE status = 'guarded' ORDER BY iata"), [
      "iata",
      "title",
      "error",
    ]),
    "",
    "Large airports whose page failed or has no route table",
    ...table(
      all(`SELECT p.iata, p.status, p.title, substr(COALESCE(p.error, ''), 1, 80) AS error
           FROM pages p JOIN airports a ON a.iata = p.iata
           WHERE p.status IN ('missing', 'error', 'no_section') AND a.type = 'large_airport' ORDER BY p.iata LIMIT 30`),
      ["iata", "status", "title", "error"],
    ),
    "",
    "Busiest airports (distinct nonstop destinations)",
    ...table(
      all(`SELECT origin, COUNT(DISTINCT dest) AS destinations, COUNT(DISTINCT airline) AS airlines
           FROM routes WHERE active = 1 GROUP BY origin ORDER BY destinations DESC LIMIT 12`),
      ["origin", "destinations", "airlines"],
    ),
    "",
    "Conflicts between two airports' pages, by rule",
    ...table(
      all(
        "SELECT rule, verdict, COUNT(*) AS n FROM conflicts GROUP BY rule, verdict ORDER BY n DESC",
      ),
      ["rule", "verdict", "n"],
    ),
    "",
    "Unresolved conflicts to review (kept as current; fix on Wikipedia or in overrides.json)",
    ...table(
      all(`SELECT a, b, airline, a_status || ' ' || COALESCE(a_note, '') AS a_says,
                  b_status || ' ' || COALESCE(b_note, '') AS b_says
           FROM conflicts WHERE rule = 'unresolved' ORDER BY a, b LIMIT 40`),
      ["a", "b", "airline", "a_says", "b_says"],
    ),
    "",
    "Airlines judged no longer flying (dropped from every route)",
    ...table(
      all(`SELECT title, source, COALESCE(ceased, '') AS ceased FROM airline_status
           WHERE defunct = 1 AND source = 'article' ORDER BY title LIMIT 40`),
      ["title", "source", "ceased"],
    ),
    "",
    "Top airline links without an IATA code (map them in data/curated/airline_aliases.json if they have one)",
    ...table(
      all(
        "SELECT count, title, text, example_page FROM unresolved WHERE kind = 'airline' ORDER BY count DESC LIMIT 30",
      ),
      ["count", "title", "text", "example_page"],
    ),
    "",
    "Airline infobox codes not used because another airline holds the code (alias by hand if right)",
    ...table(
      all(
        "SELECT title, text AS reason FROM unresolved WHERE kind = 'airline_code' ORDER BY title LIMIT 40",
      ),
      ["title", "reason"],
    ),
    "",
    "Top destination links that match no airport",
    ...table(
      all(
        "SELECT count, title, text, example_page FROM unresolved WHERE kind = 'airport' ORDER BY count DESC LIMIT 30",
      ),
      ["count", "title", "text", "example_page"],
    ),
  ];

  const dir = ensureDir(paths.reports);
  const file = join(dir, "routes-report.txt");
  const text = lines.join("\n") + "\n";
  writeFileSync(file, text);

  const csv = (name: string, cols: string[], rows: Row[]) =>
    writeFileSync(
      join(dir, name),
      [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") +
        "\n",
    );
  csv(
    "unresolved.csv",
    ["kind", "count", "title", "text", "example_page"],
    all("SELECT kind, count, title, text, example_page FROM unresolved ORDER BY kind, count DESC"),
  );
  csv(
    "conflicts.csv",
    [
      "a",
      "b",
      "airline",
      "rule",
      "verdict",
      "a_status",
      "a_note",
      "a_rev_ts",
      "b_status",
      "b_note",
      "b_rev_ts",
    ],
    all("SELECT * FROM conflicts ORDER BY rule, a, b"),
  );

  return { text, file };
}
