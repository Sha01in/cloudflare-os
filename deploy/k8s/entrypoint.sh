#!/bin/sh
set -eu
mkdir -p /data/wrangler
export WRANGLER_PERSIST="${WRANGLER_PERSIST:-/data/wrangler}"
export WRANGLER_DEV_IP="${WRANGLER_DEV_IP:-0.0.0.0}"
cd /app
exec node run-dev-server.js --serve-frontend-assets --port 8787
