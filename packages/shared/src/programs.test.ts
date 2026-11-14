import { describe, expect, it } from "vitest";
import { bookableAirlines, currencyPrograms, daysSince, isBookable } from "./programs";
import type { Alliance, AllianceId, Program } from "./types";

const alliances = new Map<AllianceId, Alliance>([
  ["skyteam", { id: "skyteam", name: "SkyTeam", members: ["AF", "KL", "DL", "KE", "MU", "UX"] }],
]);

const program = (extra: Partial<Program>): Program => ({
  id: "x",
  name: "X",
  ownerAirline: "VS",
  alliance: null,
  partners: [],
  confidence: "medium",
  sourceUrl: null,
  checkedAt: "2026-11-13",
  ...extra,
});

describe("bookableAirlines", () => {
  it("combines owner, alliance members and redeemable partners, minus excluded members", () => {
    const b = bookableAirlines(
      program({
        alliance: { id: "skyteam", excludeMembers: ["MU"] },
        partners: [{ airline: "NH", redeem: true, earn: true }],
      }),
      alliances,
    );
    expect([...b.airlines].sort()).toEqual(["AF", "DL", "KE", "KL", "NH", "UX", "VS"]);
  });

  it("never counts earn-only partners, even alliance members", () => {
    const b = bookableAirlines(
      program({
        alliance: { id: "skyteam", excludeMembers: [] },
        partners: [
          { airline: "PR", redeem: false, earn: true },
          { airline: "KE", redeem: false, earn: true },
        ],
      }),
      alliances,
    );
    expect(b.airlines.has("PR")).toBe(false);
    expect(b.airlines.has("KE")).toBe(false);
  });

  it("limits operated-only partners to routes the airline operates itself", () => {
    const b = bookableAirlines(
      program({ partners: [{ airline: "UX", redeem: true, earn: true, scope: "operated-only" }] }),
      alliances,
    );
    expect(isBookable(b, "UX", false)).toBe(true);
    expect(isBookable(b, "UX", true)).toBe(false);
    expect(isBookable(b, "VS", true)).toBe(true);
  });

  it("handles programs with no alliance and no partners", () => {
    const b = bookableAirlines(program({ ownerAirline: "WN" }), alliances);
    expect([...b.airlines]).toEqual(["WN"]);
  });
});

describe("currencyPrograms and daysSince", () => {
  it("lists the programs a currency transfers to", () => {
    expect(
      currencyPrograms({
        id: "amex",
        name: "Amex Membership Rewards",
        sourceUrl: null,
        checkedAt: "2026-11-13",
        partners: [
          { program: "flyingblue", ratio: 1, verified: true },
          { program: "delta", ratio: 1, verified: true },
        ],
      }),
    ).toEqual(["flyingblue", "delta"]);
  });

  it("counts days since a check", () => {
    expect(daysSince("2026-07-01", new Date("2026-11-13T12:00:00Z"))).toBe(135);
  });
});
