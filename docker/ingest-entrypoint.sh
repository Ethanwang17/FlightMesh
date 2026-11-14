#!/bin/sh
# Runs the pipeline once if nothing has been published yet, then hands over to cron.
set -e
mkdir -p /data/reports /data/publish
if [ ! -f /data/publish/snapshot.json ]; then
  echo "No snapshot yet: running the first refresh (about an hour; later runs take minutes)."
  (cd /app && pnpm -s ingest refresh) || echo "First refresh failed; see /data/reports. Cron will retry."
fi
echo "Waiting for the weekly schedule ($(cat /etc/crontabs/root | grep -v '^#' | head -1 | cut -d' ' -f1-5))."
exec crond -f -l 8
