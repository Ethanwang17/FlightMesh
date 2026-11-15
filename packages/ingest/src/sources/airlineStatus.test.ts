import { describe, expect, it } from "vitest";
import { canAdoptCode, infoboxCodes, judgeAirline } from "./airlineStatus";

const today = new Date("2026-11-13T00:00:00Z");
const infobox = (rows: string) => `<table class="infobox">${rows}</table>`;
const p = (text: string) => `<p>${text}</p>`;

describe("judgeAirline", () => {
  it("flags a past 'Ceased operations' date", () => {
    const j = judgeAirline(
      { html: infobox("<tr><th>Ceased operations</th><td>2 May 2026</td></tr>"), categories: [] },
      today,
    );
    expect(j).toEqual({ defunct: true, ceased: "2 May 2026" });
  });

  it("does not flag a future ceasing date", () => {
    const j = judgeAirline(
      {
        html: infobox("<tr><th>Ceased operations</th><td>31 March 2027 (planned)</td></tr>"),
        categories: [],
      },
      today,
    );
    expect(j.defunct).toBe(false);
  });

  it("flags a defunct-category airline written in the past tense", () => {
    const html = p(
      "Fly540 was a low-cost airline based in Nairobi, Kenya, that operated domestic and regional flights.",
    );
    expect(judgeAirline({ html, categories: ["Defunct airlines of Kenya"] }, today).defunct).toBe(
      true,
    );
  });

  it("does not flag an operating airline, even in a defunct-related category", () => {
    const html = p(
      "KLM Royal Dutch Airlines is the flag carrier airline of the Netherlands, headquartered in Amstelveen.",
    );
    expect(
      judgeAirline({ html, categories: ["Defunct airlines of the Netherlands"] }, today).defunct,
    ).toBe(false);
    expect(judgeAirline({ html, categories: [] }, today).defunct).toBe(false);
  });
});

const codesTable = (iata: string, icao: string) =>
  `<table class="infobox"><tr><td><table class="infobox-airline-codes"><tbody>
   <tr><th><a href="/wiki/Airline_codes">IATA</a></th><th>ICAO</th><th>Call sign</th></tr>
   <tr><td class="nickname">${iata}</td><td class="nickname">${icao}</td><td>PROSPER</td></tr>
   </tbody></table></td></tr></table>`;

describe("infoboxCodes", () => {
  it("reads IATA and ICAO from the codes table", () => {
    expect(infoboxCodes(codesTable("IU ", "SJV"))).toEqual({ iata: "IU", icao: "SJV" });
  });

  it("ignores footnotes, dashes and missing tables", () => {
    expect(infoboxCodes(codesTable("XE<sup>[1]</sup>", "JSX"))).toEqual({
      iata: "XE",
      icao: "JSX",
    });
    expect(infoboxCodes(codesTable("—", "ABC"))).toEqual({ iata: null, icao: "ABC" });
    expect(infoboxCodes("<p>No infobox</p>")).toEqual({ iata: null, icao: null });
  });
});

describe("canAdoptCode", () => {
  it("adopts codes nobody else holds, and brands of the same group", () => {
    expect(canAdoptCode("Super Air Jet", "IU", undefined)).toBe(true);
    expect(canAdoptCode("LATAM Chile", "LA", "LATAM Airlines")).toBe(true);
  });

  it("refuses a code held by an unrelated airline", () => {
    expect(canAdoptCode("Island Air Service", "WP", "Wings Pacific")).toBe(false);
    expect(canAdoptCode("Air Kiribati", "IK", "Air Bagan")).toBe(false);
  });
});
