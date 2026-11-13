import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Alliance, AllianceId, Currency, Program } from "@flightmesh/shared";
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

const ProgramsFile = z.object({
  programs: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9]+$/),
      name: z.string(),
      ownerAirline: airlineCode,
      allianceRule: allianceId.nullable(),
      extraPartners: z.array(airlineCode),
      excluded: z.array(airlineCode),
      confidence: z.enum(["high", "medium", "low"]),
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
    }),
  ),
});

const AliasesFile = z.object({ aliases: z.record(z.string(), airlineCode) });

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
    if (p.allianceRule && !alliances.has(p.allianceRule)) {
      errors.push(`program ${p.id}: unknown alliance ${p.allianceRule}`);
    }
    for (const code of [p.ownerAirline, ...p.extraPartners, ...p.excluded])
      unknown(code, `program ${p.id}`);
  }

  for (const c of data.currencies) {
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
    (db.prepare("SELECT iata FROM airlines").all() as { iata: string }[]).map((r) => r.iata),
  );
}
