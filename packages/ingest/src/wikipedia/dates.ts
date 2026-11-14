import type { Mode } from "./parse";

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const month = (name: string): number | undefined => MONTHS[name.toLowerCase().slice(0, 3)];

/**
 * Parse the loose dates Wikipedia uses in route notes: "27 October 2026", "June 10, 2027",
 * "3rd March 2027", "late March 2027", "summer 2027", "2027". Month-only and year-only dates
 * resolve to the first day. UTC. Null when there is no year.
 */
export function parseLooseDate(text: string): Date | null {
  const t = text
    .replace(/\u00a0/g, " ")
    .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
    .replace(/\b(early|mid|late|summer|winter|spring|autumn|fall|from|on|in|the)\b/gi, " ")
    .trim();
  let m = /(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/.exec(t);
  if (m) {
    const mo = month(m[2]!);
    if (mo !== undefined) return new Date(Date.UTC(Number(m[3]), mo, Number(m[1])));
  }
  m = /([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(t);
  if (m) {
    const mo = month(m[1]!);
    if (mo !== undefined) return new Date(Date.UTC(Number(m[3]), mo, Number(m[2])));
  }
  m = /([A-Za-z]{3,})\.?\s+(\d{4})/.exec(t);
  if (m) {
    const mo = month(m[1]!);
    if (mo !== undefined) return new Date(Date.UTC(Number(m[2]), mo, 1));
  }
  m = /\b(\d{4})\b/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[1]), 0, 1));
  return null;
}

/**
 * What a listing says about a route today.
 * - current: flying now
 * - future: announced, not started
 * - resuming: paused, returning later (seasonal routes resuming next season count as current)
 * - suspended / ended: not flying
 * - via: the flight stops on the way, so it is not a nonstop segment
 */
export type ListingStatus = "current" | "future" | "resuming" | "suspended" | "ended" | "via";

export interface Classified {
  status: ListingStatus;
  /** The date in the note, when it has one (ISO yyyy-mm-dd). */
  date: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function classifyNote(note: string, mode: Mode, today: Date): Classified {
  const n = note.toLowerCase();
  if (!n) return { status: "current", date: null };
  const date = parseLooseDate(note);
  if (/\bvia\b/.test(n)) return { status: "via", date: null };
  if (/suspend|cancel/.test(n)) return { status: "suspended", date: iso(date) };
  if (/begin|commenc|\bstart|launch/.test(n)) {
    return { status: date && date <= today ? "current" : "future", date: iso(date) };
  }
  if (/resum|restart|return/.test(n)) {
    if (date && date <= today) return { status: "current", date: iso(date) };
    const seasonal = mode === "seasonal" || mode === "seasonal_charter";
    return { status: seasonal ? "current" : "resuming", date: iso(date) };
  }
  if (/\bend|terminat|ceas|discontinu|until/.test(n)) {
    return { status: date && date < today ? "ended" : "current", date: iso(date) };
  }
  return { status: "current", date: null };
}

/** Statuses that mean "not flying this route now". */
export const NEGATIVE: ReadonlySet<ListingStatus> = new Set(["suspended", "ended"]);
export const NOT_YET: ReadonlySet<ListingStatus> = new Set(["future", "resuming"]);
