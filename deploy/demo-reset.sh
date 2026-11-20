#!/usr/bin/env bash
# Resets the public demo to its made-up seed data: users, properties, photos, portal listings
# and jobs. Run it once after the first deploy, then every night from cron (docs/deploy.md).
#
# The API and the worker are stopped first, so no job is half-way through and no upload is being
# stored while the tables and the photo folders are replaced (visitors get a few seconds of 502
# at night), and started again afterwards, also when the seed fails (the old data then stays:
# the seed replaces everything in one transaction). The seed refuses to run unless
# ALLOW_DEMO_SEED is true, which compose.yml sets only when DEMO_MODE=true.
set -euo pipefail

cd "$(dirname "$0")"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) demo-reset: $*"; }

log 'stopping the API and the worker'
docker compose stop worker api
trap 'log "starting the API and the worker"; docker compose up -d --wait api worker' EXIT

log 'loading the demo data'
docker compose run --rm --no-deps api node dist/db/seed.js
log 'done'
