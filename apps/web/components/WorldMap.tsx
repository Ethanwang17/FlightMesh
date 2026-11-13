"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

/** Free basemap with no API key. Can be swapped for self-hosted PMTiles later. */
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const WORKER_URL = "/vendor/maplibre-gl-worker.mjs";

export function WorldMap() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: MapLibreMap | undefined;
    let cancelled = false;

    // Load MapLibre only in the browser; it touches `window` on import.
    import("maplibre-gl").then((maplibregl) => {
      if (cancelled || !containerRef.current) return;
      // Copied into public/ by scripts/copy-maplibre-worker.mjs.
      maplibregl.setWorkerUrl(WORKER_URL);
      const instance = new maplibregl.Map({
        container: containerRef.current,
        style: BASEMAP_STYLE,
        center: [10, 30],
        zoom: 1.6,
        minZoom: 1,
        maxZoom: 12,
        attributionControl: { compact: true },
      });
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map = instance;
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, []);

  return <div ref={containerRef} className="map" aria-label="World map" />;
}
