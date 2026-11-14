import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file (packages/ingest/src). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Generated data (database, cache, reports, snapshots). Overridable for the Docker volume. */
export const DATA_DIR = process.env.FLIGHTMESH_DATA_DIR ?? join(REPO_ROOT, "data");

export const paths = {
  db: join(DATA_DIR, "flightmesh.db"),
  cache: join(DATA_DIR, "cache"),
  reports: join(DATA_DIR, "reports"),
  snapshots: join(DATA_DIR, "snapshots"),
  backups: join(DATA_DIR, "backups"),
  /** Hand-maintained data lives in the repo (and the image), never on the data volume. */
  curated: join(REPO_ROOT, "data", "curated"),
};

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
