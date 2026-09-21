# Standalone workerd for Cloudflare OS

[`config.capnp`](config.capnp) describes a complete single-process Cloudflare OS deployment: the
public router, Workshop backend, every gatekeeper Worker, their Durable Object namespaces, the
Gadget Worker Loader, and the frontend asset service.

## Quickstart

From the repository root:

```sh
pnpm install
pnpm workerd:build
pnpm workerd:serve
```

Then open <http://localhost:8787>.

- `pnpm workerd:build` (`node scripts/workerd/build.ts`): Prepares prerequisite generated code,
  builds frontend static assets, runs `wrangler deploy --dry-run` to bundle each Worker, and generates
  `workerd/dist/modules.capnp`.
- `pnpm workerd:serve` (`node scripts/workerd/serve.ts`): Starts the standalone `workerd` runtime
  pointing to prebuilt bundles and state directories, forwarding signals and configuring
  environment variables.

## Container & Runtime Contract

The container entrypoint executes:
```sh
exec node scripts/workerd/serve.ts "$@"
```

### Environment Variables & Validation

The launcher (`scripts/workerd/serve.ts`) enforces strict fail-closed startup validation using Node builtins:

| Variable | Description | Default / Requirement |
| --- | --- | --- |
| `WORKERD_BIN` | Absolute path to the `workerd` executable | Local package or `/usr/local/bin/workerd` |
| `WORKERD_STATE_DIR` | Persistent storage directory for DO SQLite and object blobs | `/data/workerd` (container) or `workerd/state` (local) |
| `PUBLIC_BASE_URL` | Canonical public origin for ingress and OAuth callbacks | Required when `NODE_ENV=production` (including the container). Example: `https://cloudflare-os-nonprod-k8s.internal.conduit.inc`. HTTPS required except loopback (`localhost`, `127.0.0.1`, `::1`). Must have no path, query, or credentials. |
| `LISTEN_ADDR` | Bind address and port for HTTP server | `0.0.0.0:8787` |
| `PORT` / `HOST` | Alternative configuration for port and host | `8787` / `0.0.0.0` |
| `ADMINS` | JSON array of initial administrator usernames | Defaults to `[]` (safe empty default; explicit operator configuration required for initial admin access) |
| `AUTH_GATEKEEPERS` | Comma-separated list of gatekeeper vendors permitted for sign-in | e.g. `google` |
| `DISABLE_PASSWORD_AUTH` | Disable password auth; requires at least one gatekeeper in `AUTH_GATEKEEPERS` | `false` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials | Required if `AUTH_GATEKEEPERS` includes `google`. Missing secrets fail closed at boot without leaking credentials. |

The other supported sign-in vendors are `github` and `cloudflare`; enabling them
requires `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` or
`CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET`, respectively.
Unknown sign-in vendors are rejected. This does not prevent using other
gatekeepers as connectors after signing in.

### Unsupported Flags & Features

The standalone launcher strictly rejects Cloudflare-managed cloud features:
- `ENABLE_CLOUDFLARE_LIMITS`: Must be `false` (or unset); hosted rate limits are not supported in standalone workerd.
- `CF_AI_GATEWAY_USE_BINDING`: Must be `false` (or unset); AI Gateway binding is not supported in standalone workerd.
- **Workers AI Local Inference:** Standalone workerd does not run local LLM inference models (returns HTTP 501). Direct BYOK (Bring Your Own Key) provider credentials or SuperGrok models must be configured.
- **AI Gateway Accounting & Cost Logging:** `AiGateway.getLog()` explicitly throws an unsupported error (HTTP 500) rather than faking zero usage.
- **Browser Rendering:** Cloudflare Browser Rendering is unsupported. Browser-based screenshot/PDF renders fail cleanly with explicit error.

### Persistence, Backup, and Restore Model

- **State Directory Layout:**
  - `$WORKERD_STATE_DIR/durable-objects`: Holds SQLite databases for all Durable Object namespaces.
  - `$WORKERD_STATE_DIR/objects`: Holds content-addressed file payloads for local KV and R2.
  - `PlatformStorage` Durable Object manages authoritative metadata for KV and R2.
- **Stable Namespaces:**
  - Durable Object unique keys are explicitly declared and stable across restarts (e.g. `cloudflare-os--workshop-backend--UserDirectoryDurableObject--v1`).
- **Backup & Restore Strategy:**
  - Backup must capture the entire `$WORKERD_STATE_DIR` directory after quiescing the application (not single SQLite files).
  - Restore should always target a **new PVC or fresh state directory** before starting the pod; never overwrite a running live volume in-place.
