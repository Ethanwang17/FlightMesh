"use client";

import Fuse from "fuse.js";
import { useMemo, useState } from "react";
import type { Snapshot } from "@flightmesh/shared";
import { countryName } from "./format";

interface Props {
  snapshot: Snapshot;
  placeholder: string;
  onPick: (airport: number) => void;
}

/** Airport search: exact IATA code first, then fuzzy matches on code, city and name. */
export function AirportSearch({ snapshot: s, placeholder, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const fuse = useMemo(
    () =>
      new Fuse(
        s.airports.code.map((code, i) => ({
          i,
          code,
          city: s.airports.city[i]!,
          name: s.airports.name[i]!,
        })),
        {
          keys: [
            { name: "code", weight: 3 },
            { name: "city", weight: 2 },
            { name: "name", weight: 1 },
          ],
          threshold: 0.3,
        },
      ),
    [s],
  );
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const exact = s.airports.code.indexOf(q.toUpperCase());
    const fuzzy = fuse.search(q, { limit: 8 }).map((r) => r.item.i);
    return [...new Set([...(exact >= 0 ? [exact] : []), ...fuzzy])].slice(0, 8);
  }, [query, fuse, s]);

  const pick = (i: number) => {
    onPick(i);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="search">
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0] !== undefined) pick(results[0]);
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((i) => (
            <li key={i}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <b>{s.airports.code[i]}</b> {s.airports.city[i] || s.airports.name[i]}
                <span className="muted">
                  {" "}
                  · {s.airports.name[i]}, {countryName(s.airports.country[i]!)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
