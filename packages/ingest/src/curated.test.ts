import { describe, expect, it } from "vitest";
import { loadCurated, validateCurated, type CuratedData } from "./curated";

describe("curated data files", () => {
  it("parse and cross-reference cleanly", () => {
    const data = loadCurated();
    const allCodes = new Set<string>();
    for (const a of data.alliances) a.members.forEach((c) => allCodes.add(c));
    for (const p of data.programs)
      [p.ownerAirline, ...p.extraPartners].forEach((c) => allCodes.add(c));
    Object.values(data.aliases).forEach((c) => allCodes.add(c));

    // With every code "known", only structural errors remain.
    const report = validateCurated(data, allCodes);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("every Amex and Bilt partner resolves to a program", () => {
    const data = loadCurated();
    const ids = new Set(data.programs.map((p) => p.id));
    for (const c of data.currencies) for (const p of c.partners) expect(ids).toContain(p.program);
  });
});

describe("validateCurated", () => {
  const base: CuratedData = {
    alliances: [
      { id: "star", name: "Star", members: ["UA", "LH"] },
      { id: "oneworld", name: "oneworld", members: ["AA", "UA"] },
    ],
    programs: [
      {
        id: "united",
        name: "United",
        ownerAirline: "UA",
        allianceRule: "star",
        extraPartners: ["ZZ"],
        excluded: [],
        confidence: "high",
      },
    ],
    currencies: [
      { id: "bilt", name: "Bilt", partners: [{ program: "missing", ratio: 1, verified: true }] },
    ],
    aliases: {},
  };

  it("flags double alliance membership, unknown programs and unknown airlines", () => {
    const report = validateCurated(base, new Set(["UA", "LH", "AA"]));
    expect(report.errors).toContain("airline UA is in both star and oneworld");
    expect(report.errors).toContain("currency bilt: unknown program missing");
    expect(report.warnings).toEqual(["program united: airline ZZ not in airlines table"]);
  });
});
