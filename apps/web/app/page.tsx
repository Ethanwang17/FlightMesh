import { Suspense } from "react";
import { FlightMesh } from "@/components/FlightMesh";

export default function Home() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <FlightMesh />
    </Suspense>
  );
}
