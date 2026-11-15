import { describe, expect, it } from "vitest";
import type { Snapshot } from "@flightmesh/shared";
import { applyRenames, checkPublish, countsOf, diffRoutes, renamedAirlines } from "./publish";

/** Snapshot from "AAA>BBB:XX" strings; airports get countries from a small table. */
function snap(routes: string[], countries: Record<string, string> = {}): Snapshot {
  const airports: string[] = [];
  const airlines: string[] = [];
  const idx = (list: string[], v: string) =>
    list.includes(v) ? list.indexOf(v) : list.push(v) - 1;
  const o: number[] = [];
  const d: number[] = [];
  const al: number[] = [];
  for (const r of routes) {
    const cut = r.indexOf(":");
    const [pair, airline] = [r.slice(0, cut), r.slice(cut + 1)];
    const [a, b] = pair.split(">") as [string, string];
    o.push(idx(airports, a));
    d.push(idx(airports, b));
    al.push(idx(airlines, airline));
  }
  return {
    version: 1,
    generatedAt: "2026-11-13",
    license: "CC BY-SA 4.0",
    attribution: [],
    airports: {
      code: airports,
      name: airports,
      city: airports,
      country: airports.map((c) => countries[c] ?? "ZZ"),
      lat: airports.map(() => 0),
      lon: airports.map(() => 0),
    },
    airlines: { key: airlines, iata: airlines, name: airlines, alliance: airlines.map(() => null) },
    routes: { o, d, al, flags: o.map(() => 0) },
    alliances: [],
    programs: [],
    currencies: [],
  };
}

/** `n` routes from `hub` to distinct spokes on `airline`. */
const fan = (hub: string, n: number, airline = "XX", prefix = "S") =>
  Array.from({ length: n }, (_, i) => `${hub}>${prefix}${String(i).padStart(2, "0")}:${airline}`);

describe("checkPublish", () => {
  it("passes when there is no previous build", () => {
    expect(checkPublish(null, countsOf(snap(fan("HUB", 10))))).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it("fails on a global drop above 5%", () => {
    const prev = countsOf(
      snap([
        ...fan("AAA", 30, "XX", "A"),
        ...fan("BBB", 30, "YY", "B"),
        ...fan("CCC", 40, "ZZ", "C"),
      ]),
    );
    const next = countsOf(
      snap([
        ...fan("AAA", 30, "XX", "A"),
        ...fan("BBB", 30, "YY", "B"),
        ...fan("CCC", 30, "ZZ", "C"),
      ]),
    );
    const r = checkPublish(prev, next);
    expect(r.failures.some((f) => f.startsWith("directed routes: 100 → 90"))).toBe(true);
  });

  it("fails when one hub loses half its routes, even if the world barely moves", () => {
    const others = Array.from({ length: 20 }, (_, k) =>
      fan(`H${String(k).padStart(2, "0")}`, 50, `A${k}`, `X${k}`),
    ).flat();
    const prev = countsOf(snap([...others, ...fan("HUB", 60, "QQ")]));
    const next = countsOf(snap([...others, ...fan("HUB", 28, "QQ")]));
    const r = checkPublish(prev, next);
    expect(r.failures).toContain("airport HUB: 60 → 28 routes (−32, −53.3%)");
  });

  it("lets a small airport lose most of its routes", () => {
    const big = Array.from({ length: 20 }, (_, k) =>
      fan(`H${String(k).padStart(2, "0")}`, 50, `A${k}`, `X${k}`),
    ).flat();
    const prev = countsOf(snap([...big, ...fan("SML", 8, "QQ")]));
    const next = countsOf(snap([...big, ...fan("SML", 3, "QQ")]));
    expect(checkPublish(prev, next).failures).toEqual([]);
  });

  it("warns (not fails) on moderate losses, and fails when an existing airline suddenly doubles", () => {
    const base = Array.from({ length: 20 }, (_, k) =>
      fan(`H${String(k).padStart(2, "0")}`, 50, `A${k}`, `X${k}`),
    ).flat();
    const prev = countsOf(snap([...base, ...fan("HUB", 60, "QQ"), ...fan("ZZZ", 45, "MM", "M")]));
    const next = countsOf(
      snap([
        ...base,
        ...fan("HUB", 45, "QQ"),
        ...fan("ZZZ", 45, "MM", "M"),
        ...fan("YYY", 50, "MM", "N"),
      ]),
    );
    const r = checkPublish(prev, next);
    expect(r.warnings).toContain("airport HUB: 60 → 45 routes (−15, −25.0%)");
    expect(r.failures.some((f) => f.startsWith("airline MM: 45 → 95 routes (+50): doubled"))).toBe(
      true,
    );
  });
});

describe("diffRoutes", () => {
  it("lists added and removed directed routes", () => {
    const c = diffRoutes(snap(["AAA>BBB:XX", "BBB>AAA:XX"]), snap(["AAA>BBB:XX", "AAA>CCC:XX"]));
    expect(c).toEqual({ added: ["AAA→CCC XX"], removed: ["BBB→AAA XX"] });
  });
});

describe("renamedAirlines", () => {
  it("treats an airline that reappears under a new key as a rename, not a loss", () => {
    const base = Array.from({ length: 20 }, (_, k) =>
      fan(`H${String(k).padStart(2, "0")}`, 50, `A${k}`, `X${k}`),
    ).flat();
    const prevSnap = snap([...base, ...fan("HKG", 44, "wiki:Greater Bay Airlines")]);
    const nextSnap = snap([...base, ...fan("HKG", 44, "HB")]);
    const renames = renamedAirlines(prevSnap, nextSnap);
    expect([...renames]).toEqual([["wiki:Greater Bay Airlines", "HB"]]);
    const r = checkPublish(applyRenames(countsOf(prevSnap), renames), countsOf(nextSnap));
    expect(r.failures).toEqual([]);
  });

  it("does not call a real disappearance a rename", () => {
    const prevSnap = snap([...fan("AAA", 50, "XX"), ...fan("BBB", 10, "YY", "B")]);
    const nextSnap = snap([...fan("BBB", 10, "YY", "B"), ...fan("CCC", 50, "ZZ", "C")]);
    expect(renamedAirlines(prevSnap, nextSnap).size).toBe(0);
  });
});
