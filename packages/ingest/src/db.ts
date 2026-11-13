import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensureDir, paths } from "./paths";

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
  wikipedia_title TEXT,
  wikidata_id     TEXT
);

CREATE TABLE IF NOT EXISTS airlines (
  iata        TEXT PRIMARY KEY,
  icao        TEXT,
  name        TEXT NOT NULL,
  wikidata_id TEXT,
  wikipedia_title TEXT
);

-- Wikipedia article title -> code. Used to resolve wikilinks in route tables.
CREATE TABLE IF NOT EXISTS wiki_titles (
  kind  TEXT NOT NULL CHECK (kind IN ('airport', 'airline')),
  title TEXT NOT NULL,
  code  TEXT NOT NULL,
  PRIMARY KEY (kind, title)
);

CREATE TABLE IF NOT EXISTS routes (
  origin      TEXT NOT NULL,
  dest        TEXT NOT NULL,
  airline     TEXT NOT NULL,
  seasonal    INTEGER NOT NULL DEFAULT 0,
  source_page TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (origin, dest, airline)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file = paths.db): DatabaseSync {
  if (file !== ":memory:") ensureDir(dirname(file));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
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
