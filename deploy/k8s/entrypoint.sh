#!/bin/sh
set -eu
export WORKERD_STATE_DIR="${WORKERD_STATE_DIR:-/data/workerd}"
export WORKERD_BIN="${WORKERD_BIN:-/usr/local/bin/workerd}"
mkdir -p "$WORKERD_STATE_DIR"
cd /app
exec node scripts/workerd/serve.ts "$@"
