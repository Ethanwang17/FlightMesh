import { describe, expect, it } from "vitest";
import { judgeAirline } from "./airlineStatus";

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
