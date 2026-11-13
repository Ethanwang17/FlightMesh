/** Normalize a Wikipedia title: decode, underscores to spaces, first letter uppercased. */
export function normalizeTitle(raw: string): string {
  let t = raw;
  try {
    t = decodeURIComponent(t);
  } catch {
    // Leave undecodable titles as-is.
  }
  t = t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  // Drop any section anchor.
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Extract the article title from an English Wikipedia URL, or null. */
export function titleFromWikipediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/(.+)$/.exec(url.trim());
  return m?.[1] ? normalizeTitle(m[1]) : null;
}
