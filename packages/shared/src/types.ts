/** IATA airport code, e.g. "AMS". */
export type AirportCode = string;
/** IATA airline code, e.g. "KL". */
export type AirlineCode = string;

export type AllianceId = "star" | "oneworld" | "skyteam";
export type CurrencyId = "bilt" | "amex";
/** Slug for a loyalty program, e.g. "flyingblue". */
export type ProgramId = string;

export interface Airport {
  iata: AirportCode;
  icao: string | null;
  name: string;
  city: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  lat: number;
  lon: number;
  wikipediaTitle: string | null;
  wikidataId: string | null;
}

export interface Airline {
  iata: AirlineCode;
  icao: string | null;
  name: string;
  wikidataId: string | null;
  alliance: AllianceId | null;
}

export interface Alliance {
  id: AllianceId;
  name: string;
  members: AirlineCode[];
}

/** One airline flying nonstop from origin to destination. */
export interface Route {
  origin: AirportCode;
  dest: AirportCode;
  airline: AirlineCode;
  seasonal: boolean;
}

/** A non-alliance partnership (or an exception to one). */
export interface ProgramPartner {
  airline: AirlineCode;
  /** Miles can be spent on this airline's flights. Earn-only partners never make a route bookable. */
  redeem: boolean;
  earn: boolean;
  /** "operated-only": bookable only on flights the airline operates itself, not its brands/subsidiaries. */
  scope?: "operated-only";
  notes?: string;
}

export interface Program {
  id: ProgramId;
  name: string;
  ownerAirline: AirlineCode;
  /** Alliance whose members are bookable, minus listed exceptions. */
  alliance: { id: AllianceId; excludeMembers: AirlineCode[] } | null;
  partners: ProgramPartner[];
  /** How sure the curated partner list is. "low" means check the program's own site. */
  confidence: "high" | "medium" | "low";
  /** Where the partner list was checked, and when (yyyy-mm-dd). */
  sourceUrl: string | null;
  checkedAt: string;
  notes?: string;
}

export interface TransferPartner {
  program: ProgramId;
  /** Miles received per bank point, e.g. 1 for 1:1, 0.8 for 5:4. */
  ratio: number;
  /** False when public sources disagree on whether this partnership is current. */
  verified: boolean;
  notes?: string;
}

export interface Currency {
  id: CurrencyId;
  name: string;
  partners: TransferPartner[];
  sourceUrl: string | null;
  checkedAt: string;
}

/**
 * Filter selections. Choices inside one dimension are combined with OR;
 * separate dimensions are combined with AND. Empty means "no restriction".
 */
export interface Filters {
  currencies: CurrencyId[];
  programs: ProgramId[];
  alliances: AllianceId[];
  airlines: AirlineCode[];
}

export const EMPTY_FILTERS: Filters = {
  currencies: [],
  programs: [],
  alliances: [],
  airlines: [],
};
