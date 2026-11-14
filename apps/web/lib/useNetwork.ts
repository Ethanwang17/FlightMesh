"use client";

import { useEffect, useRef, useState } from "react";
import type { NetworkFilters, Snapshot } from "@flightmesh/shared";
import type { ViewResult, WorkerResponse } from "./protocol";

export const SNAPSHOT_URL = "/api/snapshot";

/** Loads the snapshot once and starts the network worker. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);

  useEffect(() => {
    let cancelled = false;
    const w = new Worker(new URL("./network.worker.ts", import.meta.url), { type: "module" });
    fetch(SNAPSHOT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`snapshot: HTTP ${r.status}`);
        return r.json() as Promise<Snapshot>;
      })
      .then((s) => {
        if (cancelled) return;
        w.onmessage = (e: MessageEvent<WorkerResponse>) => {
          if (e.data.type === "ready" && !cancelled) {
            setSnapshot(s);
            setWorker(w);
          }
        };
        w.postMessage({ type: "init", snapshot: s });
      })
      .catch((err: unknown) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
      w.terminate();
    };
  }, []);

  return { snapshot, worker, error };
}

/** Asks the worker for the current view; ignores answers to superseded requests. */
export function useView(
  worker: Worker | null,
  args: { filters: NetworkFilters; airport: string | null; to: string | null; showAll: boolean },
) {
  const [view, setView] = useState<ViewResult | null>(null);
  const seq = useRef(0);
  const key = JSON.stringify(args);

  useEffect(() => {
    if (!worker) return;
    const id = ++seq.current;
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === "view" && e.data.result.id === seq.current) setView(e.data.result);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ type: "view", id, ...(JSON.parse(key) as typeof args) });
    return () => worker.removeEventListener("message", onMessage);
  }, [worker, key]);

  return view;
}
