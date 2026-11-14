import { describe, expect, it } from "vitest";
import { destinationCount, guardTrips } from "./routes";

describe("page guard", () => {
  it("keeps the previous listings when a page suddenly loses most destinations", () => {
    expect(guardTrips(40, 0)).toBe(true);
    expect(guardTrips(40, 19)).toBe(true);
  });

  it("accepts normal edits, growth, and small pages shrinking", () => {
    expect(guardTrips(40, 20)).toBe(false);
    expect(guardTrips(40, 60)).toBe(false);
    expect(guardTrips(4, 0)).toBe(false);
    expect(guardTrips(0, 30)).toBe(false);
  });

  it("counts destinations across rows", () => {
    const d = {
      title: "A",
      text: "A",
      mode: "scheduled" as const,
      seasonal: false,
      charter: false,
      note: "",
    };
    expect(
      destinationCount([
        { airlineTitle: "X", airlineText: "X", destinations: [d, d] },
        { airlineTitle: null, airlineText: "Y", destinations: [d] },
      ]),
    ).toBe(3);
  });
});
