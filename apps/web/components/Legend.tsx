"use client";

import { useState } from "react";
import { AIRPORT_TIERS, cssColor, outlineOf } from "./tiers";

const STORAGE_KEY = "flightmesh.legend.hidden";

/** Airport size legend. Dismissible; the choice is remembered in this browser. */
export function Legend({ filtered }: { filtered: boolean }) {
  // Rendered only in the browser (after the route data loads), so storage is safe to read here.
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false; // Storage unavailable (private mode): just show the legend.
    }
  });

  const set = (value: boolean) => {
    setHidden(value);
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Ignore: the legend still toggles for this visit.
    }
  };

  if (hidden) {
    return (
      <button
        type="button"
        className="legend-toggle"
        onClick={() => set(false)}
        aria-label="Show airport legend"
      >
        Legend
      </button>
    );
  }

  return (
    <section className="legend" aria-label="Airport legend">
      <header>
        <h2>Airport legend</h2>
        <button
          type="button"
          className="legend-close"
          onClick={() => set(true)}
          aria-label="Hide airport legend"
        >
          ×
        </button>
      </header>
      <ul>
        {AIRPORT_TIERS.map((t) => {
          const size = t.radius * 2 + 2;
          return (
            <li key={t.min}>
              <span className="legend-swatch-box">
                <span
                  className="legend-swatch"
                  style={{
                    width: size,
                    height: size,
                    background: cssColor(t.color),
                    borderColor: cssColor(outlineOf(t.color)),
                  }}
                />
              </span>
              {t.label}
            </li>
          );
        })}
      </ul>
      {filtered && <p className="legend-note">Counts include only routes matching your filters.</p>}
    </section>
  );
}
