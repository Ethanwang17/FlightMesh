import { describe, expect, it } from "vitest";
import {
  chooseAirportTitles,
  dissolvedAirlineTitles,
  parseAirlineBindings,
  parseAirportBindings,
  pickCanonicalAirlines,
  type WikidataAirport,
} from "./wikidata";

const v = (value: string) => ({ value });
const entity = (q: string) => v(`http://www.wikidata.org/entity/${q}`);
const wiki = (t: string) => v(`https://en.wikipedia.org/wiki/${t}`);

describe("parseAirportBindings", () => {
  it("keeps valid 3-letter codes with English articles", () => {
    const out = parseAirportBindings([
      { item: entity("Q46033"), iata: v("FRA"), article: wiki("Frankfurt_Airport") },
      { item: entity("Q1"), iata: v("XX"), article: wiki("Bad") },
      { item: entity("Q2"), iata: v("ABC") },
    ]);
    expect(out).toEqual([{ qid: "Q46033", iata: "FRA", icao: null, title: "Frankfurt Airport" }]);
  });
});

describe("airline parsing", () => {
  const rows = [
    // KLM: two rows because of the label/ICAO join; collapses to one.
    {
      item: entity("Q181912"),
      iata: v("KL"),
      icao: v("KLM"),
      itemLabel: v("KLM"),
      article: wiki("KLM"),
      sitelinks: v("90"),
    },
    {
      item: entity("Q181912"),
      iata: v("KL"),
      icao: v("KLM"),
      itemLabel: v("KLM"),
      article: wiki("KLM"),
      sitelinks: v("90"),
    },
    // KLM Cityhopper flies under KL too but has fewer sitelinks.
    {
      item: entity("Q1312596"),
      iata: v("WA"),
      icao: v("KLC"),
      itemLabel: v("KLM Cityhopper"),
      article: wiki("KLM_Cityhopper"),
      sitelinks: v("30"),
    },
    {
      item: entity("Q999"),
      iata: v("KL"),
      itemLabel: v("KLM regional brand"),
      article: wiki("KLM_Regional"),
      sitelinks: v("3"),
    },
    // Defunct airline that used to hold a reused code: dropped.
    {
      item: entity("Q122215"),
      iata: v("L3"),
      icao: v("LTO"),
      itemLabel: v("LTU Austria"),
      article: wiki("LTU_Austria"),
      sitelinks: v("6"),
      dissolved: v("2006-01-01T00:00:00Z"),
    },
    { item: entity("Q555"), iata: v("L3"), itemLabel: v("Current L3"), sitelinks: v("2") },
  ];

  const airlines = parseAirlineBindings(rows);
  const canonical = pickCanonicalAirlines(airlines);

  it("collapses duplicate rows and drops defunct airlines", () => {
    expect(airlines.map((a) => a.qid).sort()).toEqual(["Q1312596", "Q181912", "Q555", "Q999"]);
  });

  it("picks the most-linked active airline per code", () => {
    expect(canonical.get("KL")?.name).toBe("KLM");
    expect(canonical.get("L3")?.name).toBe("Current L3");
  });
});

describe("chooseAirportTitles", () => {
  const wd = (qid: string, iata: string, icao: string | null, title: string): WikidataAirport => ({
    qid,
    iata,
    icao,
    title,
  });

  it("keeps OurAirports' title when Wikidata agrees, and maps every agreeing title", () => {
    const c = chooseAirportTitles(
      [{ iata: "SEA", icao: "KSEA", title: "Seattle–Tacoma International Airport" }],
      [wd("Q1", "SEA", "KSEA", "Seattle–Tacoma International Airport")],
    );
    expect(c.pageTitle.get("SEA")).toEqual({
      title: "Seattle–Tacoma International Airport",
      qid: "Q1",
    });
  });

  it("prefers the Wikidata item whose ICAO matches when OurAirports links a redirect", () => {
    const c = chooseAirportTitles(
      [{ iata: "LIH", icao: "PHLI", title: "Lihu'e Airport" }],
      [wd("Q2", "LIH", "PHLI", "Lihue Airport")],
    );
    expect(c.pageTitle.get("LIH")?.title).toBe("Lihue Airport");
    expect(c.titles.get("Lihue Airport")).toBe("LIH");
    expect(c.titles.get("Lihu'e Airport")).toBe("LIH");
  });

  it("rejects a Wikidata item whose ICAO disagrees, and military fields sharing the code", () => {
    const c = chooseAirportTitles(
      [{ iata: "LSE", icao: "KLSE", title: "La Crosse Regional Airport" }],
      [
        wd("Q3", "LSE", "WAXX", "Some Indonesian Airstrip"),
        wd("Q4", "LSE", null, "La Crosse Air Force Base"),
      ],
    );
    expect(c.pageTitle.get("LSE")?.title).toBe("La Crosse Regional Airport");
    expect(c.titles.has("Some Indonesian Airstrip")).toBe(false);
    expect(c.titles.has("La Crosse Air Force Base")).toBe(false);
  });

  it("drops titles claimed by two airports from link resolution", () => {
    const c = chooseAirportTitles(
      [
        { iata: "AAA", icao: null, title: "Shared Airport" },
        { iata: "BBB", icao: null, title: "Shared Airport" },
      ],
      [],
    );
    expect(c.titles.has("Shared Airport")).toBe(false);
  });
});

describe("dissolvedAirlineTitles", () => {
  it("lists articles of dissolved airlines", () => {
    expect([
      ...dissolvedAirlineTitles([
        {
          item: entity("Q1"),
          article: wiki("Spirit_Airlines"),
          dissolved: v("2026-05-02T00:00:00Z"),
        },
        { item: entity("Q2"), article: wiki("KLM") },
      ]),
    ]).toEqual(["Spirit Airlines"]);
  });
});
