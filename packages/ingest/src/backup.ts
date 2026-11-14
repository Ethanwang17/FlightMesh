import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensureDir, paths } from "./paths";

/** Database backups kept in data/backups. */
export const KEEP_BACKUPS = 8;

/**
 * Consistent copy of the database (VACUUM INTO is safe while the database is open), keeping the
 * newest KEEP_BACKUPS. Restore by stopping the ingest container and copying a backup over
 * data/flightmesh.db.
 */
export function backupDatabase(db: DatabaseSync, now = new Date()): string {
  const dir = ensureDir(paths.backups);
  const file = join(dir, `flightmesh-${now.toISOString().slice(0, 10)}.db`);
  for (const f of readdirSync(dir)) if (f === file.split("/").pop()) unlinkSync(join(dir, f));
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir)
    .filter((f) => /^flightmesh-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) unlinkSync(join(dir, f));
  return file;
}
