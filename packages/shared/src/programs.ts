import type { AirlineCode, Alliance, AllianceId, Currency, Program, ProgramId } from "./types";

/**
 * Airlines whose flights can be booked with a program's miles:
 * owner + alliance members (if the program follows its alliance) + extra partners − exclusions.
 */
export function bookableAirlines(
  program: Program,
  alliances: ReadonlyMap<AllianceId, Alliance>,
): Set<AirlineCode> {
  const out = new Set<AirlineCode>([program.ownerAirline]);
  if (program.allianceRule) {
    for (const code of alliances.get(program.allianceRule)?.members ?? []) out.add(code);
  }
  for (const code of program.extraPartners) out.add(code);
  for (const code of program.excluded) out.delete(code);
  return out;
}

/** Program ids a bank currency transfers to. */
export function currencyPrograms(currency: Currency): ProgramId[] {
  return currency.partners.map((p) => p.program);
}
