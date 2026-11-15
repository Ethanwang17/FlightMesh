"use client";

import { parseAsArrayOf, parseAsBoolean, parseAsString, useQueryStates } from "nuqs";
import { useCallback, useMemo, useState } from "react";
import type { AllianceId, CurrencyId, NetworkFilters } from "@flightmesh/shared";
import { useSnapshot, useView } from "@/lib/useNetwork";
import { Filters } from "./Filters";
import { Legend } from "./Legend";
import { MapView } from "./MapView";
import { AirportPanel, RoutePanel } from "./Panels";
import { AirportSearch } from "./Search";

const list = parseAsArrayOf(parseAsString).withDefault([]);

export function FlightMesh() {
  const { snapshot: s, worker, error } = useSnapshot();
  const [q, setQ] = useQueryStates(
    {
      ap: parseAsString,
      to: parseAsString,
      cur: list,
      prog: list,
      al: list,
      airline: list,
      all: parseAsBoolean.withDefault(false),
    },
    { history: "replace" },
  );
  const [focus, setFocus] = useState<number | null>(null);

  const filters: NetworkFilters = useMemo(
    () => ({
      currencies: q.cur as CurrencyId[],
      programs: q.prog,
      alliances: q.al as AllianceId[],
      airlines: q.airline,
    }),
    [q.cur, q.prog, q.al, q.airline],
  );
  const view = useView(worker, { filters, airport: q.ap, to: q.to, showAll: q.all });

  const indexOf = useCallback(
    (code: string | null) => (s && code ? s.airports.code.indexOf(code) : -1),
    [s],
  );
  const selected = indexOf(q.ap);
  const target = indexOf(q.to);

  // With an airport open, clicking one of its destinations opens that route; otherwise a click
  // selects the airport. Clicking the open airport itself does nothing.
  const onPick = useCallback(
    (i: number | null) => {
      if (!s || i === null) return;
      const code = s.airports.code[i]!;
      if (code === q.ap) return;
      if (q.ap) void setQ({ to: code, all: false });
      else void setQ({ ap: code, to: null, all: false });
    },
    [s, q.ap, setQ],
  );

  if (error) return <div className="loading">Couldn&apos;t load route data: {error}</div>;
  if (!s) return <div className="loading">Loading routes…</div>;

  return (
    <div className="app">
      <MapView
        snapshot={s}
        counts={view?.counts ?? null}
        selected={selected >= 0 ? selected : null}
        target={target >= 0 ? target : null}
        destinations={view?.destinations ?? []}
        routing={view?.routing ?? null}
        focus={focus}
        onPick={onPick}
        onClear={() => void setQ({ ap: null, to: null, all: false })}
      />
      <Legend
        filtered={
          filters.currencies.length +
            filters.programs.length +
            filters.alliances.length +
            filters.airlines.length >
          0
        }
      />
      <aside className="sidebar">
        <div className="brand">
          FlightMesh
          <span>Nonstop routes, alliances and points programs</span>
        </div>
        <AirportSearch
          snapshot={s}
          placeholder={selected >= 0 ? "Route to… (airport or city)" : "Search airport or city"}
          onPick={(i) => {
            const code = s.airports.code[i]!;
            if (selected >= 0 && code !== q.ap) void setQ({ to: code });
            else void setQ({ ap: code, to: null });
            setFocus(i);
          }}
        />
        <Filters
          snapshot={s}
          filters={filters}
          onChange={(next) =>
            void setQ({
              ...(next.currencies && { cur: next.currencies }),
              ...(next.programs && { prog: next.programs }),
              ...(next.alliances && { al: next.alliances }),
              ...(next.airlines && { airline: next.airlines }),
            })
          }
        />
        {selected >= 0 && target >= 0 ? (
          <RoutePanel
            s={s}
            from={selected}
            to={target}
            routing={view?.routing ?? null}
            showAll={q.all}
            programsInPlay={view?.programs ?? []}
            onShowAll={(v) => void setQ({ all: v })}
            onBack={() => void setQ({ to: null, all: false })}
          />
        ) : selected >= 0 ? (
          <AirportPanel
            s={s}
            airport={selected}
            destinations={view?.destinations ?? []}
            programsInPlay={view?.programs ?? []}
            onRoute={(d) => void setQ({ to: s.airports.code[d]! })}
            onClose={() => void setQ({ ap: null, to: null })}
          />
        ) : (
          <section className="panel intro">
            <p>
              Click an airport to see where it flies nonstop. Then hover a destination to see its
              name, and click it (or search for any airport) to see nonstop and one-stop options.
            </p>
            <p className="muted small">
              Filter by Bilt, Amex or Chase points, loyalty program, alliance or airline.
              &quot;Potentially bookable&quot; means the program partners with that airline; it
              doesn&apos;t mean award seats are available.
            </p>
          </section>
        )}
        <footer className="attribution">
          Routes as of{" "}
          {new Date(s.generatedAt).toLocaleDateString("en-US", { dateStyle: "medium" })} ·{" "}
          {s.routes.o.length.toLocaleString("en-US")} directed routes. Data:{" "}
          <a href="https://en.wikipedia.org/" target="_blank" rel="noreferrer">
            Wikipedia
          </a>{" "}
          contributors (
          <a
            href="https://creativecommons.org/licenses/by-sa/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY-SA 4.0
          </a>
          ), Wikidata, OurAirports.
        </footer>
      </aside>
    </div>
  );
}
