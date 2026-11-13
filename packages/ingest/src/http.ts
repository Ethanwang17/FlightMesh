import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths } from "./paths";

/** Generic identifier; Wikimedia asks clients to identify themselves. No personal details. */
export const USER_AGENT = "FlightMesh/0.1 (personal non-commercial route map; data pipeline)";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FetchOptions {
  /** Cache file name under data/cache. */
  cacheKey: string;
  /** Re-download if the cached copy is older than this. Default: 6 days. */
  maxAgeMs?: number;
  headers?: Record<string, string>;
  retries?: number;
}

/** Fetch text with an on-disk cache and simple retry/backoff. */
export async function fetchTextCached(url: string, opts: FetchOptions): Promise<string> {
  const file = join(ensureDir(paths.cache), opts.cacheKey);
  const maxAge = opts.maxAgeMs ?? 6 * DAY_MS;
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAge) {
    return readFileSync(file, "utf8");
  }

  const retries = opts.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...opts.headers },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      writeFileSync(file, text);
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
