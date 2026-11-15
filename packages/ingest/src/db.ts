import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensureDir, paths } from "./paths";

/**
 * Bump when the schema changes incompatibly. Everything except the redirect cache and meta is
 * rebuildable from downloads (data/cache), so an older database is simply recreated.
 */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS airports (
  iata            TEXT PRIMARY KEY,
  icao            TEXT,
  name            TEXT NOT NULL,
  city            TEXT NOT NULL,
  country         TEXT NOT NULL,
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  type            TEXT NOT NULL,
  -- OurAirports' scheduled_service flag. Used to choose which pages to fetch, not as truth.
  scheduled       INTEGER NOT NULL DEFAULT 0,
  wikipedia_title TEXT,
  wikidata_id     TEXT
);

-- key = IATA code when the airline has one, else 'wiki:<Title>' (added during route resolution).
CREATE TABLE IF NOT EXISTS airlines (
  key             TEXT PRIMARY KEY,
  iata            TEXT,
  icao            TEXT,
  name            TEXT NOT NULL,
  wikidata_id     TEXT,
  wikipedia_title TEXT
);

-- Wikipedia article title -> code. Used to resolve wikilinks in route tables.
CREATE TABLE IF NOT EXISTS wiki_titles (
  kind  TEXT NOT NULL CHECK (kind IN ('airport', 'airline')),
  title TEXT NOT NULL,
  code  TEXT NOT NULL,
  PRIMARY KEY (kind, title)
);

-- Whether an airline still flies: from Wikidata (dissolved) or its article's infobox/categories.
CREATE TABLE IF NOT EXISTS airline_status (
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,   -- wikidata | article
  revid      INTEGER,
  defunct    INTEGER NOT NULL,
  ceased     TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (title, source)
);

-- Redirect lookups (target = source when the title is not a redirect).
CREATE TABLE IF NOT EXISTS wiki_redirects (
  source     TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- One row per airport page: the latest revision seen and what happened to it.
CREATE TABLE IF NOT EXISTS pages (
  iata       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  revid      INTEGER,
  rev_ts     TEXT,
  status     TEXT NOT NULL,   -- ok | unchanged | no_section | missing | guarded | error
  section    TEXT,
  rows       INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  checked_at TEXT NOT NULL
);

-- The parsed rows each airport page currently contributes. Replaced only when a new revision
-- parses cleanly and passes the page guard.
CREATE TABLE IF NOT EXISTS page_listings (
  iata       TEXT PRIMARY KEY,
  revid      INTEGER NOT NULL,
  rev_ts     TEXT NOT NULL,
  rows_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Directed routes derived from listings each run. Inactive rows are kept for history.
CREATE TABLE IF NOT EXISTS routes (
  origin     TEXT NOT NULL,
  dest       TEXT NOT NULL,
  airline    TEXT NOT NULL,
  seasonal   INTEGER NOT NULL DEFAULT 0,
  basis      TEXT NOT NULL,   -- own_page | reverse_only | resolved | override
  conflict   TEXT,            -- rule that settled a disagreement between the two pages
  brand      INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (origin, dest, airline)
);

-- Disagreements between two airports' pages in the latest run, and how they were settled.
CREATE TABLE IF NOT EXISTS conflicts (
  a TEXT NOT NULL, b TEXT NOT NULL, airline TEXT NOT NULL,
  a_status TEXT NOT NULL, a_date TEXT, a_note TEXT, a_rev_ts TEXT,
  b_status TEXT NOT NULL, b_date TEXT, b_note TEXT, b_rev_ts TEXT,
  verdict TEXT NOT NULL, rule TEXT NOT NULL,
  PRIMARY KEY (a, b, airline)
);

-- Links that couldn't be mapped to a code in the latest run.
CREATE TABLE IF NOT EXISTS unresolved (
  kind  TEXT NOT NULL,
  title TEXT NOT NULL,
  text  TEXT NOT NULL,
  count INTEGER NOT NULL,
  example_page TEXT NOT NULL,
  PRIMARY KEY (kind, title, text)
);

-- Every export attempt, published or refused by the publish checks.
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  file         TEXT,
  sha256       TEXT,
  routes       INTEGER NOT NULL,
  airports     INTEGER NOT NULL,
  published    INTEGER NOT NULL,
  summary      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const KEEP_ON_UPGRADE = new Set(["wiki_redirects", "meta", "snapshots", "sqlite_sequence"]);

export function openDb(file = paths.db): DatabaseSync {
  if (file !== ":memory:") ensureDir(dirname(file));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const version = Number(getMeta(db, "schema_version") ?? 0);
  if (version !== SCHEMA_VERSION) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) if (!KEEP_ON_UPGRADE.has(name)) db.exec(`DROP TABLE "${name}"`);
  }
  db.exec(SCHEMA);
  addColumns(db);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
  return db;
}

/** Additive column changes that don't need a rebuild (old rows get the default). */
function addColumns(db: DatabaseSync): void {
  const want: [string, string, string][] = [
    ["airline_status", "iata", "TEXT"],
    ["airline_status", "icao", "TEXT"],
    ["airline_status", "parsed_v", "INTEGER NOT NULL DEFAULT 1"],
  ];
  for (const [table, column, type] of want) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  return (
    db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
  )?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Run `fn` inside a transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
