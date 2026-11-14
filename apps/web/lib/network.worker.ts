/// <reference lib="webworker" />
// Filtering and 1-stop search run here so the map stays responsive. Pure logic lives in
// @flightmesh/shared (network.ts) and is unit-tested there.
import {
  buildIndex,
  destinationCounts,
  destinationsFrom,
  findItineraries,
  programsCovering,
  programsInPlay,
  routeFilter,
  type NetworkIndex,
  type Snapshot,
} from "@flightmesh/shared";
import type { ViewRequest, ViewResult, WorkerRequest } from "./protocol";

let index: NetworkIndex | null = null;

function view(req: ViewRequest): ViewResult {
  const idx = index!;
  const pass = routeFilter(idx, req.filters);
  const programs = programsInPlay(idx.snapshot, req.filters);
  const from = req.airport ? idx.airportIndex.get(req.airport) : undefined;
  const to = req.to ? idx.airportIndex.get(req.to) : undefined;
  const destinations =
    from !== undefined
      ? destinationsFrom(idx, from, pass).map((d) => ({
          ...d,
          programs: [...new Set(d.routes.flatMap((i) => programsCovering(idx, i, programs)))],
        }))
      : [];
  const routing =
    from !== undefined && to !== undefined && from !== to
      ? findItineraries(idx, from, to, pass, { maxDetour: req.showAll ? Infinity : 1.5, programs })
      : null;
  return { id: req.id, counts: destinationCounts(idx, pass), destinations, routing, programs };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    index = buildIndex(msg.snapshot as Snapshot);
    self.postMessage({ type: "ready" });
    return;
  }
  if (!index) return;
  const result = view(msg);
  self.postMessage({ type: "view", result }, [result.counts.buffer]);
};
