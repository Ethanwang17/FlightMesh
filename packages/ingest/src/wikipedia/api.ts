import { contact, fetchTextCached } from "../http";
import type { WikiSection } from "./sections";

const API = "https://en.wikipedia.org/w/api.php";
/**
 * One request at a time, paced under Wikimedia's limits: 200/min with contact info in the
 * User-Agent, 10/min without (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits).
 */
const throttle = () => ({ key: "wikipedia", minIntervalMs: contact() ? 350 : 6500 });

/** Rough wall-clock estimate for `requests` API calls at the current tier. */
export function estimateMinutes(requests: number): number {
  return Math.ceil((requests * throttle().minIntervalMs) / 60000);
}

/** A page revision never changes, so responses pinned to one are cached for good. */
const FOREVER = Number.POSITIVE_INFINITY;

/** Errors worth retrying: server lag and rate limiting. Others (e.g. missing page) are answers. */
const RETRYABLE = new Set(["maxlag", "ratelimited", "internal_api_error_DBQueryError", "readonly"]);

interface ApiError {
  error?: { code: string; info: string };
}

function validate(text: string): void {
  const body = JSON.parse(text) as ApiError;
  if (body.error && RETRYABLE.has(body.error.code))
    throw new Error(`Wikipedia API: ${body.error.code}`);
}

function apiUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  return `${API}?${qs}`;
}

/** Cache file name safe for any title. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

export type PageResult<T> = { ok: true; value: T } | { ok: false; code: string };

export interface Revision {
  /** Canonical title after normalization and redirects. */
  title: string;
  revid: number;
  /** ISO timestamp of the revision. */
  timestamp: string;
}

interface RevisionsResponse {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: {
      title: string;
      missing?: boolean;
      invalid?: boolean;
      revisions?: { revid: number; timestamp: string }[];
    }[];
  };
}

/**
 * Latest revision of each title, 50 per request (redirects followed). Missing pages map to null.
 * This is how a run finds out which pages changed without downloading them.
 */
export async function fetchLatestRevisions(
  titles: string[],
): Promise<Map<string, Revision | null>> {
  const out = new Map<string, Revision | null>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const text = await fetchTextCached(
      apiUrl({
        action: "query",
        prop: "revisions",
        rvprop: "ids|timestamp",
        titles: batch.join("|"),
        redirects: "1",
      }),
      { cacheKey: "unused", noCache: true, throttle: throttle(), validate },
    );
    const q = (JSON.parse(text) as RevisionsResponse).query;
    const normalized = new Map((q?.normalized ?? []).map((n) => [n.from, n.to]));
    const redirects = new Map((q?.redirects ?? []).map((r) => [r.from, r.to]));
    const pages = new Map((q?.pages ?? []).map((p) => [p.title, p]));
    for (const t of batch) {
      const n = normalized.get(t) ?? t;
      const final = redirects.get(n) ?? n;
      const p = pages.get(final);
      const rev = p?.revisions?.[0];
      out.set(
        t,
        p && !p.missing && !p.invalid && rev
          ? { title: final, revid: rev.revid, timestamp: rev.timestamp }
          : null,
      );
    }
  }
  return out;
}

export async function fetchSections(
  cacheId: string,
  revid: number,
): Promise<PageResult<WikiSection[]>> {
  const text = await fetchTextCached(
    apiUrl({ action: "parse", oldid: String(revid), prop: "sections" }),
    {
      cacheKey: `wikipedia/${safe(cacheId)}.r${revid}.sections.json`,
      maxAgeMs: FOREVER,
      throttle: throttle(),
      validate,
    },
  );
  const body = JSON.parse(text) as ApiError & { parse?: { sections: WikiSection[] } };
  if (!body.parse) return { ok: false, code: body.error?.code ?? "unknown" };
  return { ok: true, value: body.parse.sections };
}

export async function fetchSectionHtml(
  cacheId: string,
  revid: number,
  section: string,
): Promise<PageResult<string>> {
  const text = await fetchTextCached(
    apiUrl({
      action: "parse",
      oldid: String(revid),
      section,
      prop: "text",
      disablelimitreport: "1",
      disableeditsection: "1",
    }),
    {
      cacheKey: `wikipedia/${safe(cacheId)}.r${revid}.section-${section}.json`,
      maxAgeMs: FOREVER,
      throttle: throttle(),
      validate,
    },
  );
  const body = JSON.parse(text) as ApiError & { parse?: { text: string } };
  if (!body.parse) return { ok: false, code: body.error?.code ?? "unknown" };
  return { ok: true, value: body.parse.text };
}

export interface ArticleLead {
  /** HTML of the lead section, including the infobox. */
  html: string;
  categories: string[];
}

/** Lead section (infobox + intro) and categories of one article revision. */
export async function fetchArticleLead(revid: number): Promise<PageResult<ArticleLead>> {
  const text = await fetchTextCached(
    apiUrl({
      action: "parse",
      oldid: String(revid),
      section: "0",
      prop: "text|categories",
      disablelimitreport: "1",
      disableeditsection: "1",
    }),
    {
      cacheKey: `wikipedia-airlines/r${revid}.lead.json`,
      maxAgeMs: FOREVER,
      throttle: throttle(),
      validate,
    },
  );
  const body = JSON.parse(text) as ApiError & {
    parse?: { text: string; categories?: { category: string }[] };
  };
  if (!body.parse) return { ok: false, code: body.error?.code ?? "unknown" };
  return {
    ok: true,
    value: {
      html: body.parse.text,
      categories: (body.parse.categories ?? []).map((c) => c.category.replace(/_/g, " ")),
    },
  };
}

interface QueryResponse {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
  };
}

/**
 * Resolve titles through normalization and redirects, 50 per request.
 * Returns source → final target for every input (unchanged titles map to themselves).
 */
export async function resolveRedirectTitles(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const text = await fetchTextCached(
      apiUrl({ action: "query", titles: batch.join("|"), redirects: "1" }),
      {
        cacheKey: "unused",
        noCache: true, // results are cached in SQLite (wiki_redirects)
        throttle: throttle(),
        validate,
      },
    );
    const q = (JSON.parse(text) as QueryResponse).query;
    const normalized = new Map((q?.normalized ?? []).map((n) => [n.from, n.to]));
    const redirects = new Map((q?.redirects ?? []).map((r) => [r.from, r.to]));
    for (const t of batch) {
      const n = normalized.get(t) ?? t;
      out.set(t, redirects.get(n) ?? n);
    }
  }
  return out;
}
