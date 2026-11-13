import { describe, expect, it } from "vitest";
import { haversineKm } from "./geo";

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm(52.31, 4.76, 52.31, 4.76)).toBe(0);
  });

  it("matches the known AMS–JFK distance (~5,850 km)", () => {
    const km = haversineKm(52.3086, 4.7639, 40.6398, -73.7789);
    expect(km).toBeGreaterThan(5800);
    expect(km).toBeLessThan(5900);
  });

  it("is symmetric", () => {
    expect(haversineKm(47.45, -122.31, 35.77, 140.39)).toBeCloseTo(
      haversineKm(35.77, 140.39, 47.45, -122.31),
      6,
    );
  });
});
