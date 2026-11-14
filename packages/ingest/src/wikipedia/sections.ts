export interface WikiSection {
  index: string;
  toclevel: number;
  line: string;
}

const DESTINATIONS = /airlines?\s*(and|&)\s*destinations|^destinations$/i;
const PASSENGER = /passenger/i;

/**
 * The section index that holds passenger route tables: the "Passenger" child of
 * "Airlines and destinations" if there is one, else the parent section itself.
 */
/** Section names come back as HTML: strip tags and decode the common entities. */
const plain = (line: string) =>
  line
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();

export function pickDestinationsSection(sections: WikiSection[]): string | null {
  const parentAt = sections.findIndex((s) => DESTINATIONS.test(plain(s.line)));
  if (parentAt < 0) return null;
  const parent = sections[parentAt]!;

  for (const s of sections.slice(parentAt + 1)) {
    if (s.toclevel <= parent.toclevel) break;
    if (s.toclevel === parent.toclevel + 1 && PASSENGER.test(plain(s.line))) return s.index;
  }
  return parent.index;
}
