/**
 * Airport size tiers, by number of nonstop destinations (after the active filters).
 * Shared by the map dots and the legend so the two never drift apart.
 */
export type RGB = [number, number, number];

export interface AirportTier {
  /** Smallest destination count in this tier. */
  min: number;
  label: string;
  color: RGB;
  /** Dot radius in pixels. */
  radius: number;
}

export const AIRPORT_TIERS: readonly AirportTier[] = [
  { min: 101, label: "> 100 non-stop destinations", color: [12, 52, 128], radius: 8 },
  { min: 31, label: "> 30 non-stop destinations", color: [30, 136, 255], radius: 6 },
  { min: 8, label: "> 7 non-stop destinations", color: [247, 193, 22], radius: 4.5 },
  { min: 1, label: "7 or fewer non-stop destinations", color: [231, 92, 62], radius: 3 },
];

/** The tier for a destination count, or null for airports with no matching routes. */
export function tierOf(count: number): AirportTier | null {
  return AIRPORT_TIERS.find((t) => count >= t.min) ?? null;
}

/** A darker shade for the dot outline, like the legend swatches. */
export const outlineOf = ([r, g, b]: RGB): RGB => [
  Math.round(r * 0.55),
  Math.round(g * 0.55),
  Math.round(b * 0.55),
];

export const cssColor = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;
