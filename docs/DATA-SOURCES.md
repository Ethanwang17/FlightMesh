# FlightMesh data-source review

Research done 2026-11-13, before finishing Phase 3. It asks whether the route data should come from somewhere other than (or as well as) our own Wikipedia parser. **Verified** means I read the source's code, data, docs or official page. **Unverified** means I relied on third-party reporting or couldn't access the source.

## Summary

| Question                                             | Answer                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Is Wikipedia still the best primary route source? | **Yes.** It's the only free source with current, worldwide, airline-level nonstop routes. Every alternative is stale, historical, regional, observed rather than scheduled, or scraped from a commercial site.                                                                                                              |
| B. Use or adapt Flight Atlas?                        | **Learn from it; don't depend on it.** It independently built the same Wikipedia pipeline and solved problems ours hasn't yet, so we should adopt those techniques. It has no license, is one month old, and keys airlines by name rather than IATA code. At most, use it as an optional private cross-check.               |
| C. Jonty or AirportMiles?                            | **Jonty: no.** It's scraped from FlightsFrom.com with browser impersonation, has no license, and its weekly job has failed every week since at least September 2026. **AirportMiles: not for v1.** It's historical traffic statistics, mostly without airlines. It's a good later add-on for an "evidence" badge on routes. |
| D. Combine sources?                                  | **Lightly.** Wikipedia (both airports' pages) is the only source that adds routes. OurAirports + Wikidata handle identity. Curated overrides beat everything. Other sources only validate or annotate, and never create routes.                                                                                             |
| E. Changes to the plan                               | See [Recommended changes](#recommended-changes). The biggest are incremental fetches by revision ID, merging both airports' listings, a publish gate instead of "inactive after 2 missed runs", and a richer partner schema.                                                                                                |

## Sources investigated

### Flight Atlas: `tjaffee99/flights` (highest priority)

[Repo](https://github.com/tjaffee99/flights) · [README](https://github.com/tjaffee99/flights#readme) · verified by reading `README.md`, `.github/workflows/rebuild.yml`, `pipeline/fetch_wikipedia.py`, `parse_wikipedia.py`, `build_routes.py`, `checks.py`, `fetch_airline_status.py`, `measured_us_bts.py`, and `data/flights.json` (build of 2026-11-09).

**What it is.** A static FlightConnections-style globe. Created 2026-10-12, 1 star, one maintainer (commits are authored by "Claude" and by a weekly GitHub Actions bot).

**How it builds routes** (verified):

- **Fetch.** Every scheduled-service airport's normal page view (`https://en.wikipedia.org/wiki/<title>`). That's one request per airport, at 4 requests/second with a User-Agent that includes its site URL, with backoff on 429/5xx. It keeps only the infobox and the route and statistics tables (with their heading chain), gzipped in a cache.
- **Article choice.** Wikidata's article link is preferred over OurAirports' link, which is "often redirects or, now and then, disambiguation pages". If several Wikidata items share an IATA code, the ICAO code decides, and military fields on the same code are filtered out. A Wikidata code is accepted only if OurAirports agrees on the airport. (It found that Wikidata sometimes gives an airstrip another airport's code.)
- **Table choice.** Any `wikitable` whose header row contains "airline" and "destination", wherever it sits. Tables are skipped when any heading above them matches cargo, history, former, previous, before, defunct, ceased, future, planned, statistics and similar.
- **Note classification** (`parse_wikipedia.py` `classify`):
  - `via X` → not nonstop
  - `suspend` or `cancel` → suspended
  - `begin`, `commence`, `start` or `launch` with a future date → future
  - `resum`, `restart` or `return` with a future date → current if the route is seasonal, otherwise "resuming"
  - `end`, `terminat`, `cease`, `discontinu` or `until` with a past date → ended
  - Dates are parsed with `dateutil`, with words like "early", "mid" and "summer" stripped first.
  - Links inside parentheses belong to the note, so "Dubai (via Muscat)" doesn't add Muscat as a destination.
  - `Seasonal:`, `Charter:`, `Year-round:` and `Regular:` labels set the mode.
- **Merging both ends** (`build_routes.py` `load_wikipedia`):
  - Routes are keyed by **unordered airport pair**. An airline flies a pair if either airport lists it as current.
  - If either end marks it suspended or ended, it doesn't ("the note is the newer edit").
  - Charter-only pairs are dropped.
- **Defunct airlines** (`fetch_airline_status.py`). Each airline's own article is read. An airline is dropped everywhere if its infobox has a past "Ceased operations" date, or if it's in a "Defunct airlines" category and the article uses the past tense.
- **Overrides** (`pipeline/overrides.json`, 37 KB). Each rule has a reason and a source:
  - Sanctions and closed airspace
  - Airports that closed or moved (`moved_airports`, e.g. old Doha → new)
  - Airlines suspended at an airport or in a country, with `until` dates that lapse on their own
  - "Unlisted" routes that Wikipedia is missing
- **Publish gate** (`checks.py`):
  - The new build is compared with the last committed one.
  - It **fails if routes or airports move by more than 5%** (passengers by more than 8%), or if an official source's routes shrink by more than 30%.
  - It also fails if a new route with more than 1M passengers appears ("nearly always a mapping slip").
  - A failed build publishes nothing and emails the owner.
- **Changes log** (`changes.py`). Lists routes added and removed in each weekly commit.
- **Official statistics** (`measured_*.py`), used for passenger counts and to add routes Wikipedia misses (about weekly service or more): US BTS T-100, UK CAA, Eurostat, India DGCA, Australia BITRE, Brazil ANAC. The BTS download drives the TranStats ASP.NET form, which is fragile.

**Dataset** (verified, `data/flights.json`):

- **Size.** 2.5 MB raw, built 2026-11-09. 4,192 airports, 33,104 unordered airport pairs, 53,289 airline-pair listings, 971 airlines.
- **Airlines are identified by Wikipedia article name, not IATA code.** So "American Eagle" and "Delta Connection" are separate airlines.
- **Columnar arrays.** Includes passenger estimates and flight times.
- **Updates.** Weekly via GitHub Actions on Mondays. Commits show weekly rebuilds on 10/19, 10/26, 11/02 and 11/09.

**License** (verified): **none.** There's no LICENSE file and GitHub reports no license. The README credits each source's license (Wikipedia CC BY-SA 4.0, India's figures ODbL), but grants nothing for the code or the compiled file. Without a license the code is all rights reserved. The route facts are Wikipedia-derived, but the compilation and overrides are the author's.

**Verdict:**

- **Don't vendor its code or its JSON.** The licensing is the blocker. It's also a month old with one maintainer, and its airline identity (article names, unordered pairs) doesn't fit our IATA-keyed program filters without re-mapping.
- **Do adopt its ideas, re-implemented in our TypeScript pipeline.** Each one is a known failure mode it has already hit in production (see Essential changes). It's strong evidence that our Wikipedia approach is viable: AMS comes out at 295 pairs there and 288 departures from AMS's own page in ours.
- **Optional:** a private weekly diff against its published JSON as a sanity check, never shipped in our snapshot. If we ever want to reuse code or data verbatim, ask the author to add a license.

### Jonty: `Jonty/airline-route-data`

[Repo](https://github.com/Jonty/airline-route-data) · verified by reading `scrape_airline_routes.py`, `.github/workflows/update.yml` and the Actions run history.

- **Upstream.** **FlightsFrom.com**, scraped with `curl_cffi` using `impersonate="chrome"` (a browser fingerprint used to get past bot protection). It reads the `window.airport`/`routes` JSON embedded in each airport's destinations page. FlightsFrom presumably licenses schedule data commercially (unverified: its terms page returned 403 to me).
- **Data.** One 23 MB JSON keyed by airport. Each route lists carriers (IATA + name, active passenger airlines only), `km` and `min` (FlightsFrom's "common duration"). There are no dates, seasonal flags or provenance.
- **Freshness.** The weekly workflow's last successful automated update was **2026-05-03**. **Every scheduled run since is marked failed** (the last 10 runs, 2026-09-20 → 2026-11-08). Two manual commits landed in September.
- **License.** **None** on the repo. The underlying data belongs to FlightsFrom and/or its schedule supplier.

**Verdict: don't use it, not even for validation.** It's scraped from a commercial site with bot evasion, has no license, and is currently broken. It's free to download, but that doesn't mean we have the right to reuse it.

### AirportMiles API

[Docs](https://airportmiles.com/api) · verified by fetching `index.json`, `routes/AMS-JFK.json` and `airports/AMS.json` (build 2026-11-04).

- **What.** Free static JSON with no key and open CORS. Covers 4,031 airports and **20,767 routes "with open traffic data"**, plus a 10 MB `routes.json` bulk file. It's built monthly.
- **Data.** **Historical statistics, not schedules** (its docs say: no timetables, no live status):
  - monthly passengers
  - directional flights and block times (AMS↔JFK: 1,473 / 1,467 flights)
  - distance and CO2
  - Sources include US BTS, Eurostat, UK DESNZ, StatCan, Brazil, Chile, Argentina, Colombia, Australia, Korea, Japan and India.
- **Airlines.** The airport file's airline list is flagged `usRoutesOnly` (from T-100), so there's no airline-level data outside US-touching routes.
- **License.** The base is CC0. Traffic fields "keep that source's licence: name the source", and Colombia's Aerocivil fields are CC BY-SA 4.0.

**Verdict:** **not a route source.** It can't add airlines, and it lags reality by months. As a **future enhancement** it's the cheapest way to show "about N passengers/month (2025, Eurostat)" on a route and to flag Wikipedia routes in well-covered countries that have no traffic at all. Credit each source if we do.

### OpenFlights

[Data page](https://openflights.org/data) · verified:

- **Routes.** "The third-party that OpenFlights uses for route data ceased providing updates in June 2014". The page says it is "of historical value only". That's 67,663 routes.
- **Airlines.** 5,888 airlines as of January 2012, and the Active flag "is not reliable".
- **License.** ODbL / DbCL.

**Verdict:** **avoid.** Wikidata already gives better and current airline and airport identities. Mixing in ODbL data would add share-alike obligations for little gain. At most it's a dev fixture.

### OurAirports

[Data page](https://ourairports.com/data/) (its TLS certificate had expired when I checked) · [GitHub mirror](https://github.com/davidmegginson/ourairports-data), verified: **regenerated daily**, The Unlicense (public domain), crowd-edited.

**Verdict: keep.** It's still the best free airport base. Improvements:

- **Don't treat `scheduled_service` as the truth** (see the measurement below). Load every airport with an IATA code, so destinations resolve even when the flag is wrong. Fetch pages for airports flagged scheduled, plus any airport that another page lists as a destination.
- **Use Flight Atlas's article-selection rule:** Wikidata's article first, ICAO tie-break, military filter, and OurAirports must agree on the code.

### FSAtlas: `Leofric99/fsatlas`

[Repo](https://github.com/Leofric99/fsatlas) · verified (README). It's a flight-simulator inspiration tool. The user imports flight records into SQLite, and it renders them on a map with filters. There's no route source and no routing algorithm beyond showing the records. No license.

**Verdict:** nothing to adopt. Our MapLibre + deck.gl + Web Worker design is already more capable.

### Simple Airline Database: `rmanderson/simpleairlinedb`

[Repo](https://github.com/rmanderson/simpleairlinedb) · verified (README, files, commits). The Unlicense. Hand-aggregated routes for **8 US airlines**:

- AS, HA, MX (Breeze), SY, G4, B6, WN
- Delta, American and United are "future".
- The newest route data is **2025-03/04**. Since then the commits are only dependency bumps.

**Verdict:** **avoid.** It's stale, would resurrect routes that have ended, and adds nothing Wikipedia lacks.

### Virtual Radar Server standing-data

[Repo](https://github.com/vradarserver/standing-data) · verified (README, `routes/schema-01/K/KLM-all.csv`). CC0, updated daily. **Callsign → airport sequence** submitted by VRS users, for example `KLM1001,EHAM-EGLL`. It has no dates and no scheduled-versus-observed distinction, and it includes odd entries (`KLM10, LFPO-LFPG`).

**Verdict:** **avoid as route evidence.** These are mappings of observed callsigns, not schedules. Even as a "missing route" hint, a human would have to verify every hit.

### Other sources found

| Source                                                                                | What it is                                                                                              | Verdict                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [winstonhoyle/flight-atlas](https://github.com/winstonhoyle/flight-atlas)             | Apache-2.0. Monthly Wikipedia scrape, **Americas only**, with a public API (100 req/10 s).              | The license allows reuse, but the scope is regional and the cadence monthly. Worth reading as a second parser reference. Not a source.                                                                          |
| [tyu012/airport-wiki-scraper](https://github.com/tyu012/airport-wiki-scraper)         | AGPL-3.0 Wikipedia destination-list scraper, created 2026-10.                                           | AGPL would push obligations onto our code. Not adopted.                                                                                                                                                         |
| [colingoodman/airline-routes](https://github.com/colingoodman/airline-routes)         | Curated, custom license, created 2026-10-27.                                                            | Too new and unclear. Skip.                                                                                                                                                                                      |
| [cristobal-io/aviation-json](https://github.com/cristobal-io/aviation-json)           | MIT Wikipedia scrape, last pushed 2017.                                                                 | Abandoned.                                                                                                                                                                                                      |
| [US DOT BTS T-100 Segment](https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FMG)     | Public domain. Every segment touching the US, by **operating** carrier, monthly, about 4 months behind. | The best free airline-level validation source, but only for US-touching routes, and it reports operators (OO, YX, 9E) rather than the brands Wikipedia lists (American Eagle). **Future**, for validation only. |
| Commercial "free tiers" (Aviationstack, Aviation Edge, AeroDataBox)                   | Rate-limited APIs (e.g. Aviationstack's free tier is about 100 requests/month, unverified).             | Far too small for a global network. Their terms usually forbid storing or redistributing. Avoid.                                                                                                                |
| [lucianosrp/open-source-aviation](https://github.com/lucianosrp/open-source-aviation) | CC0 index of open aviation data.                                                                        | Lists nothing better for current routes. Its OpenFlights entries confirm 2017 as the newest snapshot.                                                                                                           |

I found **no free, current, global, airline-level schedule dataset.** Several independent projects (Flight Atlas, winstonhoyle's Flight Atlas, the scrapers above) all landed on Wikipedia for the same reason.

## Is the Wikipedia approach still right?

**Coverage.**

- On airport count, Flight Atlas's 4,192 routed airports from about 4,100 fetched pages show that nearly every scheduled airport has a usable table. _Our own measurements from the full run are in [Measured on our data](#measured-on-our-data)._
- Known weaker areas (from Flight Atlas's README, plus our trial): China's domestic network, Russia, small regional and island carriers, and countries where English-language editors are few. Small airports whose page has no table at all simply contribute nothing. The other end usually still lists the route, which is another reason to merge both ends.

**Accuracy.**

- Editors are quick to add _announced_ routes (hence the "begins" notes) and slower to remove ended ones. Flight Atlas found Frankfurt's page still listing Lufthansa to Tehran after Tehran's page marked it suspended.
- Mitigations, all verified in its code: both-ends merge with suspension precedence, defunct-airline detection, dated `until` suspension overrides and closed-airport lists.

**Parsing reliability.**

- Tables are consistent: a `wikitable` with Airlines / Destinations / Refs columns. Our parser handled AMS, SEA, BZN, HNL, JFK, LHR, NRT, ICN, DOH, DXB, ATL and SFJ without per-page code.
- Variation lives in the _notes_ (via, suspended, synonyms, links inside parentheses) and the _headings_ (historical tables). That's exactly where Flight Atlas's parser is ahead of ours today.

**Maintenance.** Most upkeep is curation, not code: aliases for unresolved airlines, overrides for stale listings, partner lists. The report already lists unresolved links. Adding a weekly changes log and a publish gate makes the remaining work "read one report a week".

**Refresh strategy.** Weekly is enough, since Wikipedia itself lags announcements by days. But we shouldn't re-download every page:

- `action=query&prop=revisions&rvprop=ids|timestamp` returns the latest revision ID for **50 titles per request**, so all 4,044 airports take about 81 requests.
- Re-fetch only pages whose revision changed.
- Store `revid` per page, so we know exactly which edit a route came from.
- With a contact User-Agent (200 req/min, [Wikimedia rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)), a typical weekly run drops from about 40 minutes to a few minutes. Without contact info (10 req/min) it stays feasible.

**Not deleting good routes.** "Inactive after 2 missed runs" is a proxy for _page content_, and a poor one.

- **Better:** a page's listings are replaced only when we fetched a **new revision** _and_ that parse passes a per-page guard. For example, a page that had 40 rows and now parses to 0 (or under 50%) is treated as a parse failure and its previous listings are kept.
- On top of that, a **run-level publish gate** (Flight Atlas's thresholds: routes ±5%, airports ±5%) keeps the last good snapshot whenever a run looks wrong.
- Upstream outages and empty responses become "page unchanged", never "routes deleted".

**Licensing.**

- Wikipedia text is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Factual route data extracted from tables is thin copyright-wise, but the safe reading, which Flight Atlas also follows, is to publish the **derived snapshot** under CC BY-SA 4.0 with attribution to Wikipedia contributors and a link to the source articles. Our app code can keep any license; only the data file carries the share-alike.
- Wikidata is CC0, and OurAirports is public domain.
- The User-Agent must identify us (we now send the repo URL).

## Loyalty-program filtering accuracy

"Program X partners with airline Y, so Y's routes are bookable with X" is **right for most cases and wrong at the edges.** Verified or reported exceptions:

- **Earn-only partners.** Atmos turned Philippine Airlines into earn-only in January 2026 and added ITA Airways as earn-only ([meilenoptimieren, via search](https://meilenoptimieren.com/?p=193587), unverified). A flag on extra partners isn't enough; each partner needs `redeem: true|false`.
- **Partners that churn.** Atmos lost Singapore and LATAM as partners (third-party reports, unverified). Atmos also redeems on Hainan Airlines (HU), which our list is missing.
- **Alliance members that aren't bookable.** Virgin Atlantic has historically not offered China Eastern awards (unverified for 2026).
- **Operated-by restrictions.** Virgin Atlantic: "Redemptions can only be made on Air Europa operated flights" ([Virgin Atlantic](https://flywith.virginatlantic.com/gb/en/flying-club/airline-partners/skyteam/air-europa.html)). Wikipedia lists _operating_ carriers, which is the right input for this, so the rule holds as long as routes stay keyed by operator or brand rather than codeshare.
- **Regional brands.** American Eagle, Delta Connection and the like are bookable as their mainline brand. Our aliases already map them (Wikipedia lists the brand, not SkyWest).
- **Codeshares.** Wikipedia lists the operator, so a codeshare never creates a false "bookable" route.

**Practical improvements with free data:**

1. Per-program partner entries: `{ airline, redeem, earn, scope?: "operated-only", excludedRegions?, source, checkedAt }`. Alliance rules support `excludeMembers`.
2. Every program carries `sourceUrl` and `checkedAt`. The validator **warns when an entry is more than 120 days old**, turning a quarterly review into a checklist.
3. The UI says "**potentially bookable** with X" and shows the confidence. It never implies award space.

**Bilt and Amex re-check (2026-11-13):**

- **Amex. Verified on the official page** ([global.americanexpress.com/rewards/transfer](https://global.americanexpress.com/rewards/transfer)): 16 airline partners. These are Aer Lingus, Aeroméxico (1:1.6), Aeroplan, Flying Blue, ANA, LifeMiles, Cathay (1:0.8), Delta, Emirates (1:0.8), Iberia, JetBlue (250:200), Qantas, Qatar, KrisFlyer, BA and Virgin Atlantic. **Our `currencies.json` matches exactly, including ratios.**
- **Bilt.** The official page needs a login, so I used [AwardWallet's 2026-10-20 announcement](https://awardwallet.com/news/bilt-rewards/jetblue-trueblue-transfer-partner), which has the full partner table: **18 airlines**. These are Aer Lingus, Aeroplan, Flying Blue, Atmos, LifeMiles, BA, Cathay, Emirates, Etihad, Iberia, JAL, **JetBlue (new 2026-10-20)**, Qatar, Southwest, TAP, Turkish, United and Virgin Atlantic.
  - **Remove AAdvantage** (sources say it left in June 2024).
  - **Mark Etihad and JetBlue verified.**
  - Spirit is already removed (ceased 2026-05-02 per Wikidata).

## Measured on our data

First full run of the hardened pipeline, 2026-11-14 (`pnpm ingest refresh`):

| Measure                              | Result                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Airport pages read                   | 4,464: 4,040 flagged scheduled by OurAirports, plus **424 more** that other pages list as destinations but OurAirports doesn't flag. This confirms `scheduled_service` can't be treated as truth. |
| Pages with a usable route table      | 4,085 (91.5%). 360 have no "Airlines and destinations" section, and 7 are missing. 0 failed, 0 guard trips.                                                                                       |
| Directed routes                      | **94,533** (17.9% seasonal), from 4,116 origin airports, 900 airlines                                                                                                                             |
| Airport pairs                        | **33,256** (Flight Atlas: 33,104)                                                                                                                                                                 |
| Same airline flies the reverse route | 89.1%                                                                                                                                                                                             |
| Route basis                          | own page 93,835 · reverse-only (origin has no usable page) 643 · settled conflict 55                                                                                                              |
| Conflicts between two pages          | 191. 133 settled as not flying (89 by a dated note, 44 by a fresher page). 29 settled as flying. **26 unresolved** (pages edited within a week of each other), kept and listed for review.        |
| Defunct airlines dropped             | 11 by their articles (e.g. AlbaStar, ceased 2026-11-10; Royal Air Philippines; flybig), plus 1,445 dissolved per Wikidata                                                                         |
| Charter listings left out            | 3,060                                                                                                                                                                                             |
| Links without an airline IATA code   | 3,037 routes kept on the map (e.g. Azul Conecta, Super Air Jet, LATAM Chile, JSX). They can be aliased in `airline_aliases.json`.                                                                 |
| Snapshot                             | 1.64 MB raw, 358 KB gzipped                                                                                                                                                                       |
| Time                                 | about 2 h 20 min for the first run (every page and about 675 airline articles fetched once). Later runs fetch only edited pages.                                                                  |

**Busiest airports** (distinct nonstop destinations): IST 347, FRA 296, AMS 288, DXB 284, CDG 279, ORD 279, DFW 269. These are plausible against published figures.

Weak spots seen: large airports with no route section on their page include Luanda (LAD), Kaduna (KAD), Rajkot (HSR) and Zhanjiang (ZHA). Their routes still appear where the _other_ airport's page lists them, as reverse-only routes.

## Recommended changes

### Essential (before calling Phase 3 done)

1. **Merge both ends.** Store raw _listings_ `(page, origin, dest, airline, mode, status, note, revid)`. Derive routes per **unordered pair + airline**:
   - current if either end lists it as current
   - **not** current if either end lists it as suspended or ended
   - charter-only pairs dropped
   - keep `listedBy: A | B | both` as a confidence signal
2. **Note classifier parity with Flight Atlas.** Handle:
   - via (not nonstop)
   - suspended and cancelled
   - begins/commence/launch/start
   - resumes/restart/return
   - ends/terminate/cease/discontinue/until
   - links inside parentheses belong to the note
   - `Year-round:`/`Regular:` labels
   - heading-chain skip for historical, future and planned tables
3. **Incremental fetch by revision ID, plus a per-page guard.** Re-fetch only changed pages. Keep previous listings when a changed page parses to nothing or to much less than before. **Drop the "2 missed runs" rule.**
4. **Publish gate.** Only export a new snapshot when routes and airports move by 5% or less against the last published snapshot, unless `--force`. Always write a changes report (routes added and removed, busiest first). Keep the last good snapshot.
5. **Airport identity.** Load all IATA airports (not just `scheduled_service=yes`). Choose articles by Wikidata first, with ICAO tie-break, military filter and OurAirports agreement.
6. **Defunct airlines.** Weekly check of each linked airline's article: an infobox "Ceased operations" date in the past, or a "Defunct airlines" category with past-tense wording. Cache it by revision.
7. **Keep unresolved airlines instead of dropping their routes.** The internal airline key is the canonical article title (or Wikidata QID), with IATA as an attribute. Airlines without IATA still appear on the map and in the airline filter. They just can't match a program.
8. **Fix Bilt (remove AAdvantage) and move partners to the earn/redeem schema.** Re-check the programs marked `low`.
9. **Licensing and attribution.** The snapshot is published under CC BY-SA 4.0 with Wikipedia attribution. There's an attributions page/footer for Wikipedia, Wikidata and OurAirports. `.env` holds the contact User-Agent (done).

### High-value improvements

- **Overrides with lifetimes:** `suspended` rules with `until` dates, `moved_airports`, `closed_airports`, and an `unlisted` add-list. Each rule needs a `reason` and a `source`.
- **Weekly changes log** (also shown in the app as "New this week").
- **Route confidence in the snapshot:** listed by both ends, by one, or by override. The UI can dim one-sided listings.
- **Cross-check report against Flight Atlas's public JSON:** pairs we have that they don't, and the reverse. Private, for review only, never shipped.

### Optional future enhancements

- **AirportMiles or BTS T-100 traffic badges** ("≈ 360k passengers/yr, BTS 2025–26"), plus a "no traffic recorded" warning in well-covered countries. Credit each source.
- **Daily rather than weekly incremental runs.** About 81 revision-check requests, cheap once incremental fetching exists.
- **Closed-airspace and sanctions rules,** like Flight Atlas's `airspace`, if detours matter for display.
- **Multi-airport cities** (London = 6 airports) for search and one-stop routing.

### Avoid

- Jonty / FlightsFrom data in any form (no rights, bot evasion, broken).
- Vendoring Flight Atlas code or JSON without a license from its author.
- OpenFlights routes, simpleairlinedb or VRS callsign routes as _current_ routes.
- Commercial "free tier" APIs (too small, no-storage terms).
- Letting statistics sources _add_ routes in v1. Flight Atlas does, but it needs thresholds, regression and per-country quirks (doubling one-way US and Mexican tables, ignoring Swiss ones). That complexity isn't justified for a personal app.

## Tradeoffs vs the original Wikipedia-only plan

|             | Original plan                                                                                          | Revised plan                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy    | One-sided listings. Suspended and "via" routes leak in. Defunct airlines linger.                       | Both-ends merge with suspension precedence, a complete note classifier, and defunct-airline removal. Fewer stale routes.                                |
| Coverage    | Routes to airports with a wrong `scheduled_service` flag, or to airlines without IATA codes, are lost. | Both recovered. Coverage of airports whose own page lacks a table comes from the other end.                                                             |
| Freshness   | Weekly full refetch.                                                                                   | Weekly (or daily) incremental. Changes show up the same run.                                                                                            |
| Complexity  | Lower.                                                                                                 | Moderately higher: about 4 new modules (revisions, listings merge, airline status, publish gate). Still one language, one SQLite file, no new services. |
| Maintenance | Silent failures possible (empty parse deletes routes after 2 weeks).                                   | Weekly report plus a gate. Failures are loud and non-destructive.                                                                                       |
| Performance | About 40 min weekly with a contact UA, about 13 h without.                                             | Minutes per week. The snapshot size is unchanged (about 1–2 MB gzipped).                                                                                |
| Licensing   | Attribution planned.                                                                                   | Explicit CC BY-SA snapshot. Unlicensed third-party data avoided.                                                                                        |
| Reliability | Depends on every page fetching cleanly.                                                                | Outages mean "unchanged", and a bad run never replaces the last good snapshot.                                                                          |
