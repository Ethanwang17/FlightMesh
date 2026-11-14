"use client";

import { useState } from "react";
import { RouteFlag, type Itinerary, type RoutingResult, type Snapshot } from "@flightmesh/shared";
import type { DestinationView } from "@/lib/protocol";
import { airlineLabel, airportLabel, countryName, km } from "./format";

const programName = (s: Snapshot, id: string) => s.programs.find((p) => p.id === id)?.name ?? id;

function Airlines({ s, routes }: { s: Snapshot; routes: number[] }) {
  return (
    <span className="airlines">
      {routes.map((i) => {
        const al = s.routes.al[i]!;
        const brand = (s.routes.flags[i]! & RouteFlag.Brand) !== 0;
        return (
          <span
            key={i}
            className={`airline alliance-${s.airlines.alliance[al] ?? "none"}`}
            title={`${s.airlines.name[al]}${brand ? " (listed under a brand or subsidiary)" : ""}`}
          >
            {airlineLabel(s, al)}
          </span>
        );
      })}
    </span>
  );
}

function Bookable({ s, programs }: { s: Snapshot; programs: string[] }) {
  if (!programs.length) return null;
  return (
    <div className="bookable">
      Potentially bookable with {programs.map((p) => programName(s, p)).join(", ")}
    </div>
  );
}

export function AirportPanel(props: {
  s: Snapshot;
  airport: number;
  destinations: DestinationView[];
  programsInPlay: string[];
  onRoute: (dest: number) => void;
  onClose: () => void;
}) {
  const { s, airport, destinations } = props;
  const [sort, setSort] = useState<"distance" | "name">("distance");
  const list =
    sort === "name"
      ? [...destinations].sort((a, b) =>
          airportLabel(s, a.dest).localeCompare(airportLabel(s, b.dest)),
        )
      : destinations;
  const flagged = (d: DestinationView, flag: number) =>
    d.routes.every((i) => (s.routes.flags[i]! & flag) !== 0);

  return (
    <section className="panel" aria-label="Airport details">
      <header className="panel-head">
        <div>
          <h2>
            {s.airports.code[airport]} <span className="muted">{airportLabel(s, airport)}</span>
          </h2>
          <div className="muted small">
            {s.airports.name[airport]} · {countryName(s.airports.country[airport]!)}
          </div>
        </div>
        <button type="button" className="icon" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </header>
      <div className="panel-sub">
        <span>
          <b>{destinations.length}</b> nonstop destinations
        </span>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as "distance" | "name")}
          aria-label="Sort"
        >
          <option value="distance">Nearest first</option>
          <option value="name">A–Z</option>
        </select>
      </div>
      {props.programsInPlay.length > 0 && (
        <p className="note">
          Routes potentially bookable with your points programs. Award space is not guaranteed.
        </p>
      )}
      <ul className="dest-list">
        {list.map((d) => (
          <li key={d.dest}>
            <button type="button" onClick={() => props.onRoute(d.dest)}>
              <div className="dest-top">
                <span>
                  <b>{s.airports.code[d.dest]}</b> {airportLabel(s, d.dest)}
                  <span className="muted small"> {countryName(s.airports.country[d.dest]!)}</span>
                </span>
                <span className="muted small">{km(d.km)}</span>
              </div>
              <div className="dest-bottom">
                <Airlines s={s} routes={d.routes} />
                {d.seasonal && <span className="badge">Seasonal</span>}
                {!d.returns && (
                  <span className="badge" title="No return flight is listed on this airline">
                    One-way
                  </span>
                )}
                {flagged(d, RouteFlag.ReverseOnly) && (
                  <span
                    className="badge muted"
                    title="Known only from the other airport's Wikipedia page"
                  >
                    Other page
                  </span>
                )}
                {d.routes.some((i) => (s.routes.flags[i]! & RouteFlag.Conflict) !== 0) && (
                  <span
                    className="badge warn"
                    title="The two airports' pages disagreed; a rule decided"
                  >
                    Disputed
                  </span>
                )}
              </div>
              <Bookable s={s} programs={d.programs} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItineraryRow({ s, it }: { s: Snapshot; it: Itinerary }) {
  return (
    <li className="itinerary">
      <div className="dest-top">
        <span>
          {it.stops.map((a, k) => (
            <span key={k}>
              {k > 0 && " → "}
              <b>{s.airports.code[a]}</b>
            </span>
          ))}
          {it.stops.length === 3 && (
            <span className="muted small"> via {airportLabel(s, it.stops[1]!)}</span>
          )}
        </span>
        <span className="muted small">
          {km(it.km)}
          {it.detour > 1.005 && ` · ×${it.detour.toFixed(2)}`}
        </span>
      </div>
      {it.legs.map((leg, k) => (
        <div key={k} className="leg">
          <span className="muted small">
            {s.airports.code[it.stops[k]!]}–{s.airports.code[it.stops[k + 1]!]}
          </span>
          <Airlines s={s} routes={leg} />
        </div>
      ))}
      <Bookable s={s} programs={it.programs} />
    </li>
  );
}

export function RoutePanel(props: {
  s: Snapshot;
  from: number;
  to: number;
  routing: RoutingResult | null;
  showAll: boolean;
  programsInPlay: string[];
  onShowAll: (v: boolean) => void;
  onBack: () => void;
}) {
  const { s, from, to, routing } = props;
  return (
    <section className="panel" aria-label="Route options">
      <header className="panel-head">
        <div>
          <h2>
            {s.airports.code[from]} → {s.airports.code[to]}
          </h2>
          <div className="muted small">
            {airportLabel(s, from)} to {airportLabel(s, to)}
          </div>
        </div>
        <button type="button" className="icon" aria-label="Back" onClick={props.onBack}>
          ←
        </button>
      </header>
      {!routing ? (
        <p className="note">Finding routes…</p>
      ) : (
        <>
          <h3>Nonstop</h3>
          {routing.nonstop ? (
            <ul className="dest-list">
              <ItineraryRow s={s} it={routing.nonstop} />
            </ul>
          ) : (
            <p className="note">
              No nonstop flight in this direction
              {props.programsInPlay.length ? " with these filters" : ""}.
            </p>
          )}
          <h3>One stop ({routing.oneStop.length})</h3>
          {routing.oneStop.length === 0 && <p className="note">No one-stop connections found.</p>}
          <ul className="dest-list">
            {routing.oneStop.slice(0, 60).map((it) => (
              <ItineraryRow key={it.stops.join("-")} s={s} it={it} />
            ))}
          </ul>
          {(routing.hidden > 0 || props.showAll) && (
            <button type="button" className="link" onClick={() => props.onShowAll(!props.showAll)}>
              {props.showAll ? "Hide long detours" : `Show ${routing.hidden} longer detours`}
            </button>
          )}
          {props.programsInPlay.length > 0 && (
            <p className="note">
              One-stop options are shown only when one of your programs covers both legs. Award
              space is not guaranteed.
            </p>
          )}
        </>
      )}
    </section>
  );
}
