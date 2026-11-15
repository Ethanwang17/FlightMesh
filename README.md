# FlightMesh

A personal world map of nonstop airline routes. Click an airport to see where it flies, filtered by airline, alliance, loyalty program or bank currency (Bilt / Amex / Chase). See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Setup

Requires Node 22.12+. pnpm is pinned through `packageManager`; enable it once with Corepack:

```bash
corepack enable
```

```bash
pnpm install
```

## Commands

| Command          | What it does                                 |
| ---------------- | -------------------------------------------- |
| `pnpm dev`       | Start the web app at http://localhost:3000   |
| `pnpm build`     | Production build (Next.js standalone output) |
| `pnpm lint`      | ESLint in every package                      |
| `pnpm typecheck` | TypeScript in every package                  |
| `pnpm test`      | Vitest in every package                      |
| `pnpm format`    | Prettier                                     |

### Data pipeline

| Command                 | What it does                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm ingest reference` | Load airports (OurAirports) and airline codes (Wikidata), then validate curated data                   |
| `pnpm ingest routes`    | Parse every airport's Wikipedia route table (~1 hour; `--only AMS,SEA` or `--limit N` for a quick run) |
| `pnpm ingest report`    | Write `data/reports/routes-report.txt` and `unresolved.csv`                                            |
| `pnpm ingest export`    | Build the snapshot and publish it if the publish checks pass (`--force` to override)                   |
| `pnpm ingest refresh`   | The weekly job: `reference` + `routes` + `report` + `export` + `backup`                                |
| `pnpm ingest validate`  | Re-check `data/curated/*.json` only                                                                    |
| `pnpm ingest stats`     | Row counts in `data/flightmesh.db`                                                                     |

Downloads are cached in `data/cache/` for 6 days, so re-runs within a week are fast.

## Deploy (homelab)

Requires Docker with Compose v2.

```bash
git clone https://github.com/Ethanwang17/FlightMesh.git && cd FlightMesh
```

```bash
cp .env.example .env   # set FLIGHTMESH_CONTACT (see below)
```

```bash
docker compose up -d --build
```

- **`web`** serves the app on port 3000. Point your reverse proxy (TLS, domain) at it.
- **`ingest`** runs the first full refresh on startup (about 2 hours, since every Wikipedia page is read once), then a weekly incremental refresh on Mondays at 06:17 (set `TZ` in `.env`). Until the first run finishes, the app shows "no route snapshot yet".
- **Data** lives in the `flightmesh-data` volume: database, download cache, reports (`/data/reports`), snapshot history (`/data/snapshots`, last 8), database backups (`/data/backups`, last 8) and the live snapshot (`/data/publish`).
- **`FLIGHTMESH_CONTACT`** (an email or URL, e.g. the repo URL) goes in the User-Agent. Wikipedia then allows about 200 requests/min instead of 10. Without it the pipeline still works, just slowly.

**Weekly review:** read `/data/reports/routes-report.txt` (unresolved conflicts, unknown airline links, guard trips) and `/data/reports/publish.txt` (what changed, and why a publish was refused if it was). If a refused publish is legitimate, run it by hand:

```bash
docker compose exec ingest pnpm -s ingest export --force
```

Restore a backup by stopping `ingest` and copying `/data/backups/flightmesh-YYYY-MM-DD.db` over `/data/flightmesh.db`.

## Layout

```
apps/web          Next.js app: MapLibre map + UI
packages/shared   Types and logic shared by the app and the data pipeline
packages/ingest   Data pipeline CLI (SQLite via node:sqlite, cached downloads in data/cache)
data/curated      Hand-maintained alliances, programs, bank currencies, airline aliases, route overrides
```

## Notes

- MapLibre v6 loads its web worker relative to its own module, which breaks under the Next.js bundler. `apps/web/scripts/copy-maplibre-worker.mjs` copies the worker into `public/vendor/` before `dev` and `build`, and `WorldMap.tsx` points `setWorkerUrl` at it.
- Basemap: [OpenFreeMap](https://openfreemap.org) (free, no API key).
- Curated partner data is best-effort. Programs carry a `confidence` field and bank transfer partners a `verified` flag; check low-confidence or unverified entries on the program or bank site.
- Routes come from each airport's Wikipedia "Airlines and destinations" section. Charter destinations and routes that haven't started yet are skipped, and a route missing from its page for 2 runs in a row is marked inactive. Fix wrong routes in `data/curated/route_overrides.json`; map unrecognised airline links (listed in the report) in `data/curated/airline_aliases.json`.
