"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { RouteFlag, type RoutingResult, type Snapshot } from "@flightmesh/shared";
import type { DestinationView } from "@/lib/protocol";
import { airportLabel } from "./format";
import { outlineOf, tierOf } from "./tiers";

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
/** The hovered route, drawn on top of the others. */
const HOVER_ROUTE: RGBA = [225, 29, 72, 255];
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
  /** Clear the selected airport (the × on its map label). */
  onClear: () => void;
}

interface Hover {
  airport: number;
  x: number;
  y: number;
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
  const [hover, setHover] = useState<Hover | null>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  // Bumped while the map moves, so the HTML labels pinned to airports follow it.
  const [, setMoveTick] = useState(0);
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
          // Strictly 2D: no tilting or rotating, by mouse, touch or keyboard.
          maxPitch: 0,
          pitchWithRotate: false,
          dragRotate: false,
          touchPitch: false,
          attributionControl: { compact: true },
        });
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
        const overlay = new MapboxOverlay({
          interleaved: false,
          layers: [],
          getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
          onHover: (info: PickingInfo) => {
            setHover(
              info.layer?.id === "airports" && typeof info.object === "number"
                ? { airport: info.object, x: info.x, y: info.y }
                : null,
            );
          },
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
        let frame = 0;
        map.on("movestart", () => setHover(null));
        map.on("move", () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => setMoveTick((t) => t + 1));
        });
        mapRef.current = map;
        // Handy for debugging in the browser console; not shipped in production builds.
        if (process.env.NODE_ENV !== "production")
          (window as unknown as { __map: unknown }).__map = map;
        overlayRef.current = overlay;
        setMapInstance(map);
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

  // What the current view shows: the selection's arcs and airports, or the itinerary stops.
  // Memoised so hovering only recolours layers instead of rebuilding ~9,000 dots.
  const view = useMemo(() => {
    const s = props.snapshot;
    const counts = props.counts;
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
    const ids = Array.from({ length: s.airports.code.length }, (_, i) => i);
    // Draw small airports first so hubs sit on top.
    const sorted = counts ? ids.sort((a, b) => counts[a]! - counts[b]!) : ids;
    // With an airport (or route) open, show only the airports involved.
    const airports = highlighted.size ? sorted.filter((i) => highlighted.has(i)) : sorted;
    return { highlighted, arcs, airports };
  }, [props.snapshot, props.counts, props.selected, props.destinations, props.routing]);

  // Only a destination of the open airport (or any airport when none is open) gets the hover look.
  const hovered =
    hover && (view.highlighted.size === 0 || view.highlighted.has(hover.airport))
      ? hover.airport
      : null;
  const hoveredRoute =
    props.selected !== null && !props.routing && hovered !== props.selected ? hovered : null;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !layersModule) return;
    const { ScatterplotLayer, ArcLayer, TextLayer } = layersModule;
    const s = props.snapshot;
    const pos = (i: number): [number, number] => [s.airports.lon[i]!, s.airports.lat[i]!];
    const counts = props.counts;
    const { highlighted, arcs, airports } = view;
    const tier = (i: number) => tierOf(counts?.[i] ?? 0);
    const isEnd = (i: number) => i === props.selected || i === props.target || i === hovered;
    // While a route is hovered, the others step back.
    const arcColorOf = (a: Arc): RGBA =>
      hoveredRoute === null
        ? a.color
        : [a.color[0], a.color[1], a.color[2], Math.min(a.color[3], 60)];

    const layers: Layer[] = [
      new ArcLayer<Arc>({
        id: "routes",
        data: arcs,
        greatCircle: true,
        getSourcePosition: (a) => pos(a.from),
        getTargetPosition: (a) => pos(a.to),
        getSourceColor: arcColorOf,
        getTargetColor: arcColorOf,
        getWidth: (a) => a.width,
        // Flat on the map: great-circle curves on the surface, not arcs rising off it.
        getHeight: 0,
        widthUnits: "pixels",
        updateTriggers: { getSourceColor: [hoveredRoute], getTargetColor: [hoveredRoute] },
      }),
      new ArcLayer<Arc>({
        id: "hovered-route",
        data: hoveredRoute === null ? [] : arcs.filter((a) => a.to === hoveredRoute),
        greatCircle: true,
        getSourcePosition: (a) => pos(a.from),
        getTargetPosition: (a) => pos(a.to),
        getSourceColor: HOVER_ROUTE,
        getTargetColor: HOVER_ROUTE,
        getWidth: 3.5,
        getHeight: 0,
        widthUnits: "pixels",
      }),
      new ScatterplotLayer<number>({
        id: "airports",
        data: airports,
        pickable: true,
        radiusUnits: "pixels",
        getPosition: pos,
        getRadius: (i) => (tier(i)?.radius ?? 1.6) + (isEnd(i) ? 3 : 0),
        getFillColor: (i) => {
          const t = tier(i);
          if (!t) return DIM_DOT;
          return [...t.color, 255];
        },
        stroked: true,
        getLineColor: (i) => {
          const t = tier(i);
          if (isEnd(i)) return [255, 255, 255, 255];
          if (!t) return [0, 0, 0, 0];
          return [...outlineOf(t.color), 230];
        },
        lineWidthUnits: "pixels",
        getLineWidth: (i) => (isEnd(i) ? 2.5 : 1),
        updateTriggers: {
          getRadius: [counts, props.selected, props.target, hovered],
          getFillColor: [counts],
          getLineColor: [counts, props.selected, props.target, hovered],
          getLineWidth: [props.selected, props.target, hovered],
        },
      }),
      new TextLayer<number>({
        id: "labels",
        // Label every stop only when there are few; a hub's 200+ codes would just overlap.
        // The selected and hovered airports get HTML labels instead.
        data:
          highlighted.size <= MAX_LABELS
            ? [...highlighted].filter((i) => i !== props.selected && i !== hovered)
            : [],
        getPosition: pos,
        getText: (i) => s.airports.code[i]!,
        getSize: 11,
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
    view,
    hovered,
    hoveredRoute,
  ]);

  // Screen position of an airport, for the HTML labels.
  const at = (i: number) => {
    const p = mapInstance?.project([
      props.snapshot.airports.lon[i]!,
      props.snapshot.airports.lat[i]!,
    ]);
    return p ? { left: p.x, top: p.y } : null;
  };
  const name = (i: number) =>
    `${airportLabel(props.snapshot, i)} (${props.snapshot.airports.code[i]})`;
  const originAt = props.selected !== null && layersModule ? at(props.selected) : null;
  const hoverAt =
    hovered !== null && hovered !== props.selected ? { left: hover!.x, top: hover!.y } : null;

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" aria-label="World map of airline routes" />
      {originAt && props.selected !== null && (
        <div className="map-chip origin" style={originAt}>
          <span>{name(props.selected)}</span>
          <button
            type="button"
            aria-label={`Clear ${props.snapshot.airports.code[props.selected]}`}
            onClick={props.onClear}
          >
            ×
          </button>
        </div>
      )}
      {hoverAt && hovered !== null && (
        <div className="map-chip hover" style={hoverAt} role="tooltip">
          {name(hovered)}
        </div>
      )}
    </div>
  );
}
