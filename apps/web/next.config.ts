import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for the homelab Docker image (Phase 8).
  output: "standalone",
  // Trace files from the monorepo root so the standalone build includes workspace packages.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  // The shared package ships TypeScript source.
  transpilePackages: ["@flightmesh/shared"],
};

export default nextConfig;
