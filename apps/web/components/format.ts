import type { Snapshot } from "@flightmesh/shared";

const regionNames =
  typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const km = (n: number) => `${Math.round(n).toLocaleString("en-US")} km`;

/** Short airline label: IATA code when known, else the name. */
export const airlineLabel = (s: Snapshot, al: number) =>
  s.airlines.iata[al] ?? s.airlines.name[al]!;

export const airportLabel = (s: Snapshot, i: number) => {
  const city = s.airports.city[i];
  return city ? `${city}` : s.airports.name[i]!;
};
