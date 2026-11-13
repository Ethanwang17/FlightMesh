import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file (packages/ingest/src). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Overridable so the Docker ingest container can mount a volume. */
export const DATA_DIR = process.env.FLIGHTMESH_DATA_DIR ?? join(REPO_ROOT, "data");

export const paths = {
  db: join(DATA_DIR, "flightmesh.db"),
  cache: join(DATA_DIR, "cache"),
  reports: join(DATA_DIR, "reports"),
  curated: join(DATA_DIR, "curated"),
};

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
