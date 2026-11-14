"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { RouteFlag, type RoutingResult, type Snapshot } from "@flightmesh/shared";
import type { DestinationView } from "@/lib/protocol";

/** Free basemap with no API key. Can be swapped for self-hosted PMTiles later. */
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
/** Copied into public/ by scripts/copy-maplibre-worker.mjs. */
const WORKER_URL = "/vendor/maplibre-gl-worker.mjs";

type RGBA = [number, number, number, number];
export const ALLIANCE_COLORS: Record<string, RGBA> = {
  star: [196, 150, 30, 255],
  oneworld: [180, 40, 70, 255],
  skyteam: [30, 100, 200, 255],
  none: [90, 100, 120, 255],
};
const MIXED: RGBA = [20, 140, 120, 255];
const ACCENT: RGBA = [31, 111, 235, 255];
const DIM_DOT: RGBA = [120, 130, 145, 70];
const MAX_LABELS = 40;

interface Arc {
  from: number;
  to: number;
  color: RGBA;
  width: number;
}

export interface MapViewProps {
  snapshot: Snapshot;
  /** Filtered nonstop destination count per airport. */
  counts: Uint16Array | null;
  selected: number | null;
  target: number | null;
  destinations: DestinationView[];
  routing: RoutingResult | null;
  /** Airport to fly to when it changes (e.g. picked in search). */
  focus: number | null;
  onPick: (airport: number | null, shift: boolean) => void;
}

function arcColor(s: Snapshot, routes: number[]): RGBA {
  const alliances = new Set(routes.map((i) => s.airlines.alliance[s.routes.al[i]!] ?? "none"));
  return alliances.size === 1 ? ALLIANCE_COLORS[[...alliances][0]!]! : MIXED;
}

export function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [layersModule, setLayersModule] = useState<typeof import("@deck.gl/layers") | null>(null);
  const shiftRef = useRef(false);
  const pickRef = useRef(props.onPick);
  useEffect(() => {
    pickRef.current = props.onPick;
  }, [props.onPick]);

  useEffect(() => {
    let cancelled = false;
    const keys = (e: KeyboardEvent) => (shiftRef.current = e.shiftKey);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);

    Promise.all([import("maplibre-gl"), import("@deck.gl/mapbox"), import("@deck.gl/layers")]).then(
      ([maplibregl, { MapboxOverlay }, layers]) => {
        if (cancelled || !containerRef.current) return;
        maplibregl.setWorkerUrl(WORKER_URL);
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: BASEMAP_STYLE,
          center: [10, 30],
          zoom: 1.6,
          minZoom: 1,
          maxZoom: 12,
          attributionControl: { compact: true },
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
        const overlay = new MapboxOverlay({
          interleaved: false,
          layers: [],
          getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
          onClick: (info: PickingInfo, event) => {
            if (info.layer?.id === "airports" && typeof info.object === "number") {
              const src = (event as { srcEvent?: MouseEvent } | undefined)?.srcEvent;
              pickRef.current(info.object, shiftRef.current || !!src?.shiftKey);
            } else if (!info.object) {
              pickRef.current(null, false);
            }
          },
        });
        map.addControl(overlay);
        mapRef.current = map;
        // Handy for debugging in the browser console; not shipped in production builds.
        if (process.env.NODE_ENV !== "production")
          (window as unknown as { __map: unknown }).__map = map;
        overlayRef.current = overlay;
        setLayersModule(layers);
      },
    );

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
      mapRef.current?.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Fly to an airport picked outside the map (search, URL).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.focus === null || !layersModule) return;
    const s = props.snapshot;
    map.flyTo({
      center: [s.airports.lon[props.focus]!, s.airports.lat[props.focus]!],
      zoom: Math.max(map.getZoom(), 3),
      speed: 1.6,
    });
  }, [props.focus, props.snapshot, layersModule]);

  // Frame both ends when a route is opened: centre on the midpoint the short way round
  // (never across a world copy), zoomed by distance, leaving room for the sidebar.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.selected === null || props.target === null || !layersModule) return;
    const s = props.snapshot;
    const [lon1, lat1, lon2, lat2] = [
      s.airports.lon[props.selected]!,
      s.airports.lat[props.selected]!,
      s.airports.lon[props.target]!,
      s.airports.lat[props.target]!,
    ];
    let dLon = lon2 - lon1;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = lon1 + dLon / 2;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    const spanDeg = Math.max(Math.abs(dLon), Math.abs(lat2 - lat1) * 1.6, 2);
    const narrow = window.innerWidth <= 720;
    const usable = narrow ? window.innerWidth : window.innerWidth - 420;
    const zoom = Math.min(6, Math.max(1, Math.log2((usable * 360) / (512 * spanDeg * 1.4))));
    map.easeTo({
      center: [lon, (lat1 + lat2) / 2],
      zoom,
      padding: narrow
        ? { top: 0, bottom: window.innerHeight * 0.55, left: 0, right: 0 }
        : { top: 0, bottom: 0, left: 400, right: 0 },
      duration: 900,
    });
  }, [props.selected, props.target, props.snapshot, layersModule]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !layersModule) return;
    const { ScatterplotLayer, ArcLayer, TextLayer } = layersModule;
    const s = props.snapshot;
    const pos = (i: number): [number, number] => [s.airports.lon[i]!, s.airports.lat[i]!];
    const counts = props.counts;
    const n = s.airports.code.length;
    const ids = Array.from({ length: n }, (_, i) => i);

    // Airports in the current view: the selection, its destinations, or the itinerary's stops.
    const highlighted = new Set<number>();
    const arcs: Arc[] = [];
    if (props.routing && props.selected !== null) {
      const r = props.routing;
      const options = [...(r.nonstop ? [r.nonstop] : []), ...r.oneStop.slice(0, 12)];
      options.forEach((it, rank) => {
        it.stops.forEach((a) => highlighted.add(a));
        for (let k = 0; k < it.legs.length; k++) {
          arcs.push({
            from: it.stops[k]!,
            to: it.stops[k + 1]!,
            color: arcColor(s, it.legs[k]!),
            width: rank === 0 ? 3 : 1.5,
          });
        }
      });
    } else if (props.selected !== null) {
      highlighted.add(props.selected);
      for (const d of props.destinations) {
        highlighted.add(d.dest);
        const weak =
          !d.returns || d.routes.every((i) => (s.routes.flags[i]! & RouteFlag.ReverseOnly) !== 0);
        const c = arcColor(s, d.routes);
        arcs.push({
          from: props.selected,
          to: d.dest,
          color: weak ? [c[0], c[1], c[2], 110] : c,
          width: weak ? 1 : 1.6,
        });
      }
    }

    const radius = (i: number) => {
      const c = counts?.[i] ?? 0;
      return c ? 2 + Math.sqrt(c) * 0.9 : 1.6;
    };

    const layers: Layer[] = [
      new ArcLayer<Arc>({
        id: "routes",
        data: arcs,
        greatCircle: true,
        getSourcePosition: (a) => pos(a.from),
        getTargetPosition: (a) => pos(a.to),
        getSourceColor: (a) => a.color,
        getTargetColor: (a) => a.color,
        getWidth: (a) => a.width,
        widthUnits: "pixels",
      }),
      new ScatterplotLayer<number>({
        id: "airports",
        data: ids,
        pickable: true,
        radiusUnits: "pixels",
        getPosition: pos,
        getRadius: (i) => (i === props.selected || i === props.target ? radius(i) + 3 : radius(i)),
        getFillColor: (i) => {
          if (i === props.selected || i === props.target) return ACCENT;
          if (highlighted.size && highlighted.has(i)) return [20, 24, 32, 230];
          return counts && counts[i] ? [31, 111, 235, highlighted.size ? 90 : 170] : DIM_DOT;
        },
        stroked: true,
        getLineColor: [255, 255, 255, 200],
        lineWidthUnits: "pixels",
        getLineWidth: (i) => (i === props.selected || i === props.target ? 2 : 0),
        updateTriggers: {
          getRadius: [counts, props.selected, props.target],
          getFillColor: [counts, props.selected, props.target, highlighted.size, arcs.length],
          getLineWidth: [props.selected, props.target],
        },
      }),
      new TextLayer<number>({
        id: "labels",
        // Label every stop only when there are few; a hub's 200+ codes would just overlap.
        data:
          highlighted.size <= MAX_LABELS
            ? [...highlighted]
            : [props.selected, props.target].filter((x) => x !== null),
        getPosition: pos,
        getText: (i) => s.airports.code[i]!,
        getSize: (i) => (i === props.selected || i === props.target ? 14 : 11),
        getColor: [20, 24, 32, 255],
        getPixelOffset: [0, -12],
        fontWeight: 600,
        outlineWidth: 3,
        outlineColor: [255, 255, 255, 230],
        fontSettings: { sdf: true },
        characterSet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      }),
    ];
    overlay.setProps({ layers });
  }, [
    layersModule,
    props.snapshot,
    props.counts,
    props.selected,
    props.target,
    props.destinations,
    props.routing,
  ]);

  return <div ref={containerRef} className="map" aria-label="World map of airline routes" />;
}
