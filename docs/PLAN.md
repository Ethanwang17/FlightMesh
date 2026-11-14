# FlightMesh: plan

_Revised 2026-11-13 after the data-source review in [DATA-SOURCES.md](DATA-SOURCES.md), then again after review feedback (conflicts, direction, publish checks, award rules, simplicity). Changes from the first version are marked **(rev)**._

## Context

FlightMesh is a personal take on flightconnections.com. It shows a world map with a dot for every airport. Clicking an airport draws its nonstop routes. You can filter by airline, alliance, loyalty program ("potentially bookable with points") and bank currency (Bilt / Amex). It runs on Ethan's homelab behind their own domain.

**Decisions (unchanged)**

- Personal tool. Free data only. Hosted on the homelab with Docker Compose.
- Next.js + TypeScript pnpm monorepo. MapLibre GL + deck.gl. SQLite for ingestion. A compact JSON snapshot. Client-side filtering and 1-stop routing in a Web Worker.
- A program filter means "routes on airlines where this program's miles can be **redeemed**". It never claims award space.
- Programs: the Bilt and Amex airline transfer partners, plus a bank-currency filter above them.
- v1 features: airport search, route details panel, 1-stop routing, shareable URLs. Flat 2D map with great-circle arcs.

**Data strategy (rev).** Wikipedia "Airlines and destinations" tables stay the **only source that creates routes**. The review found no free, current, global, airline-level alternative: Jonty/FlightsFrom has no license and is broken, OpenFlights stopped in 2014, AirportMiles and government data are historical and mostly lack airlines, and VRS is observed callsigns. What changes is _how_ we use Wikipedia, borrowing techniques Flight Atlas (`tjaffee99/flights`) has proven in production:

- **Use both ends, keep direction.** Each airport page describes its own departures, so a listing is a **directed** edge `origin → dest` for an airline. The other airport's page is supporting or contradicting evidence, resolved by explicit rules (see [Conflict resolution](#conflict-resolution)), never "either side wins".
- **Incremental, revision-based fetching** instead of re-downloading every page.
- **Non-destructive updates.** A per-page guard plus a run-level publish gate replace "inactive after 2 missed runs".
- **Defunct-airline detection** from airline articles.
- **Overrides that expire** on their own.

Source hierarchy: curated overrides > Wikipedia listings (own page first, other end as evidence) > nothing. OurAirports + Wikidata provide identity only. Statistics sources may _annotate_ later, but never add routes in v1.

## Architecture

```
apps/web          Next.js (App Router): map UI
packages/ingest   Data pipeline CLI (reference data, Wikipedia fetch/parse, merge, gate, export)
packages/shared   Types, program/filter logic, routing logic (used by web + ingest + tests)
data/curated      Hand-maintained JSON: alliances, programs, currencies, airline aliases, overrides
docker/           Dockerfiles + docker-compose.yml
```

**Data flow (rev):**

```
OurAirports + Wikidata ──► airports / airlines / wiki_titles
Wikipedia revision IDs ──► changed pages only ──► parse ──► page guard ──► listings (per page, per revid)
listings + reverse-side evidence + airline status + overrides ──► directed routes (origin → dest, airline) + conflicts
routes ──► publish checks (global + per airport/airline/country) ──► snapshot.json + changes report
```

The snapshot holds about 4k airports and about 60–70k directed airline routes, roughly 1–2 MB gzipped (Flight Atlas's equivalent file is 2.5 MB raw). The web app loads it once. Filtering and 1-stop search run in a Web Worker.

**Map:** MapLibre GL JS with deck.gl. A `ScatterplotLayer` draws airports and an `ArcLayer` with `greatCircle: true` draws routes. The basemap is OpenFreeMap.

## Data model (rev)

- `airports`: every OurAirports row with an IATA code **(rev: not only `scheduled_service=yes`, a flag that proved unreliable)**. The Wikipedia title is chosen Wikidata-first, with an ICAO tie-break, a military-field filter, and the code accepted only if OurAirports agrees.
- `airlines`: internal key = canonical Wikipedia title (or Wikidata QID), plus `iata`, `icao`, `name`, `alliance`, `defunct`, `ceased_on` **(rev: airlines without IATA codes are kept)**.
- `pages`: `iata, title, revid, fetched_at, status, rows, error`. Drives incremental fetching.
- `listings` **(rev, new)**: raw rows `(page_iata, revid, airline_key, dest_iata, mode: scheduled|seasonal|charter|seasonal_charter, status: current|future|resuming|suspended|ended|via, note)`. Replaced per page only when a new revision passes the page guard.
- `routes` **(rev, derived)**: **directed** `(origin, dest, airline_key)`, `seasonal`, `basis: own_page | reverse_only | override`, `conflict` flag, `first_seen`, `last_seen`. The map combines the two directions into one arc; routing uses only directed edges.
- `conflicts` **(rev, new)**: one row per (origin, dest, airline) where the two pages disagree: both statements, both revision timestamps, the resolution and the rule that decided it. Rebuilt each run and listed in the report.
- `snapshots`: history of published snapshot metadata (counts, hash, date) for the publish gate and changes log.
- `data/curated/programs.json` **(rev)**: `{ id, name, ownerAirline, alliance: { id, excludeMembers[] } | null, partners: [{ airline, redeem, earn, scope?: "operated-only", notes? }], confidence, sourceUrl, checkedAt }`.
- `data/curated/currencies.json`: transfer partners with `ratio`, `verified` and `checkedAt`.
- `data/curated/airline_aliases.json`: brand/regional → marketing airline (American Eagle → AA, KLM Cityhopper → KL).
- `data/curated/overrides.json` **(rev, replaces `route_overrides.json`)**: `add`, `remove`, `suspended` (airline at an airport/country, with `until`), `moved_airports`, `closed_airports`. Each rule needs `reason` and `source`.

**Programs, verified 2026-11-13:**

- **Amex (official page):** Aer Lingus, Aeroméxico (1.6), Aeroplan, Flying Blue, ANA, LifeMiles, Cathay (0.8), Delta, Emirates (0.8), Iberia, JetBlue (0.8), Qantas, Qatar, KrisFlyer, BA, Virgin Atlantic.
- **Bilt** (AwardWallet's 2026-10-20 table; the official page needs a login): Aer Lingus, Aeroplan, Flying Blue, Atmos, LifeMiles, BA, Cathay, Emirates, Etihad, Iberia, JAL, JetBlue, Qatar, Southwest, TAP, Turkish, United, Virgin Atlantic. **Remove AAdvantage.** Spirit is already gone.

## Conflict resolution

Each directed route `A → B` on airline X has **primary evidence** (A's own listing of B) and **reverse evidence** (B's listing of A, which describes `B → A`). Statuses come from the note classifier: current, future (begins later), resuming, suspended, ended, via, or absent. Rules, applied in order:

1. **Overrides decide** (add, remove, suspended-until, closed or moved airport).
2. **Explicit dates beat bare listings.** A dated note on either side, such as "ended 3 March 2026" or "begins June 2027", outranks an undated "current" on the other side for the whole pair. Example: B's page says "Lufthansa to A (ended 1 Oct 2026)" and A's page still lists B plainly. Then `A → B` is ended, with conflict flagged as `dated-other-side`.
3. **Undated contradictions use freshness.** If one side says "suspended" without a date and the other lists the route plainly, the page with the **newer revision timestamp** wins. The conflict is flagged either way. If the timestamps are within 7 days of each other, the route is kept as current but flagged `unresolved` for review. Showing a doubtful route is cheaper than hiding a real one.
4. **Own page otherwise decides its own direction.** A current listing on A's page makes `A → B` current, whatever B's page omits. Missing from the other side is not a contradiction.
5. **Reverse-only routes.** If A's page has no usable table (missing, no section, guard tripped) and B's page lists X to A as current, then `A → B` is added with `basis: reverse_only`. It's drawn on the map, and routing may use it only if the route is not one-directional on B's side (no "via" or "(arrival only)" note). If A's page _does_ have a usable table and doesn't list B, no reverse edge is invented, because one-way and triangle routes exist.

The report lists all conflicts grouped by rule. Rows flagged `unresolved` are the weekly review list. Fixing one means a Wikipedia edit or an `overrides.json` rule with a reason.

## Publish checks

Lightweight, and they only block on large, concentrated losses, the signature of a scraping or mapping bug rather than real schedule changes:

| Check                                    | Fails when                                                     | Warns when                     |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| Global                                   | Directed routes or airports with routes change by more than 5% | more than 2%                   |
| Per airport (with 40+ routes last time)  | It loses more than 40% **and** more than 20 routes             | more than 20% and more than 10 |
| Per airline (with 40+ routes last time)  | It loses more than 50% **and** more than 25 routes             | more than 25% and more than 10 |
| Per country (with 100+ routes last time) | It loses more than 25% **and** more than 40 routes             | more than 10% and more than 20 |

- The relative-and-absolute pairs mean small airports and airlines never block a publish.
- Gains only warn, since new routes are rarely a bug, except for one: an airport or airline that **doubles** with more than 40 new routes. That's a likely mis-mapped code.
- `--force` publishes anyway. A failed run keeps the previous snapshot live, and the report explains why.

## Phases

### 1. Scaffold: done (`ad57980`)

### 2. Reference data: done (`f3bbef0`), with follow-ups in 3b

### 3a. Wikipedia parser, first cut: done (superseded by 3b)

Section fetch via the Action API, the table parser (Seasonal/Charter markers, begins/resumes/ends notes), redirect resolution cached in SQLite, aliases, directional routes, the sanity report and 49 tests. It honours `Retry-After`, and a contact User-Agent comes from a git-ignored `.env` (200 vs 10 requests/min).

### 3b. Wikipedia pipeline, hardened (rev): done

1. **Revision-based fetching.**
   - `action=query&prop=revisions&rvprop=ids|timestamp` for 50 titles per request (about 81 requests for every airport).
   - Fetch only pages whose `revid` changed. Pages that went missing or failed keep their old listings.
   - `--full` forces a refetch.
2. **Note classifier parity.** Handle:
   - `via` (not nonstop)
   - `suspend` / `cancel`
   - `begin`/`commence`/`start`/`launch`
   - `resum`/`restart`/`return`
   - `end`/`terminat`/`cease`/`discontinu`/`until`
   - links inside parentheses belong to the note
   - `Year-round:` / `Regular:` labels
   - Skip tables when any heading above them matches history/former/previous/before/defunct/future/planned/cargo/statistics.
3. **Listings table and page guard.** Store raw listings per page revision. If a changed page parses to 0 rows, or under 50% of its previous rows, keep the previous listings and flag it in the report.
4. **Directional resolution** following [Conflict resolution](#conflict-resolution). Charter-only routes are dropped. Conflicts are stored with their rule and reason.
5. **Airline status.** For each airline linked from a current listing, read its article once per revision. Mark it defunct on a past "Ceased operations" date, or on a "Defunct airlines" category plus past-tense wording. Defunct airlines are removed from routes.
6. **Airport identity fixes** (see the data model) and **keep airlines without IATA codes.**
7. **Overrides v2** with `until`, `moved_airports` and `closed_airports`.
8. **Report:**
   - pages changed or skipped and guard trips
   - unresolved links
   - one-sided share
   - top new and removed routes
   - airlines marked defunct

### 4. Snapshot export + publish checks (rev): done

- `ingest export` builds the snapshot with integer-indexed arrays. It holds airports, airlines (IATA where known, plus alliance), routes (`a`, `b`, airline indices, `seasonal`, `listed_by`), alliances, programs (resolved bookable sets from `shared/programs.ts`), currencies, `generated_at` and source revision dates.
- **Publish checks:** see [Publish checks](#publish-checks). The previous snapshot stays live on failure.
- Write `changes.txt` (added and removed routes, busiest airports first) and keep the last N snapshots in `data/snapshots/`.
- The snapshot is licensed **CC BY-SA 4.0** (derived from Wikipedia) and says so in its header. The attribution text lists Wikipedia contributors, Wikidata (CC0) and OurAirports (public domain).

### 5. Map + airport interaction: done

- All airports as dots (zoom-aware), with labels at higher zoom.
- Click an airport to show its arcs. The two directions are combined into one arc. A route flown in only one direction, or known only from the other end (`reverse_only`), is drawn dimmer.
- **Route details panel:** destinations with airlines, distance, a seasonal badge, a "one-way" or "from the other airport's page only" hint, and a conflict marker linking both source pages.
- **Airport search:** Fuse.js over IATA, city and name.

### 6. Filters + URL state (rev): done

- Filter order: **Currency** (Bilt/Amex) → **Program** → **Alliance** → **Airline**. OR within a dimension, AND across dimensions.
- Program resolution uses the new schema: owner + alliance members − `excludeMembers` + partners with `redeem: true`. Earn-only partners never count. A partner with `scope: "operated-only"` counts only for routes that airline operates itself, which is what Wikipedia lists anyway. Its brand aliases (e.g. a regional brand flying for it) are excluded, and the UI notes the restriction.
- Every program shows `checkedAt` and its source link. The validator warns when `checkedAt` is more than 120 days old.
- Wording: "potentially bookable with Flying Blue". Each program shows its confidence and `checkedAt`.
- URL state via `nuqs`, e.g. `?ap=AMS&cur=amex&prog=flyingblue&al=skyteam&airline=KL&to=JFK`.

### 7. 1-stop routing: done

- In the Web Worker, over **directed** edges only: the nonstop `O → D`, plus every hub H with an edge `O → H` and an edge `H → D` that both pass the filter. `D → O` is never used to answer `O → D`. Ranked by total distance, hiding more than 1.5× detour by default.
- Each leg may use a different airline. The list shows which selected programs cover both legs.

### 8. Deploy (homelab) (rev): written; not yet run on the homelab

- `docker-compose.yml`:
  - `web`: Next.js standalone, serving the current snapshot.
  - `ingest`: a weekly cron running `ingest refresh` (incremental fetch → merge → gate → export), with a shared `data/` volume.
- Backups: a weekly `VACUUM INTO data/backups/flightmesh-YYYYMMDD.db` (keep 8), and the snapshot history above. `data/curated` lives in git.
- `.env` on the homelab sets `FLIGHTMESH_CONTACT` (the repo URL). Without it, the pipeline paces itself to the anonymous limit.
- The existing reverse proxy handles TLS and the domain. The footer shows attribution and the snapshot date.

## Simplicity guardrails

- One process, one SQLite file, one JSON snapshot. No queues, no server-side API, no extra services.
- Checks are plain functions with thresholds in one place, not a validation framework.
- Anything that needs human judgement goes to the weekly report (conflicts, unresolved links, warnings) instead of more automation.

## Known limitations (accepted)

- No frequencies, aircraft types or schedules.
- Wikipedia lags announcements and removals by days or weeks, and covers China's domestic network, Russia and small regional carriers less well.
- "Bookable" means a redeemable partnership exists, not that award space does. Partner lists are curated and reviewed by hand.
- Codeshares are ignored. Wikipedia lists operating carriers and brands.

## Optional later

- Traffic badges from AirportMiles or BTS T-100 (annotation only, credited).
- Daily incremental runs.
- A private cross-check diff against Flight Atlas's public JSON.
- Multi-airport cities. Closed-airspace detours.

## Verification

- **Parser tests:** the existing fixtures plus new cases for via, suspended, links inside notes, historical headings and `Year-round:`.
- **Resolution tests:** one per conflict rule (override, dated other side, freshness, freshness tie → unresolved, own page, reverse-only allowed or refused), plus charter-only dropped and a one-way route not mirrored.
- **Routing test:** a triangle A→B→C→A gives no A→C nonstop, and C→A is not used for A→C.
- **Guard and publish-check tests:** an empty parse keeps the old listings. A 10% global drop fails. One hub losing half its routes fails. A small airport losing 5 of 8 routes passes.
- **Incremental test:** an unchanged revid means no fetch, and a changed revid means a refetch.
- **Data sanity:** a full run, then review the report: one-sided share, unresolved links, spot checks of AMS, SEA, DOH, NRT and BZN.
- **Programs:** Amex → Flying Blue includes DL/KL/AF, Bilt → AAdvantage is gone, an earn-only partner is excluded, and stale `checkedAt` warns.
- **End-to-end** in the browser pane, and the **deploy check** on the homelab, as before.
