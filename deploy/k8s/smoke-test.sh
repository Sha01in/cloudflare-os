#!/bin/sh
# Exercise only disposable local containers and volumes. The image must already be built.
set -eu

image="${1:-cloudflareos-mvp:local}"
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker run --rm -i --entrypoint node "$image" < "$repo_dir/deploy/k8s/verify-https.mjs"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/cloudflareos-smoke.XXXXXX")
run_id="cloudflareos-smoke-$(date +%s)-$$"
container="$run_id"
source_volume="$run_id-source"
restore_volume="$run_id-restore"

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ "$code" -ne 0 ]; then docker logs --tail 80 "$container" >&2 2>/dev/null || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$source_volume" "$restore_volume" >/dev/null 2>&1 || true
  rm -rf "$scratch"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_ready() {
  port=$(docker port "$container" 8787/tcp | sed 's/.*://')
  url="http://127.0.0.1:$port"
  attempts=0
  until curl --fail --silent --max-time 2 "$url/healthz" >/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then echo 'Runtime did not become ready' >&2; return 1; fi
    sleep 1
  done
  curl --fail --silent --max-time 10 "$url/" > "$scratch/index.html"
  if ! grep -qi '<html' "$scratch/index.html"; then echo 'Frontend HTML missing' >&2; return 1; fi
}

start_container() {
  docker run --detach --name "$container" \
    --publish 127.0.0.1::8787 \
    --env PUBLIC_BASE_URL=http://localhost:8787 \
    --env AUTH_GATEKEEPERS= --env DISABLE_PASSWORD_AUTH=false --env 'ADMINS=[]' \
    --mount "type=volume,source=$1,target=/data/workerd" \
    "$image" >/dev/null
  wait_ready
}

docker volume create "$source_volume" >/dev/null
docker volume create "$restore_volume" >/dev/null
start_container "$source_volume"
node "$repo_dir/deploy/k8s/verify-state.mjs" seed --url "$url" --record "$scratch/fixture.json"

# Abrupt termination exercises native SQLite/facet recovery, without an orderly shutdown.
docker kill --signal KILL "$container" >/dev/null
docker start "$container" >/dev/null
wait_ready
node "$repo_dir/deploy/k8s/verify-state.mjs" verify --url "$url" --record "$scratch/fixture.json"

# The backup is a complete quiesced directory, including object payloads and facet metadata.
docker stop --time 10 "$container" >/dev/null
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
if [ "$exit_code" = 137 ]; then echo 'Runtime needed SIGKILL during graceful stop' >&2; exit 1; fi
docker rm "$container" >/dev/null
docker run --rm --user 1000:1000 --entrypoint /bin/sh \
  --mount "type=volume,source=$source_volume,target=/source,readonly" \
  --mount "type=volume,source=$restore_volume,target=/data/workerd" \
  "$image" -c 'cp -a /source/. /data/workerd/'
start_container "$restore_volume"
node "$repo_dir/deploy/k8s/verify-state.mjs" verify --url "$url" --record "$scratch/fixture.json"
echo 'PASS: frontend, saved work, crash restart, graceful stop, and full-state restore'
