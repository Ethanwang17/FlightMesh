import { describe, expect, it } from "vitest";
import { classifyNote, parseLooseDate } from "./dates";

const today = new Date("2026-11-13T00:00:00Z");

describe("parseLooseDate", () => {
  it.each([
    ["27 October 2026", "2026-10-27"],
    ["June 10, 2027", "2027-06-10"],
    ["Sept 3, 2027", "2027-09-03"],
    ["3rd March 2027", "2027-03-03"],
    ["late March 2027", "2027-03-01"],
    ["summer 2027", "2027-01-01"],
    ["2027", "2027-01-01"],
  ])("%s → %s", (text, iso) => {
    expect(parseLooseDate(text)?.toISOString().slice(0, 10)).toBe(iso);
  });

  it("returns null when there is no year", () => {
    expect(parseLooseDate("TBA")).toBeNull();
  });
});

describe("classifyNote", () => {
  const c = (note: string, mode: "scheduled" | "seasonal" = "scheduled") =>
    classifyNote(note, mode, today);

  it("treats an empty note as current", () => {
    expect(c("")).toEqual({ status: "current", date: null });
  });

  it("begins: current once the date passes; future or undated is not yet flying", () => {
    expect(c("begins 27 October 2026")).toEqual({ status: "current", date: "2026-10-27" });
    expect(c("begins June 10, 2027").status).toBe("future");
    expect(c("commences TBA").status).toBe("future");
    expect(c("launches 1 April 2027").status).toBe("future");
  });

  it("resumes: seasonal routes stay current; paused year-round routes are resuming", () => {
    expect(c("resumes June 1, 2027", "seasonal").status).toBe("current");
    expect(c("resumes June 1, 2027").status).toBe("resuming");
    expect(c("returns 1 November 2026").status).toBe("current");
  });

  it("ends: current until the date passes", () => {
    expect(c("ends November 30, 2026")).toEqual({ status: "current", date: "2026-11-30" });
    expect(c("ends October 1, 2026")).toEqual({ status: "ended", date: "2026-10-01" });
    expect(c("terminated 2025").status).toBe("ended");
    expect(c("until 31 March 2027").status).toBe("current");
  });

  it("suspended, cancelled and via", () => {
    expect(c("suspended").status).toBe("suspended");
    expect(c("service cancelled").status).toBe("suspended");
    expect(c("via Muscat").status).toBe("via");
  });
});
