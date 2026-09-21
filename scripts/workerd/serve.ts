#!/usr/bin/env node

// Standalone workerd launcher for Cloudflare OS.
//
// Usage:
//   node scripts/workerd/serve.ts [options] [workerd flags...]
//
// Environment variables:
//   WORKERD_BIN        Path to standalone workerd binary (default: local package or /usr/local/bin/workerd)
//   WORKERD_STATE_DIR  Path to state directory holding durable-objects and objects (default: workerd/state or /data/workerd)
//   PUBLIC_BASE_URL    Public canonical origin (default: http://localhost:8787 in local dev)
//   LISTEN_ADDR        Listen address and port for HTTP (default: 0.0.0.0:8787)
//   PORT / HOST        Alternative listen port and host
//   ADMINS             JSON array of admin usernames (default: "[]")
//   AUTH_GATEKEEPERS   Comma-separated gatekeeper sign-in list (e.g. "google")
//   DISABLE_PASSWORD_AUTH Set to "true" to require OAuth gatekeeper sign-in
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   ... other provider / gatekeeper credentials

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CONFIG_PATH = join(ROOT, "workerd", "config.capnp");

const GATEKEEPER_NAMES = [
  "cloudflare",
  "confluence",
  "context",
  "email",
  "github",
  "google",
  "homeassistant",
  "linear",
  "mcp",
  "mcp-portal",
  "notion",
  "scheduler",
  "slack",
  "spotify",
  "supabase",
  "zoominfo",
];

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function validatePublicBaseUrl(rawUrl: string): string {
  if (!rawUrl.trim()) throw new Error("PUBLIC_BASE_URL is required in production.");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: ${rawUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("PUBLIC_BASE_URL must not contain user credentials.");
  }
  if (parsed.search) {
    throw new Error("PUBLIC_BASE_URL must not contain query parameters.");
  }
  if (parsed.hash) {
    throw new Error("PUBLIC_BASE_URL must not contain a URL hash/fragment.");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `PUBLIC_BASE_URL must be a bare origin without a path prefix (got pathname: ${parsed.pathname}).`,
    );
  }

  if (parsed.protocol === "http:") {
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error(
        `PUBLIC_BASE_URL must use https:// in production. http:// is only permitted on loopback addresses (localhost, 127.0.0.1, [::1]); got: ${rawUrl}`,
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL protocol must be https: (or http: on loopback); got: ${parsed.protocol}`);
  }

  return parsed.origin;
}

export function validateAuthConfig(env: NodeJS.ProcessEnv): void {
  const rawAuthGk = env.AUTH_GATEKEEPERS || "";
  const authGatekeepers = rawAuthGk
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const credentials: Record<string, readonly [string, string]> = {
    google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    cloudflare: ["CLOUDFLARE_OAUTH_CLIENT_ID", "CLOUDFLARE_OAUTH_CLIENT_SECRET"],
  };
  for (const vendor of authGatekeepers) {
    const fields = credentials[vendor];
    if (!fields) throw new Error(`Unsupported sign-in gatekeeper: ${vendor}`);
    const [clientId, clientSecret] = fields;
    if (!env[clientId]?.trim() || !env[clientSecret]?.trim()) {
      throw new Error(
        `AUTH_GATEKEEPERS includes '${vendor}', but ${clientId} or ${clientSecret} is missing. Both must be set.`,
      );
    }
  }

  if (env.DISABLE_PASSWORD_AUTH === "true") {
    if (authGatekeepers.length === 0) {
      throw new Error(
        "DISABLE_PASSWORD_AUTH=true requires at least one gatekeeper in AUTH_GATEKEEPERS (e.g. AUTH_GATEKEEPERS=google); otherwise all sign-in would be disabled.",
      );
    }
  }
}

export function validateUnsupportedFeatures(env: NodeJS.ProcessEnv): void {
  if (env.ENABLE_CLOUDFLARE_LIMITS === "true") {
    throw new Error(
      "ENABLE_CLOUDFLARE_LIMITS=true is not supported in standalone workerd (Cloudflare account billing limits are cloud-only). Use direct BYOK / SuperGrok model configurations.",
    );
  }

  if (env.CF_AI_GATEWAY_USE_BINDING === "true") {
    throw new Error(
      "CF_AI_GATEWAY_USE_BINDING=true is not supported in standalone workerd (the local Workers AI fake does not support AI Gateway inference). Use direct BYOK / SuperGrok model configurations.",
    );
  }
}

export function validateAdminsConfig(rawAdmins?: string): string {
  if (!rawAdmins || !rawAdmins.trim()) {
    return "[]";
  }
  try {
    const parsed = JSON.parse(rawAdmins);
    if (!Array.isArray(parsed)) {
      throw new Error("ADMINS must be a JSON array of usernames (e.g. '[\"user@example.com\"]')");
    }
    return rawAdmins;
  } catch (err) {
    throw new Error(
      `ADMINS must be a JSON array of usernames (e.g. '["user@example.com"]'): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findWorkerdBinary(explicitBin?: string): string {
  if (explicitBin && explicitBin.trim()) {
    const resolved = resolve(explicitBin.trim());
    if (!existsSync(resolved)) {
      throw new Error(`WORKERD_BIN is set to '${explicitBin}', but no such file exists.`);
    }
    if (!isExecutable(resolved)) {
      throw new Error(`WORKERD_BIN file '${explicitBin}' exists but is not executable.`);
    }
    return resolved;
  }

  const candidates = [
    join(ROOT, "node_modules", "workerd", "bin", "workerd"),
    join(ROOT, "node_modules", ".bin", "workerd"),
    "/usr/local/bin/workerd",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }

  // Last resort check PATH
  return "workerd";
}

export function parseArgs(args: string[]): {
  listenAddr: string;
  stateDir: string;
  publicBaseUrl: string;
  configPath: string;
  explicitBin?: string;
  passthrough: string[];
} {
  let host = process.env.HOST || "0.0.0.0";
  let port = process.env.PORT || "8787";
  let listenAddr = process.env.LISTEN_ADDR || `${host}:${port}`;
  let stateDir = process.env.WORKERD_STATE_DIR || join(ROOT, "workerd", "state");
  let publicBaseUrl = process.env.PUBLIC_BASE_URL ||
    (process.env.NODE_ENV === "production" ? "" : `http://localhost:${port}`);
  let configPath = DEFAULT_CONFIG_PATH;
  let explicitBin = process.env.WORKERD_BIN;
  const passthrough: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      port = args[++i];
      listenAddr = `${host}:${port}`;
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
      listenAddr = `${host}:${port}`;
    } else if (arg === "--host" && i + 1 < args.length) {
      host = args[++i];
      listenAddr = `${host}:${port}`;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      listenAddr = `${host}:${port}`;
    } else if (arg === "--socket-addr" && i + 1 < args.length) {
      const val = args[++i];
      listenAddr = val.startsWith("http=") ? val.slice(5) : val;
    } else if (arg.startsWith("--socket-addr=")) {
      const val = arg.slice("--socket-addr=".length);
      listenAddr = val.startsWith("http=") ? val.slice(5) : val;
    } else if (arg === "--state-dir" && i + 1 < args.length) {
      stateDir = resolve(args[++i]);
    } else if (arg.startsWith("--state-dir=")) {
      stateDir = resolve(arg.slice("--state-dir=".length));
    } else if (arg === "--public-base-url" && i + 1 < args.length) {
      publicBaseUrl = args[++i];
    } else if (arg.startsWith("--public-base-url=")) {
      publicBaseUrl = arg.slice("--public-base-url=".length);
    } else if (arg === "--config" && i + 1 < args.length) {
      configPath = resolve(args[++i]);
    } else if (arg.startsWith("--config=")) {
      configPath = resolve(arg.slice("--config=".length));
    } else if (arg === "--workerd-bin" && i + 1 < args.length) {
      explicitBin = args[++i];
    } else if (arg.startsWith("--workerd-bin=")) {
      explicitBin = arg.slice("--workerd-bin=".length);
    } else {
      passthrough.push(arg);
    }
  }

  return { listenAddr, stateDir, publicBaseUrl, configPath, explicitBin, passthrough };
}

function main(): void {
  const { listenAddr, stateDir, publicBaseUrl, configPath, explicitBin, passthrough } = parseArgs(
    process.argv.slice(2),
  );

  // 1. Validate PUBLIC_BASE_URL (HTTPS except localhost/127.0.0.1/[::1])
  const cleanPublicBaseUrl = validatePublicBaseUrl(publicBaseUrl);

  // 2. Validate Authentication settings (Google credentials, password disable logic)
  validateAuthConfig(process.env);

  // 3. Validate unsupported platform feature flags (fail early rather than silent failure)
  validateUnsupportedFeatures(process.env);

  // 4. Validate and set ADMINS (safe empty default "[]")
  const adminsJson = validateAdminsConfig(process.env.ADMINS);

  // 5. Validate WORKERD_BIN (fail if set but invalid/non-executable)
  const workerdBin = findWorkerdBinary(explicitBin);

  // Validate configuration file
  if (!existsSync(configPath)) {
    console.error(`Error: workerd config file not found: ${configPath}`);
    console.error("Please run 'pnpm workerd:build' first to generate worker bundles.");
    process.exit(1);
  }

  // Ensure persistent state directories exist
  const doStorageDir = join(stateDir, "durable-objects");
  const objStorageDir = join(stateDir, "objects");
  mkdirSync(doStorageDir, { recursive: true });
  mkdirSync(objStorageDir, { recursive: true });

  // Assets directory
  const frontendAssetsDir = join(ROOT, "packages", "workshop-frontend", "dist");

  // Prepare environment for workerd and child workers
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PUBLIC_BASE_URL: cleanPublicBaseUrl,
    ADMINS: adminsJson,
    AUTH_GATEKEEPERS: process.env.AUTH_GATEKEEPERS || "",
    DISABLE_PASSWORD_AUTH: process.env.DISABLE_PASSWORD_AUTH || "false",
  };

  // Configure per-gatekeeper BASE_URL defaults under the public origin
  for (const name of GATEKEEPER_NAMES) {
    const envVar = `GATEKEEPER_${name.toUpperCase().replaceAll("-", "_")}_BASE_URL`;
    if (!env[envVar]) {
      env[envVar] = `${cleanPublicBaseUrl}/gatekeeper/${name}`;
    }
  }

  const workerdArgs: string[] = [
    "serve",
    "--experimental",
    configPath,
    `--socket-addr=http=${listenAddr}`,
    `--directory-path=durable-object-storage=${doStorageDir}`,
    `--directory-path=object-storage=${objStorageDir}`,
  ];

  if (existsSync(frontendAssetsDir)) {
    workerdArgs.push(`--directory-path=frontend-assets=${frontendAssetsDir}`);
  }

  workerdArgs.push(...passthrough);

  console.log(`Starting standalone workerd on http://${listenAddr}`);
  console.log(`State directory: ${stateDir}`);
  console.log(`Public origin: ${cleanPublicBaseUrl}`);

  const child = spawn(workerdBin, workerdArgs, {
    stdio: "inherit",
    cwd: ROOT,
    env,
  });

  let exiting = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    if (child.pid && !child.killed) {
      try {
        child.kill(signal);
      } catch {}
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGHUP", () => forwardSignal("SIGHUP"));

  child.on("error", (err) => {
    console.error(`Failed to execute workerd (${workerdBin}):`, err);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (signal === "SIGINT") process.exit(130);
    if (signal === "SIGTERM") process.exit(143);
    process.exit(code ?? 0);
  });
}

// Only execute when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
