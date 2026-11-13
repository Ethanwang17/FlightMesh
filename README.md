# FlightMesh

A personal world map of nonstop airline routes. Click an airport to see where it flies, filtered by airline, alliance, loyalty program or bank currency (Bilt / Amex). See [docs/PLAN.md](docs/PLAN.md) for the full plan.

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

## Layout

```
apps/web          Next.js app: MapLibre map + UI
packages/shared   Types and logic shared by the app and the data pipeline
packages/ingest   Data pipeline (Phase 2)
data/curated      Hand-maintained alliance / program / currency data (Phase 2)
```

## Notes

- MapLibre v6 loads its web worker relative to its own module, which breaks under the Next.js bundler. `apps/web/scripts/copy-maplibre-worker.mjs` copies the worker into `public/vendor/` before `dev` and `build`, and `WorldMap.tsx` points `setWorkerUrl` at it.
- Basemap: [OpenFreeMap](https://openfreemap.org) (free, no API key).
