import { describe, expect, it } from "vitest";
import type { ParsedDestination, ParsedRow } from "./parse";
import {
  collectEvidence,
  decideConflict,
  resolveAirline,
  resolveRoutes,
  titlesNeedingRedirects,
  type Evidence,
  type Lookups,
  type Overrides,
  type PageInput,
} from "./resolve";

const lookups: Lookups = {
  airlineByTitle: new Map([
    ["KLM", "KL"],
    ["KLM Cityhopper", "WA"],
    ["Air Algérie", "AH"],
    ["Lufthansa", "LH"],
  ]),
  airportByTitle: new Map([
    ["A Airport", "AAA"],
    ["B Airport", "BBB"],
    ["C Airport", "CCC"],
    ["Narita International Airport", "NRT"],
  ]),
  redirects: new Map([
    ["Tokyo–Narita", "Narita International Airport"],
    ["Air Algerie", "Air Algérie"],
  ]),
  aliases: { "KLM Cityhopper": "KL", "Fly Example": "FX" },
  airlineTitleByCode: new Map([["KL", "KLM"]]),
};

const today = new Date("2026-11-13T00:00:00Z");
const dest = (title: string, extra: Partial<ParsedDestination> = {}): ParsedDestination => ({
  title,
  text: title,
  mode: "scheduled",
  seasonal: false,
  charter: false,
  note: "",
  ...extra,
});
const row = (
  airline: string | null,
  destinations: ParsedDestination[],
  text = airline ?? "",
): ParsedRow => ({
  airlineTitle: airline,
  airlineText: text,
  destinations,
});
const page = (origin: string, rows: ParsedRow[], revTs = "2026-11-01T00:00:00Z"): PageInput => ({
  origin,
  revTs,
  rows,
});

/** Evidence + resolution in one go, with every given page counted as usable. */
function run(pages: PageInput[], opts: { usable?: string[]; overrides?: Partial<Overrides> } = {}) {
  const { evidence, unresolved } = collectEvidence(pages, lookups, today);
  const usable = new Set(opts.usable ?? pages.map((p) => p.origin));
  const overrides = {
    add: [],
    remove: [],
    suspended: [],
    movedAirports: [],
    closedAirports: [],
    ...opts.overrides,
  };
  return { ...resolveRoutes({ evidence, usablePages: usable, overrides, today }), unresolved };
}
const keys = (rs: { origin: string; dest: string; airline: string }[]) =>
  rs.map((r) => `${r.origin}>${r.dest}:${r.airline}`).sort();

describe("resolveAirline", () => {
  it("follows redirects, prefers aliases, and keeps airlines without IATA codes", () => {
    expect(resolveAirline("Air Algerie", "Air Algerie", lookups)).toMatchObject({
      key: "AH",
      iata: "AH",
    });
    expect(resolveAirline("KLM Cityhopper", "KLM Cityhopper", lookups)).toMatchObject({
      key: "KL",
      brand: true,
    });
    expect(resolveAirline("KLM", "KLM", lookups)).toMatchObject({ key: "KL", brand: false });
    expect(resolveAirline("Mystery Air", "Mystery Air", lookups)).toEqual({
      key: "wiki:Mystery Air",
      iata: null,
      title: "Mystery Air",
      brand: false,
    });
    expect(resolveAirline(null, "Fly Oya", lookups).key).toBe("name:Fly Oya");
    expect(resolveAirline("List of airlines of Iran", "Pars Air", lookups).key).toBe(
      "name:Pars Air",
    );
  });
});

describe("collectEvidence", () => {
  it("drops charters, self-loops and defunct airlines, and reports unknown airports", () => {
    const { evidence, unresolved, charter, defunct } = collectEvidence(
      [
        page("AAA", [
          row("KLM", [
            dest("B Airport", { mode: "charter", charter: true }),
            dest("A Airport"),
            dest("Atlantis"),
          ]),
          row("Lufthansa", [dest("B Airport")]),
        ]),
      ],
      lookups,
      today,
      { defunctTitles: new Set(["Lufthansa"]) },
    );
    expect(evidence.size).toBe(0);
    expect(charter).toBe(1);
    expect(defunct).toBe(1);
    expect(unresolved).toEqual([
      { kind: "airport", title: "Atlantis", text: "Atlantis", page: "AAA" },
    ]);
  });

  it("prefers a year-round current listing over a seasonal or suspended one", () => {
    const { evidence } = collectEvidence(
      [
        page("AAA", [
          row("KLM", [dest("B Airport", { note: "suspended" })]),
          row("KLM", [dest("B Airport", { seasonal: true, mode: "seasonal" })]),
          row("KLM", [dest("B Airport")]),
        ]),
      ],
      lookups,
      today,
    );
    expect(evidence.get("AAA|BBB|KL")).toMatchObject({ status: "current", seasonal: false });
  });
});

describe("resolveRoutes: no contradiction", () => {
  it("keeps directions separate: a one-way listing is not mirrored when the other page is usable", () => {
    const r = run(
      [
        page("AAA", [row("KLM", [dest("B Airport")])]),
        page("BBB", [row("KLM", [dest("C Airport")])]),
      ],
      {
        usable: ["AAA", "BBB", "CCC"],
      },
    );
    expect(keys(r.routes)).toEqual(["AAA>BBB:KL", "BBB>CCC:KL"]);
    expect(r.conflicts).toEqual([]);
  });

  it("infers the reverse direction only when that airport has no usable page", () => {
    const r = run([page("AAA", [row("KLM", [dest("B Airport")])])], { usable: ["AAA"] });
    expect(keys(r.routes)).toEqual(["AAA>BBB:KL", "BBB>AAA:KL"]);
    expect(r.routes.find((x) => x.origin === "BBB")?.basis).toBe("reverse_only");
  });

  it("never infers from a via listing, and a via listing is not a nonstop", () => {
    const r = run([page("AAA", [row("KLM", [dest("B Airport", { note: "via C" })])])], {
      usable: ["AAA"],
    });
    expect(r.routes).toEqual([]);
  });

  it("an airport's own suspended listing removes its direction only", () => {
    const r = run(
      [
        page("AAA", [row("KLM", [dest("B Airport", { note: "suspended" })])]),
        page("BBB", [row("KLM", [dest("C Airport")])]),
      ],
      { usable: ["AAA", "BBB", "CCC"] },
    );
    expect(keys(r.routes)).toEqual(["BBB>CCC:KL"]);
  });
});

describe("resolveRoutes: conflicts", () => {
  it("rule 2: a dated end on the other page beats an undated current listing, for both directions", () => {
    const r = run([
      page("AAA", [row("KLM", [dest("B Airport")])]),
      page("BBB", [row("KLM", [dest("A Airport", { note: "ended 1 October 2026" })])]),
    ]);
    expect(r.routes).toEqual([]);
    expect(r.conflicts).toMatchObject([
      { a: "AAA", b: "BBB", airline: "KL", verdict: "inactive", rule: "dated-other-side" },
    ]);
  });

  it("rule 2: a future start date on the other page means not flying yet", () => {
    const r = run([
      page("AAA", [row("KLM", [dest("B Airport")])]),
      page("BBB", [row("KLM", [dest("A Airport", { note: "begins June 2027" })])]),
    ]);
    expect(r.routes).toEqual([]);
    expect(r.conflicts[0]?.rule).toBe("dated-other-side");
  });

  it("rule 3: an undated suspension on a clearly fresher page wins", () => {
    const r = run([
      page("AAA", [row("KLM", [dest("B Airport")])], "2026-06-01T00:00:00Z"),
      page("BBB", [row("KLM", [dest("A Airport", { note: "suspended" })])], "2026-11-01T00:00:00Z"),
    ]);
    expect(r.routes).toEqual([]);
    expect(r.conflicts[0]).toMatchObject({ verdict: "inactive", rule: "fresher-page" });
  });

  it("rule 3: a fresher current listing wins, and both directions fly", () => {
    const r = run([
      page("AAA", [row("KLM", [dest("B Airport")])], "2026-11-01T00:00:00Z"),
      page("BBB", [row("KLM", [dest("A Airport", { note: "suspended" })])], "2026-06-01T00:00:00Z"),
    ]);
    expect(keys(r.routes)).toEqual(["AAA>BBB:KL", "BBB>AAA:KL"]);
    expect(r.routes.find((x) => x.origin === "BBB")).toMatchObject({
      basis: "resolved",
      conflict: "fresher-page",
    });
  });

  it("rule 3: pages edited within a week of each other stay current but are flagged unresolved", () => {
    const r = run([
      page("AAA", [row("KLM", [dest("B Airport")])], "2026-11-01T00:00:00Z"),
      page("BBB", [row("KLM", [dest("A Airport", { note: "suspended" })])], "2026-11-04T00:00:00Z"),
    ]);
    expect(keys(r.routes)).toEqual(["AAA>BBB:KL", "BBB>AAA:KL"]);
    expect(r.conflicts[0]).toMatchObject({ verdict: "active", rule: "unresolved" });
  });

  it("decideConflict: when both sides are dated, the later event wins", () => {
    const ev = (status: Evidence["status"], date: string | null): Evidence => ({
      status,
      date,
      note: "",
      seasonal: false,
      revTs: "2026-11-01T00:00:00Z",
      airline: { key: "KL", iata: "KL", title: "KLM", brand: false },
    });
    expect(decideConflict(ev("current", "2026-10-01"), ev("ended", "2026-09-01"))).toEqual({
      verdict: "active",
      rule: "later-date",
    });
    expect(decideConflict(ev("current", "2026-09-01"), ev("ended", "2026-10-01"))).toEqual({
      verdict: "inactive",
      rule: "later-date",
    });
  });
});

describe("resolveRoutes: overrides", () => {
  const pages = [page("AAA", [row("KLM", [dest("B Airport"), dest("C Airport")])])];

  it("rule 1: closed airports, removals and live suspensions drop routes; expired ones don't", () => {
    const r = run(pages, {
      usable: ["AAA", "BBB", "CCC"],
      overrides: {
        closedAirports: [{ iata: "CCC" }],
        suspended: [{ airline: "KL", airport: "BBB", until: "2026-01-01" }],
      },
    });
    expect(keys(r.routes)).toEqual(["AAA>BBB:KL"]);
    const r2 = run(pages, {
      usable: ["AAA", "BBB", "CCC"],
      overrides: { remove: [{ origin: "AAA", dest: "BBB" }] },
    });
    expect(keys(r2.routes)).toEqual(["AAA>CCC:KL"]);
  });

  it("rule 1: additions can be one-way or both ways", () => {
    const r = run([], {
      overrides: { add: [{ origin: "AAA", dest: "NRT", airline: "KL", bothWays: true }] },
    });
    expect(keys(r.routes)).toEqual(["AAA>NRT:KL", "NRT>AAA:KL"]);
    expect(r.routes.every((x) => x.basis === "override")).toBe(true);
  });
});

describe("titlesNeedingRedirects", () => {
  it("lists only titles not already known or aliased", () => {
    const titles = titlesNeedingRedirects(
      [
        row("Air Algerie", [dest("Tokyo–Narita"), dest("B Airport")]),
        row("KLM Cityhopper", [dest("B Airport")]),
      ],
      lookups,
    );
    expect(titles.sort()).toEqual(["Air Algerie", "Tokyo–Narita"]);
  });
});
