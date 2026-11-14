import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  daysSince,
  type Alliance,
  type AllianceId,
  type Currency,
  type Program,
} from "@flightmesh/shared";
import { paths } from "./paths";

const airlineCode = z.string().regex(/^[A-Z0-9]{2}$/, "expected a 2-character IATA airline code");
const allianceId = z.enum(["star", "oneworld", "skyteam"]);

const AlliancesFile = z.object({
  alliances: z.array(
    z.object({
      id: allianceId,
      name: z.string(),
      members: z.array(airlineCode),
      verify: z.array(z.string()).default([]),
    }),
  ),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected yyyy-mm-dd");

const ProgramsFile = z.object({
  programs: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9]+$/),
      name: z.string(),
      ownerAirline: airlineCode,
      alliance: z.object({ id: allianceId, excludeMembers: z.array(airlineCode) }).nullable(),
      partners: z.array(
        z.object({
          airline: airlineCode,
          redeem: z.boolean(),
          earn: z.boolean(),
          scope: z.literal("operated-only").optional(),
          notes: z.string().optional(),
        }),
      ),
      confidence: z.enum(["high", "medium", "low"]),
      sourceUrl: z.string().url().nullable(),
      checkedAt: isoDate,
      notes: z.string().optional(),
    }),
  ),
});

const CurrenciesFile = z.object({
  currencies: z.array(
    z.object({
      id: z.enum(["bilt", "amex"]),
      name: z.string(),
      partners: z.array(
        z.object({
          program: z.string(),
          ratio: z.number().positive(),
          verified: z.boolean(),
          notes: z.string().optional(),
        }),
      ),
      sourceUrl: z.string().url().nullable(),
      checkedAt: isoDate,
    }),
  ),
});

const AliasesFile = z.object({ aliases: z.record(z.string(), airlineCode) });

const airportCode = z.string().regex(/^[A-Z]{3}$/, "expected a 3-letter IATA airport code");
/** Every override says why and where that came from. */
const why = { reason: z.string().min(3), source: z.string().min(3) };

const OverridesFile = z.object({
  add: z.array(
    z.object({
      origin: airportCode,
      dest: airportCode,
      airline: airlineCode,
      seasonal: z.boolean().optional(),
      bothWays: z.boolean().optional(),
      ...why,
    }),
  ),
  remove: z.array(
    z.object({
      origin: airportCode,
      dest: airportCode,
      airline: airlineCode.optional(),
      bothWays: z.boolean().optional(),
      ...why,
    }),
  ),
  /** An airline not flying at an airport or in a country, until a date (or until removed). */
  suspended: z.array(
    z.object({
      airline: airlineCode,
      airport: airportCode.optional(),
      country: z.string().length(2).optional(),
      until: isoDate.optional(),
      ...why,
    }),
  ),
  /** Listings naming the old airport count for the new one. */
  movedAirports: z.array(z.object({ from: airportCode, to: airportCode, ...why })),
  closedAirports: z.array(z.object({ iata: airportCode, until: isoDate.optional(), ...why })),
});

export type OverridesData = z.infer<typeof OverridesFile>;

export function loadOverrides(): OverridesData {
  return readJson(OverridesFile, "overrides.json");
}

export interface CuratedData {
  alliances: Alliance[];
  programs: Program[];
  currencies: Currency[];
  aliases: Record<string, string>;
}

function readJson<T>(schema: z.ZodType<T>, file: string): T {
  const raw: unknown = JSON.parse(readFileSync(join(paths.curated, file), "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadCurated(): CuratedData {
  return {
    alliances: readJson(AlliancesFile, "alliances.json").alliances.map(({ id, name, members }) => ({
      id,
      name,
      members,
    })),
    programs: readJson(ProgramsFile, "programs.json").programs,
    currencies: readJson(CurrenciesFile, "currencies.json").currencies,
    aliases: readJson(AliasesFile, "airline_aliases.json").aliases,
  };
}

/** A partner list not re-checked for this long gets a warning. */
export const STALE_AFTER_DAYS = 120;

export interface ValidationReport {
  /** Broken references that make the data wrong. */
  errors: string[];
  /** Codes not found in the airlines table (may be a Wikidata gap, or a typo). */
  warnings: string[];
}

/** Cross-check curated files against each other and against known airline codes. */
export function validateCurated(
  data: CuratedData,
  knownAirlines: ReadonlySet<string>,
  today: Date = new Date(),
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unknown = (code: string, where: string) => {
    if (!knownAirlines.has(code)) warnings.push(`${where}: airline ${code} not in airlines table`);
  };

  const alliances = new Map<AllianceId, Alliance>(data.alliances.map((a) => [a.id, a]));
  const memberOf = new Map<string, AllianceId>();
  for (const a of data.alliances) {
    for (const code of a.members) {
      const prev = memberOf.get(code);
      if (prev) errors.push(`airline ${code} is in both ${prev} and ${a.id}`);
      memberOf.set(code, a.id);
      unknown(code, `alliance ${a.id}`);
    }
  }

  const programIds = new Set<string>();
  for (const p of data.programs) {
    if (programIds.has(p.id)) errors.push(`duplicate program id ${p.id}`);
    programIds.add(p.id);
    if (p.alliance && !alliances.has(p.alliance.id)) {
      errors.push(`program ${p.id}: unknown alliance ${p.alliance.id}`);
    }
    for (const code of p.alliance?.excludeMembers ?? []) {
      if (!alliances.get(p.alliance!.id)?.members.includes(code))
        warnings.push(`program ${p.id}: excluded ${code} is not a ${p.alliance!.id} member`);
    }
    const seen = new Set<string>();
    for (const partner of p.partners) {
      if (seen.has(partner.airline))
        errors.push(`program ${p.id}: partner ${partner.airline} listed twice`);
      seen.add(partner.airline);
    }
    for (const code of [p.ownerAirline, ...p.partners.map((x) => x.airline)])
      unknown(code, `program ${p.id}`);
    const age = daysSince(p.checkedAt, today);
    if (age > STALE_AFTER_DAYS)
      warnings.push(`program ${p.id}: partner list last checked ${p.checkedAt} (${age} days ago)`);
  }

  for (const c of data.currencies) {
    const age = daysSince(c.checkedAt, today);
    if (age > STALE_AFTER_DAYS)
      warnings.push(
        `currency ${c.id}: transfer partners last checked ${c.checkedAt} (${age} days ago)`,
      );
    for (const p of c.partners.filter((x) => !x.verified))
      warnings.push(
        `currency ${c.id}: ${p.program} is unverified${p.notes ? ` (${p.notes})` : ""}`,
      );
    const seen = new Set<string>();
    for (const partner of c.partners) {
      if (!programIds.has(partner.program))
        errors.push(`currency ${c.id}: unknown program ${partner.program}`);
      if (seen.has(partner.program))
        errors.push(`currency ${c.id}: duplicate program ${partner.program}`);
      seen.add(partner.program);
    }
  }

  for (const [title, code] of Object.entries(data.aliases)) unknown(code, `alias "${title}"`);

  return { errors, warnings };
}

export function knownAirlineCodes(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db.prepare("SELECT iata FROM airlines WHERE iata IS NOT NULL").all() as { iata: string }[]
    ).map((r) => r.iata),
  );
}
