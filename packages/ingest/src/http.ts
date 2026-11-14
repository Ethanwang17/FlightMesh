import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, paths } from "./paths";

/**
 * Wikimedia gives clients far higher rate limits (200 vs 10 requests/min) when the User-Agent
 * includes contact info. That is personal, so it comes only from FLIGHTMESH_CONTACT (set in the
 * git-ignored .env), never from the repo.
 */
export const contact = (): string | undefined =>
  process.env.FLIGHTMESH_CONTACT?.trim() || undefined;

export function userAgent(): string {
  const c = contact();
  return `FlightMesh/0.1 (personal non-commercial route map${c ? `; ${c}` : ""})`;
}

/** Per-request timeout, including reading the body. */
const REQUEST_TIMEOUT_MS = 60 * 1000;

/** Longest Retry-After we'll honour before giving up on a request. */
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FetchOptions {
  /** Cache file path under data/cache (may include subdirectories). */
  cacheKey: string;
  /** Re-download if the cached copy is older than this. Default: 6 days. */
  maxAgeMs?: number;
  headers?: Record<string, string>;
  retries?: number;
  /** Minimum gap between network requests sharing this throttle key. Cache hits don't wait. */
  throttle?: { key: string; minIntervalMs: number };
  /** Skip the disk cache entirely (for responses cached elsewhere, e.g. in SQLite). */
  noCache?: boolean;
  /** Throw to reject a response (it is retried and not cached). */
  validate?: (text: string) => void;
}

class PermanentHttpError extends Error {}

class RetryAfterError extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
  }
}

/** Retry-After in ms (seconds or HTTP date), or null. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const lastRequestAt = new Map<string, number>();

async function waitForSlot(throttle: FetchOptions["throttle"]): Promise<void> {
  if (!throttle) return;
  const wait = (lastRequestAt.get(throttle.key) ?? 0) + throttle.minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(throttle.key, Date.now());
}

/** Fetch text with an on-disk cache, optional throttling, and retry/backoff on transient errors. */
export async function fetchTextCached(url: string, opts: FetchOptions): Promise<string> {
  const file = join(paths.cache, opts.cacheKey);
  const maxAge = opts.maxAgeMs ?? 6 * DAY_MS;
  if (!opts.noCache && existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAge) {
    return readFileSync(file, "utf8");
  }

  const retries = opts.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await waitForSlot(opts.throttle);
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), ...opts.headers },
        // Without a timeout a stalled connection hangs the whole run; a timeout is retried.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const message = `HTTP ${res.status} for ${url}`;
        if (res.status === 429 || res.status === 503) {
          // At least 5 s when the server doesn't say, per Wikimedia's guidance.
          const wait = Math.min(
            retryAfterMs(res.headers.get("retry-after")) ?? 5000 * 2 ** attempt,
            MAX_RETRY_AFTER_MS,
          );
          throw new RetryAfterError(message, wait);
        }
        if (res.status >= 500) throw new Error(message);
        throw new PermanentHttpError(message);
      }
      const text = await res.text();
      opts.validate?.(text);
      if (!opts.noCache) {
        ensureDir(dirname(file));
        writeFileSync(file, text);
      }
      return text;
    } catch (err) {
      lastError = err;
      if (err instanceof PermanentHttpError) break;
      if (attempt < retries) {
        const wait = err instanceof RetryAfterError ? err.waitMs : 2000 * 2 ** attempt;
        // Hold back every request sharing this throttle, not just this one.
        if (opts.throttle) lastRequestAt.set(opts.throttle.key, Date.now() + wait);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
