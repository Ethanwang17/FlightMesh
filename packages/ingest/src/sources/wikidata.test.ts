import { describe, expect, it } from "vitest";
import { parseAirlineBindings, parseAirportBindings, pickCanonicalAirlines } from "./wikidata";

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
    expect(out).toEqual([{ qid: "Q46033", iata: "FRA", title: "Frankfurt Airport" }]);
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
