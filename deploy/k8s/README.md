# Single-instance self-hosted image

This image runs standalone `workerd 1.20260831.1` with prebuilt Worker bundles and
frontend assets. Wrangler is used only for build-time dry-run bundling. The running
container needs neither Wrangler nor a dependency tree.

## Build and exercise recovery

Use Node 22 and `pnpm install --frozen-lockfile` on the host for the acceptance probe.

```sh
# Native local architecture, for the complete local recovery test:
docker build -f deploy/k8s/Dockerfile -t cloudflareos-mvp:local .
deploy/k8s/smoke-test.sh cloudflareos-mvp:local

# Kubernetes target artifact; this does not publish or deploy it:
docker build --platform linux/amd64 -f deploy/k8s/Dockerfile \
  -t cloudflareos-mvp:amd64 .
```

The smoke test creates disposable loopback-only containers and volumes. It saves
two users, a profile/avatar, workspace metadata, human chat, gadget code, a gadget
counter, and a callback persisted in Durable Object storage. It checks cross-user
access denial, kills the container, verifies recovery, stops it, copies the entire
state into a fresh volume, and verifies again. It removes only those test resources
on exit. These fixtures use fresh password login; existing browser sessions and
external OAuth/provider flows are separate rollout checks.

For a separately managed disposable local server:

```sh
node deploy/k8s/verify-state.mjs seed \
  --url http://127.0.0.1:8787 --record /tmp/cloudflareos-fixture.json
# Restart, or restore full state into a fresh directory, before the next command.
node deploy/k8s/verify-state.mjs verify \
  --url http://127.0.0.1:8787 --record /tmp/cloudflareos-fixture.json
```

The probe refuses non-loopback URLs and creates its fixture record exclusively
with mode 0600. Any coverage gap is a failure, not a passing persistence result.

The full-runtime smoke needs the prebuilt standalone bundles and therefore stays
outside the repository's ordinary `*.test.ts` discovery. Run the focused suite
explicitly after `pnpm workerd:build`:

```sh
pnpm exec node --test scripts/workerd/*.test.ts \
  scripts/workerd/runtime.smoke.ts deploy/k8s/verify-state.test.mjs
```

## Runtime contract

- One active process owns `/data/workerd`; use one replica and `Recreate`.
- Port 8787, `GET /healthz`, non-root UID/GID 1000. A Kubernetes PVC needs fsGroup 1000.
- Supply the canonical HTTPS `PUBLIC_BASE_URL`, `AUTH_GATEKEEPERS=google`,
  `DISABLE_PASSWORD_AUTH=true`, Google client credentials, and explicit `ADMINS`
  through the existing internal-tools configuration and secret mechanism.
- Corporate ingress OAuth and application Google login are separate gates.
- Back up the entire state directory while stopped. Preserve the immutable image
  containing the namespace definitions with every backup. Never mount an existing
  Wrangler persistence directory as native workerd state.

See [runtime configuration](../../workerd/README.md) for supported settings and
Cloudflare-only limitations. BYOK/SuperGrok uses the existing application paths;
Workers AI inference and browser rendering are not implemented by this image.

This is not HA: restarts and upgrades interrupt requests, and a zone outage can
require recovery from a snapshot. A PVC persists accepted writes but is not a
backup. Browser-local drafts and in-flight model/tool execution are not process
checkpoints. The infrastructure companion provides manual quiesced snapshots and
new-PVC restoration; backup scheduling and live restore drills belong to rollout.
