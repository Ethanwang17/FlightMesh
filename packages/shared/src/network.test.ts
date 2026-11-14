import { describe, expect, it } from "vitest";
import {
  buildIndex,
  destinationsFrom,
  findItineraries,
  NO_FILTERS,
  routeFilter,
  type NetworkFilters,
} from "./network";
import { RouteFlag, type Snapshot } from "./snapshot";
import type { Program } from "./types";

// Airports on a rough line so distances are predictable.
const AIRPORTS: Record<string, [number, number]> = {
  AAA: [0, 0],
  BBB: [0, 10],
  CCC: [0, 20],
  HUB: [1, 10],
  FAR: [40, 10],
};

const program = (id: string, owner: string, extra: Partial<Program> = {}): Program => ({
  id,
  name: id,
  ownerAirline: owner,
  alliance: null,
  partners: [],
  confidence: "high",
  sourceUrl: null,
  checkedAt: "2026-11-13",
  ...extra,
});

function snap(routes: [string, string, string, number?][]): Snapshot {
  const codes = Object.keys(AIRPORTS);
  const airlines = ["KL", "DL", "UX", "QQ", "wiki:Fly Oya"];
  return {
    version: 1,
    generatedAt: "2026-11-13",
    license: "CC BY-SA 4.0",
    attribution: [],
    airports: {
      code: codes,
      name: codes,
      city: codes,
      country: codes.map(() => "ZZ"),
      lat: codes.map((c) => AIRPORTS[c]![0]),
      lon: codes.map((c) => AIRPORTS[c]![1]),
    },
    airlines: {
      key: airlines,
      iata: ["KL", "DL", "UX", "QQ", null],
      name: airlines,
      alliance: ["skyteam", "skyteam", "skyteam", null, null],
    },
    routes: {
      o: routes.map((r) => codes.indexOf(r[0])),
      d: routes.map((r) => codes.indexOf(r[1])),
      al: routes.map((r) => airlines.indexOf(r[2])),
      flags: routes.map((r) => r[3] ?? 0),
    },
    alliances: [{ id: "skyteam", name: "SkyTeam", members: ["KL", "DL", "UX"] }],
    programs: [
      program("flyingblue", "KL", { alliance: { id: "skyteam", excludeMembers: [] } }),
      program("virgin", "VS", {
        alliance: { id: "skyteam", excludeMembers: ["DL"] },
        partners: [{ airline: "UX", redeem: true, earn: true, scope: "operated-only" }],
      }),
      program("solo", "QQ"),
    ],
    currencies: [
      {
        id: "amex",
        name: "Amex",
        sourceUrl: null,
        checkedAt: "2026-11-13",
        partners: [{ program: "flyingblue", ratio: 1, verified: true }],
      },
      {
        id: "bilt",
        name: "Bilt",
        sourceUrl: null,
        checkedAt: "2026-11-13",
        partners: [{ program: "solo", ratio: 1, verified: true }],
      },
    ],
  };
}

const f = (x: Partial<NetworkFilters>): NetworkFilters => ({ ...NO_FILTERS, ...x });
const code = (s: Snapshot, i: number) => s.airports.code[i];

describe("routeFilter", () => {
  const s = snap([
    ["AAA", "BBB", "KL"],
    ["AAA", "CCC", "DL"],
    ["AAA", "HUB", "QQ"],
    ["AAA", "FAR", "UX", RouteFlag.Brand],
    ["BBB", "AAA", "wiki:Fly Oya"],
  ]);
  const idx = buildIndex(s);
  const dests = (filters: NetworkFilters) =>
    destinationsFrom(idx, 0, routeFilter(idx, filters)).map((d) => code(s, d.dest));

  it("passes everything without filters", () => {
    expect(dests(NO_FILTERS).sort()).toEqual(["BBB", "CCC", "FAR", "HUB"]);
  });

  it("filters by currency through its programs", () => {
    expect(dests(f({ currencies: ["amex"] })).sort()).toEqual(["BBB", "CCC", "FAR"]);
    expect(dests(f({ currencies: ["bilt"] }))).toEqual(["HUB"]);
  });

  it("respects excluded alliance members and operated-only partners", () => {
    // virgin: SkyTeam minus DL; UX only on flights UX operates itself (the FAR route is a brand listing).
    expect(dests(f({ programs: ["virgin"] }))).toEqual(["BBB"]);
  });

  it("ANDs across dimensions and ORs within one", () => {
    expect(dests(f({ alliances: ["skyteam"], airlines: ["DL", "QQ"] }))).toEqual(["CCC"]);
    expect(dests(f({ airlines: ["KL", "QQ"] })).sort()).toEqual(["BBB", "HUB"]);
  });

  it("airlines without IATA codes appear unfiltered but never match a program", () => {
    const fromB = (filters: NetworkFilters) =>
      destinationsFrom(idx, 1, routeFilter(idx, filters)).length;
    expect(fromB(NO_FILTERS)).toBe(1);
    expect(fromB(f({ currencies: ["amex"] }))).toBe(0);
  });
});

describe("findItineraries (directed)", () => {
  it("a triangle A→B→C→A gives no A→C nonstop and never uses C→A", () => {
    const s = snap([
      ["AAA", "BBB", "KL"],
      ["BBB", "CCC", "KL"],
      ["CCC", "AAA", "KL"],
    ]);
    const idx = buildIndex(s);
    const all = routeFilter(idx, NO_FILTERS);
    const r = findItineraries(idx, 0, 2, all);
    expect(r.nonstop).toBeNull();
    expect(r.oneStop.map((o) => o.stops.map((i) => code(s, i)))).toEqual([["AAA", "BBB", "CCC"]]);
    const back = findItineraries(idx, 2, 0, all);
    expect(back.nonstop?.stops.map((i) => code(s, i))).toEqual(["CCC", "AAA"]);
    expect(findItineraries(idx, 1, 0, all).nonstop).toBeNull();
  });

  it("hides big detours and requires one program to cover both legs", () => {
    const s = snap([
      ["AAA", "HUB", "KL"],
      ["HUB", "CCC", "QQ"],
      ["AAA", "FAR", "KL"],
      ["FAR", "CCC", "KL"],
      ["AAA", "BBB", "KL"],
      ["BBB", "CCC", "DL"],
    ]);
    const idx = buildIndex(s);
    const all = routeFilter(idx, NO_FILTERS);
    const r = findItineraries(idx, 0, 2, all);
    expect(r.oneStop.map((o) => code(s, o.stops[1]!)).sort()).toEqual(["BBB", "HUB"]);
    expect(r.hidden).toBe(1);

    const amex = f({ currencies: ["amex"] });
    const withAmex = findItineraries(idx, 0, 2, routeFilter(idx, amex), {
      programs: ["flyingblue"],
    });
    expect(withAmex.oneStop.map((o) => [code(s, o.stops[1]!), o.programs])).toEqual([
      ["BBB", ["flyingblue"]],
    ]);
  });
});
