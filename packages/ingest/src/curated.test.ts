import { describe, expect, it } from "vitest";
import { loadCurated, validateCurated, type CuratedData } from "./curated";

describe("curated data files", () => {
  it("parse and cross-reference cleanly", () => {
    const data = loadCurated();
    const allCodes = new Set<string>();
    for (const a of data.alliances) a.members.forEach((c) => allCodes.add(c));
    for (const p of data.programs)
      [p.ownerAirline, ...p.partners.map((x) => x.airline)].forEach((c) => allCodes.add(c));
    Object.values(data.aliases).forEach((c) => allCodes.add(c));

    // With every code "known", only structural errors remain.
    const report = validateCurated(data, allCodes, new Date("2026-11-14T00:00:00Z"));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("Bilt no longer lists AAdvantage or Spirit, and every partner resolves to a program", () => {
    const data = loadCurated();
    const ids = new Set(data.programs.map((p) => p.id));
    for (const c of data.currencies) for (const p of c.partners) expect(ids).toContain(p.program);
    const bilt = data.currencies.find((c) => c.id === "bilt")!.partners.map((p) => p.program);
    expect(bilt).not.toContain("aadvantage");
    expect(bilt).not.toContain("spirit");
    expect(bilt).toHaveLength(18);
    expect(data.currencies.find((c) => c.id === "amex")!.partners).toHaveLength(16);
    const chase = data.currencies.find((c) => c.id === "chase")!.partners.map((p) => p.program);
    expect(chase).toHaveLength(10);
    expect(chase).not.toContain("skywards");
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
        alliance: { id: "star", excludeMembers: [] },
        partners: [{ airline: "ZZ", redeem: true, earn: true }],
        confidence: "high",
        sourceUrl: null,
        checkedAt: "2026-01-01",
      },
    ],
    currencies: [
      {
        id: "bilt",
        name: "Bilt",
        sourceUrl: null,
        checkedAt: "2026-11-01",
        partners: [{ program: "missing", ratio: 1, verified: true }],
      },
    ],
    aliases: {},
  };

  it("flags double alliance membership, unknown programs and unknown airlines", () => {
    const report = validateCurated(
      base,
      new Set(["UA", "LH", "AA"]),
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(report.errors).toContain("airline UA is in both star and oneworld");
    expect(report.errors).toContain("currency bilt: unknown program missing");
    expect(report.warnings).toEqual([
      "program united: airline ZZ not in airlines table",
      "program united: partner list last checked 2026-01-01 (316 days ago)",
    ]);
  });
});
