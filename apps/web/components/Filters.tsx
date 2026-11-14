"use client";

import { useMemo, useState } from "react";
import type { AllianceId, CurrencyId, NetworkFilters, Snapshot } from "@flightmesh/shared";

interface Props {
  snapshot: Snapshot;
  filters: NetworkFilters;
  onChange: (next: Partial<NetworkFilters>) => void;
}

const toggle = <T,>(list: T[], v: T) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

const ALLIANCES: [AllianceId, string][] = [
  ["star", "Star Alliance"],
  ["oneworld", "oneworld"],
  ["skyteam", "SkyTeam"],
];

export function Filters({ snapshot: s, filters: f, onChange }: Props) {
  const [airlineQuery, setAirlineQuery] = useState("");
  const programs = useMemo(() => [...s.programs].sort((a, b) => a.name.localeCompare(b.name)), [s]);
  const fromCurrencies = useMemo(
    () =>
      new Set(
        s.currencies
          .filter((c) => f.currencies.includes(c.id))
          .flatMap((c) => c.partners.map((p) => p.program)),
      ),
    [s, f.currencies],
  );
  const airlineOptions = useMemo(() => {
    const q = airlineQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return s.airlines.key
      .map((key, i) => ({ key, label: s.airlines.name[i]!, iata: s.airlines.iata[i] }))
      .filter(
        (a) =>
          !f.airlines.includes(a.key) &&
          (a.label.toLowerCase().includes(q) || a.iata?.toLowerCase() === q),
      )
      .slice(0, 8);
  }, [airlineQuery, s, f.airlines]);
  const airlineName = (key: string) => s.airlines.name[s.airlines.key.indexOf(key)] ?? key;
  const active = f.currencies.length + f.programs.length + f.alliances.length + f.airlines.length;

  return (
    <section className="filters" aria-label="Filters">
      <div className="filter-row">
        <span className="filter-label">Points</span>
        {s.currencies.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip ${f.currencies.includes(c.id) ? "on" : ""}`}
            aria-pressed={f.currencies.includes(c.id)}
            title={`${c.partners.length} airline transfer partners · checked ${c.checkedAt}`}
            onClick={() => onChange({ currencies: toggle(f.currencies, c.id as CurrencyId) })}
          >
            {c.name.replace(" Membership Rewards", "").replace(" Rewards", "")}
          </button>
        ))}
      </div>

      <details className="filter-row programs">
        <summary>
          <span className="filter-label">Programs</span>
          {f.programs.length ? `${f.programs.length} selected` : "Any"}
        </summary>
        <ul>
          {programs.map((p) => (
            <li key={p.id}>
              <label className={fromCurrencies.has(p.id) ? "via-currency" : ""}>
                <input
                  type="checkbox"
                  checked={f.programs.includes(p.id)}
                  onChange={() => onChange({ programs: toggle(f.programs, p.id) })}
                />
                {p.name}
                {p.confidence === "low" && (
                  <span
                    className="badge warn"
                    title="Partner list is best-effort; check the program's site"
                  >
                    unverified
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </details>

      <div className="filter-row">
        <span className="filter-label">Alliance</span>
        {ALLIANCES.map(([id, name]) => (
          <button
            key={id}
            type="button"
            className={`chip alliance-${id} ${f.alliances.includes(id) ? "on" : ""}`}
            aria-pressed={f.alliances.includes(id)}
            onClick={() => onChange({ alliances: toggle(f.alliances, id) })}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="filter-row airline-filter">
        <span className="filter-label">Airline</span>
        {f.airlines.map((key) => (
          <button
            key={key}
            type="button"
            className="chip on"
            onClick={() => onChange({ airlines: toggle(f.airlines, key) })}
          >
            {airlineName(key)} ×
          </button>
        ))}
        <div className="search small">
          <input
            type="search"
            value={airlineQuery}
            placeholder="Add airline…"
            aria-label="Add airline filter"
            onChange={(e) => setAirlineQuery(e.target.value)}
          />
          {airlineOptions.length > 0 && (
            <ul className="search-results">
              {airlineOptions.map((a) => (
                <li key={a.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ airlines: [...f.airlines, a.key] });
                      setAirlineQuery("");
                    }}
                  >
                    {a.iata && <b>{a.iata}</b>} {a.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {active > 0 && (
        <button
          type="button"
          className="link"
          onClick={() => onChange({ currencies: [], programs: [], alliances: [], airlines: [] })}
        >
          Clear filters
        </button>
      )}
    </section>
  );
}
