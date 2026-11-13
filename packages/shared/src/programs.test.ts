import { describe, expect, it } from "vitest";
import { bookableAirlines, currencyPrograms } from "./programs";
import type { Alliance, AllianceId, Program } from "./types";

const alliances = new Map<AllianceId, Alliance>([
  ["skyteam", { id: "skyteam", name: "SkyTeam", members: ["AF", "KL", "DL", "KE"] }],
]);

const flyingBlue: Program = {
  id: "flyingblue",
  name: "Flying Blue",
  ownerAirline: "AF",
  allianceRule: "skyteam",
  extraPartners: ["G3"],
  excluded: ["KE"],
  confidence: "medium",
};

describe("bookableAirlines", () => {
  it("combines owner, alliance members and extras, minus exclusions", () => {
    expect([...bookableAirlines(flyingBlue, alliances)].sort()).toEqual(["AF", "DL", "G3", "KL"]);
  });

  it("handles programs with no alliance", () => {
    const southwest: Program = {
      id: "southwest",
      name: "Rapid Rewards",
      ownerAirline: "WN",
      allianceRule: null,
      extraPartners: [],
      excluded: [],
      confidence: "high",
    };
    expect([...bookableAirlines(southwest, alliances)]).toEqual(["WN"]);
  });
});

describe("currencyPrograms", () => {
  it("lists the programs a currency transfers to", () => {
    expect(
      currencyPrograms({
        id: "amex",
        name: "Amex Membership Rewards",
        partners: [
          { program: "flyingblue", ratio: 1, verified: true },
          { program: "delta", ratio: 1, verified: true },
        ],
      }),
    ).toEqual(["flyingblue", "delta"]);
  });
});
