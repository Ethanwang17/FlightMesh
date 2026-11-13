// MapLibre v6 loads its worker relative to its own module URL, which breaks once
// Next.js bundles it. Copy the self-contained worker into public/ so the map can
// load it from a stable path (see components/WorldMap.tsx).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("maplibre-gl/package.json"));
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor");

mkdirSync(outDir, { recursive: true });
copyFileSync(
  join(pkgDir, "dist", "maplibre-gl-worker.mjs"),
  join(outDir, "maplibre-gl-worker.mjs"),
);
