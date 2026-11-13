# FlightMesh: plan

## Context

FlightMesh is a personal take on flightconnections.com. It shows a world map with a dot for every airport. Clicking an airport draws its nonstop routes. You can filter by airline, alliance, loyalty program ("bookable with points") and bank currency (Bilt / Amex). It runs on Ethan's homelab behind their own domain. `/Users/ethan/Developer/Projects/FlightMesh` is empty, so everything is new.

**Decisions from the interview**

- Personal tool. Free data only. Hosted on the homelab with Docker Compose.
- Routes come from Wikipedia "Airlines and destinations" tables (CC BY-SA), refreshed weekly.
- A program filter means "routes on airlines where this program's miles can be redeemed."
- Programs: the Bilt and Amex transfer partners only, plus a bank-currency filter above them.
- v1 features: airport search, route details panel, 1-stop routing between two airports, shareable URLs.
- Flat 2D map with great-circle arcs.

## Architecture

pnpm monorepo, TypeScript throughout:

```
apps/web          Next.js (App Router): map UI + small API
packages/ingest   Data pipeline CLI (reference data, Wikipedia parsing, snapshot export)
packages/shared   Types, filter logic, routing logic (used by web + ingest + tests)
data/curated      Hand-maintained JSON: alliances, programs, currencies, airline aliases, route overrides
docker/           Dockerfiles + docker-compose.yml
```

**Data flow:** the ingest job writes to SQLite (`data/flightmesh.db`, the source of truth, with `first_seen`/`last_seen` per route). It then exports a compact snapshot, `snapshot.json` (about 4k airports and about 60k airline-route pairs, roughly 1–2 MB gzipped). The web app loads the snapshot once. All filtering and 1-stop search run **client-side** in a Web Worker, so filter toggles respond instantly and the server stays dumb.

**Map:** MapLibre GL JS with deck.gl overlays. A `ScatterplotLayer` draws airports, sized by route count. An `ArcLayer` with `greatCircle: true` draws routes, colored by alliance. The basemap starts on OpenFreeMap (free, no key). A later option is a self-hosted Protomaps `.pmtiles` file on the homelab.

## Data model

- `airports`: iata, icao, name, city, country, lat, lon, wikipedia_title, wikidata_id. Seeded from **OurAirports** (public domain), limited to airports with an IATA code and scheduled service.
- `airlines`: iata, icao, name, wikidata_id, alliance (from `alliances.json`).
- `routes`: origin, dest, airline_iata, seasonal (bool), source_page, first_seen, last_seen. Charter-only rows are dropped.
- `data/curated/programs.json`: `{ id, name, owner_airline, alliance_rule, extra_partners[], excluded[], notes }`. Bookable airlines = alliance members (if `alliance_rule`) + extras − exclusions.
- `data/curated/currencies.json`: `{ bilt: [{program, ratio}], amex: [...] }`.
- `data/curated/airline_aliases.json`: maps regional brands to their marketing airline (e.g. American Eagle → AA, KLM Cityhopper → KL, Delta Connection → DL).
- `data/curated/route_overrides.json`: manual add/remove when the Wikipedia data is wrong.

**Initial programs.** These are the Bilt and Amex transfer partners as I know them. **Re-verify against bilt.com and americanexpress.com during Phase 2**, because partner lists change.

- Bilt: Aer Lingus AerClub, Air Canada Aeroplan, Flying Blue, Atmos Rewards (Alaska/Hawaiian), American AAdvantage, Avianca LifeMiles, British Airways Club, Cathay Asia Miles, Emirates Skywards, Etihad Guest, Iberia Club, JAL Mileage Bank, Qatar Privilege Club, Southwest Rapid Rewards, TAP Miles&Go, Turkish Miles&Smiles, United MileagePlus, Virgin Atlantic Flying Club.
- Amex: Aer Lingus, Aeroméxico Rewards, Aeroplan, ANA Mileage Club, LifeMiles, British Airways, Asia Miles, Delta SkyMiles, Emirates, Etihad, Flying Blue, Iberia, JetBlue TrueBlue, Qantas Frequent Flyer, Qatar, Singapore KrisFlyer, Virgin Atlantic.

## Phases

### 1. Scaffold

- pnpm workspace, TS config, ESLint/Prettier, Vitest.
- Next.js app with a full-screen MapLibre map rendering.
- `packages/shared` with core types (`Airport`, `Route`, `Airline`, `Program`, `Filters`).

### 2. Reference data (`packages/ingest`)

- `ingest airports`: download the OurAirports `airports.csv` and load the airports that have an IATA code.
- `ingest wikidata`: one SPARQL query to Wikidata maps airport article titles to IATA (P238), and a second maps airline article titles to IATA/ICAO (P229/P230). These maps are how wikilinks in route tables resolve to codes.
- Write `alliances.json` (Star / oneworld / SkyTeam member IATA codes), `programs.json` and `currencies.json`.
- Use a generic User-Agent (no personal details) and cache all downloads under `data/cache/`.

### 3. Wikipedia route parser (the core risk)

- For each airport with a Wikipedia title, call the MediaWiki API (`action=parse&prop=text&section=<n>`) to fetch the "Airlines and destinations" → "Passenger" section. Rate-limit to about 1 request per second with retries, so a full run takes about 1 hour.
- Parse the table rows:
  - airline cell → wikilink → airline IATA (via the Wikidata map, then `airline_aliases.json`)
  - destination cell → wikilinks → airport IATA; text after a "Seasonal:" marker sets `seasonal=true`; rows or segments marked "Charter:" are dropped
  - strip footnote refs and handle "begins"/"ends <date>" annotations (keep a destination only if it is currently active)
- Unresolved links are logged to `data/reports/unresolved.csv` for alias fixes.
- Apply `route_overrides.json`, then upsert into SQLite and update `last_seen`. Routes not seen for 2 runs are marked inactive.
- Sanity report: the share of routes that have a matching reverse route (expect >90%), the top unresolved airlines, and the airports with zero routes.

### 4. Snapshot export

- `ingest export`: SQLite → `apps/web/public/data/snapshot.json`, using integer-indexed arrays for size. It includes airports, airlines, active routes, alliances, programs, currencies and a `generated_at` timestamp.
- The resolved "program → bookable airline set" is computed here, in `packages/shared/src/programs.ts`.

### 5. Map + airport interaction

- Load the snapshot and draw all airports as dots (zoom-aware radius, labels at higher zoom).
- Clicking an airport highlights it and draws arcs to each destination. Hovering an arc shows a tooltip.
- **Route details panel** (side drawer): destinations grouped by country or listed alphabetically, each with airline logos/codes, distance (haversine in `shared`) and a seasonal badge. Clicking a destination in the list pans to it.
- **Airport search:** a combobox that fuzzy-matches IATA, city and name (Fuse.js).

### 6. Filters + URL state

- A filter bar with four dimensions: **Currency** (Bilt/Amex) → **Program** → **Alliance** → **Airline**. Choices inside a dimension combine with OR; separate dimensions combine with AND.
- All filters resolve to an allowed-airline set (`shared/src/filters.ts`), and routes are filtered by `airline_iata ∈ allowed`. Airport dots dim when they have no matching routes.
- URL state is managed with `nuqs`, e.g. `?ap=AMS&cur=amex&prog=flyingblue&al=skyteam&airline=KL&to=JFK`.

### 7. 1-stop routing

- Pick an origin and a destination (from search or shift-click). Run in the Web Worker: nonstop routes, plus every hub H where O→H and H→D both pass the filter.
- Rank by total great-circle distance and compare against the direct distance (hide options with more than 1.5× detour by default; a toggle shows all).
- Show the results as arcs plus a list ("AMS → KEF → JFK · Icelandair / Icelandair · 1.08× detour").
- Each leg may use a different airline, as long as both pass the filters. Award bookings are judged program by program, so the list shows which selected programs cover both legs.

### 8. Deploy (homelab)

- `docker-compose.yml` with two services:
  - `web`: Next.js standalone build, serving the snapshot
  - `ingest`: the same repo image running a weekly cron (`ingest all && ingest export`), with a shared volume for `data/`
- The existing homelab reverse proxy handles TLS and the domain.
- The footer credits Wikipedia (CC BY-SA), OurAirports and Wikidata, and shows the snapshot date.

## Known limitations (accepted)

- Free data has no frequencies, aircraft types or schedules.
- Wikipedia tables have gaps and lag; overrides and the unresolved report keep this manageable.
- "Bookable" means the partner relationship exists. It does not mean award space is available.
- Codeshares are mostly ignored, because Wikipedia lists operating carriers.

## Verification

- **Parser unit tests** (Vitest) run on saved HTML fixtures for AMS, SEA, JFK, HNL and a small regional airport. They check seasonal parsing, charter exclusion, alias resolution and "begins/ends" handling.
- **Shared logic tests** cover filter resolution (e.g. Amex → Flying Blue → bookable on DL/KL/AF/…), 1-stop search on a toy graph, and haversine.
- **Data sanity:** run `ingest all` and review the sanity report (reverse-route ratio, unresolved list). Spot-check AMS, SEA and DOH against what you know.
- **End-to-end:** run `pnpm dev` and open the app in the browser pane. Click AMS and check that the arcs render. Apply Amex → Flying Blue and check that non-partner routes disappear. Search SEA→NRT and check that 1-stop options appear. Copy the URL, reload, and check that the same view returns.
- **Deploy check:** run `docker compose up` on the homelab, confirm the site loads on the domain, and trigger the ingest container once by hand.
