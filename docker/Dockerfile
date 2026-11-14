# FlightMesh: one Dockerfile, two targets.
#   web     Next.js standalone server (reads the published snapshot from the data volume)
#   ingest  Data pipeline on a weekly cron (writes the database, reports and snapshot to the volume)

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Dependencies, cached until a manifest or the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ingest/package.json packages/ingest/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# ---------------------------------------------------------------- web
FROM source AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @flightmesh/web build

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    FLIGHTMESH_SNAPSHOT=/data/publish/snapshot.json
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------- ingest
FROM source AS ingest
ENV FLIGHTMESH_DATA_DIR=/data FLIGHTMESH_PUBLISH_DIR=/data/publish
COPY docker/crontab /etc/crontabs/root
COPY docker/ingest-entrypoint.sh /usr/local/bin/ingest-entrypoint
RUN chmod +x /usr/local/bin/ingest-entrypoint
CMD ["ingest-entrypoint"]
