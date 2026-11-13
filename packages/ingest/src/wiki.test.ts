import { describe, expect, it } from "vitest";
import { normalizeTitle, titleFromWikipediaUrl } from "./wiki";

describe("wiki titles", () => {
  it("normalizes underscores, anchors and first-letter case", () => {
    expect(normalizeTitle("john_F._Kennedy_International_Airport#History")).toBe(
      "John F. Kennedy International Airport",
    );
  });

  it("extracts titles only from English Wikipedia URLs", () => {
    expect(titleFromWikipediaUrl("https://en.wikipedia.org/wiki/Heathrow_Airport")).toBe(
      "Heathrow Airport",
    );
    expect(titleFromWikipediaUrl("https://de.wikipedia.org/wiki/Flughafen_Frankfurt")).toBeNull();
    expect(titleFromWikipediaUrl("")).toBeNull();
  });
});
