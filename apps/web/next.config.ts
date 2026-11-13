import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for the homelab Docker image (Phase 8).
  output: "standalone",
  // The shared package ships TypeScript source.
  transpilePackages: ["@flightmesh/shared"],
};

export default nextConfig;
