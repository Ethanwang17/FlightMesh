import type {
  Destination,
  NetworkFilters,
  ProgramId,
  RoutingResult,
  Snapshot,
} from "@flightmesh/shared";

export interface ViewRequest {
  type: "view";
  id: number;
  filters: NetworkFilters;
  airport: string | null;
  to: string | null;
  showAll: boolean;
}

export type WorkerRequest = { type: "init"; snapshot: Snapshot } | ViewRequest;

export interface DestinationView extends Destination {
  /** Programs in play that cover at least one airline on this route. */
  programs: ProgramId[];
}

export interface ViewResult {
  id: number;
  /** Filtered nonstop destinations per airport index. */
  counts: Uint16Array;
  destinations: DestinationView[];
  routing: RoutingResult | null;
  programs: ProgramId[];
}

export type WorkerResponse = { type: "ready" } | { type: "view"; result: ViewResult };
