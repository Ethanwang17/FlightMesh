import { describe, expect, it } from "vitest";
import { pickDestinationsSection, type WikiSection } from "./sections";

const s = (index: string, toclevel: number, line: string): WikiSection => ({
  index,
  toclevel,
  line,
});

describe("pickDestinationsSection", () => {
  it("prefers the Passenger child (JFK layout)", () => {
    expect(
      pickDestinationsSection([
        s("43", 1, "History"),
        s("44", 1, "Airlines and destinations"),
        s("45", 2, "Passenger"),
        s("46", 2, "Cargo"),
        s("47", 1, "Statistics"),
        s("48", 2, "Passenger numbers"),
      ]),
    ).toBe("45");
  });

  it("falls back to the parent when there are no subsections (SFJ layout)", () => {
    expect(
      pickDestinationsSection([s("6", 1, "Airlines and destinations"), s("7", 1, "Statistics")]),
    ).toBe("6");
  });

  it("does not pick a later unrelated 'passenger' section (DOH layout)", () => {
    expect(
      pickDestinationsSection([
        s("11", 1, "Airlines and destinations"),
        s("13", 2, "Cargo"),
        s("17", 1, "Forced examinations of women passengers"),
      ]),
    ).toBe("11");
  });

  it("accepts '&' and nested levels, and returns null when absent", () => {
    expect(
      pickDestinationsSection([s("3", 2, "Airlines &amp; destinations"), s("4", 3, "Passenger")]),
    ).toBe("4");
    expect(pickDestinationsSection([s("1", 1, "History")])).toBeNull();
  });
});
