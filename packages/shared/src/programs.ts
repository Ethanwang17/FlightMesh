import type { AirlineCode, Alliance, AllianceId, Currency, Program, ProgramId } from "./types";

/** Which airlines a program can redeem on, and which of those only on flights they operate. */
export interface Bookability {
  airlines: Set<AirlineCode>;
  operatedOnly: Set<AirlineCode>;
}

/**
 * Airlines whose flights are potentially bookable with a program's miles:
 * owner + alliance members − excluded members + partners that allow redemption.
 * An explicit partner entry with `redeem: false` (earn-only) removes the airline even if it is
 * an alliance member. Nothing here says award space exists.
 */
export function bookableAirlines(
  program: Program,
  alliances: ReadonlyMap<AllianceId, Alliance>,
): Bookability {
  const airlines = new Set<AirlineCode>([program.ownerAirline]);
  const operatedOnly = new Set<AirlineCode>();
  if (program.alliance) {
    for (const code of alliances.get(program.alliance.id)?.members ?? []) airlines.add(code);
    for (const code of program.alliance.excludeMembers) airlines.delete(code);
  }
  for (const p of program.partners) {
    if (!p.redeem) {
      airlines.delete(p.airline);
      continue;
    }
    airlines.add(p.airline);
    if (p.scope === "operated-only") operatedOnly.add(p.airline);
  }
  airlines.add(program.ownerAirline);
  return { airlines, operatedOnly };
}

/**
 * Whether a route is potentially bookable: its airline is redeemable, and if the program only
 * covers flights that airline operates, the route wasn't listed under one of its brands.
 */
export function isBookable(b: Bookability, airline: AirlineCode, viaBrand: boolean): boolean {
  return b.airlines.has(airline) && !(viaBrand && b.operatedOnly.has(airline));
}

/** Program ids a bank currency transfers to. */
export function currencyPrograms(currency: Currency): ProgramId[] {
  return currency.partners.map((p) => p.program);
}

/** Days since a yyyy-mm-dd date, relative to `today`. */
export function daysSince(date: string, today: Date): number {
  return Math.floor((today.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}
