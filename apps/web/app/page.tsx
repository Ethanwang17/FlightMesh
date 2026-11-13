import { WorldMap } from "@/components/WorldMap";

export default function Home() {
  return (
    <main className="app">
      <div className="brand">
        FlightMesh
        <span>Routes, alliances and points programs</span>
      </div>
      <WorldMap />
    </main>
  );
}
