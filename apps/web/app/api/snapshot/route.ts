import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Read on every request: the ingest job replaces the file weekly while the server keeps running.
// The path is runtime configuration (the data volume), so the build must not try to trace it.
export const dynamic = "force-dynamic";

/** Path of the published snapshot. In Docker it lives on the shared data volume. */
const snapshotPath = () =>
  process.env.FLIGHTMESH_SNAPSHOT ?? join(process.cwd(), "public", "data", "snapshot.json");

export async function GET(request: Request): Promise<Response> {
  const file = snapshotPath();
  try {
    const info = await stat(/*turbopackIgnore: true*/ file);
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": "application/json",
      ETag: etag,
      "Last-Modified": info.mtime.toUTCString(),
      // Browsers revalidate each visit; a 304 is cheap.
      "Cache-Control": "public, max-age=0, must-revalidate",
    };
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    return new Response(await readFile(/*turbopackIgnore: true*/ file), { headers });
  } catch {
    return Response.json(
      {
        error:
          "No route snapshot yet. Run `pnpm ingest refresh` (or wait for the ingest container's first run).",
      },
      { status: 503 },
    );
  }
}
