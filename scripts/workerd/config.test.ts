import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { readDeployablePackages } from "../release/manifest-lib.ts";

const CONFIG = readFileSync("workerd/config.capnp", "utf8");
const PACKAGES = readDeployablePackages("packages");

function capnpConstantName(packageName: string): string {
  return packageName.replace(/-([a-z0-9])/g, (_match, character: string) =>
    character.toUpperCase()) + "Modules";
}

function serviceBlock(serviceName: string): string {
  const marker = `    (name = "${serviceName}",`;
  const start = CONFIG.indexOf(marker);
  assert.notEqual(start, -1, `missing service ${serviceName}`);
  const nextService = CONFIG.indexOf("\n    (name = \"", start + marker.length);
  const end = nextService < 0 ? CONFIG.indexOf("\n  ],", start) : nextService;
  assert.notEqual(end, -1, `unterminated service ${serviceName}`);
  return CONFIG.slice(start, end);
}

function bindingName(packageName: string): string {
  return `GATEKEEPER_${packageName.slice("gatekeeper-".length).toUpperCase().replaceAll("-", "_")}`;
}

test("the raw config includes every deployable Worker bundle", () => {
  for (const pkg of PACKAGES) {
    assert.match(
      serviceBlock(pkg.name),
      new RegExp(`modules = Bundles\\.${capnpConstantName(pkg.name)}`),
      pkg.name,
    );
  }
});

test("the raw config preserves every Worker's compatibility settings", () => {
  for (const pkg of PACKAGES) {
    const block = serviceBlock(pkg.name);
    assert.ok(
      block.includes(`compatibilityDate = "${pkg.config.compatibility_date}"`),
      `${pkg.name} compatibility date`,
    );
    const rawFlags = block.match(/compatibilityFlags = \[([\s\S]*?)\]/)?.[1] ?? "";
    const flags = [...rawFlags.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(flags, pkg.config.compatibility_flags ?? [], `${pkg.name} compatibility flags`);
  }
});

test("every migrated SQLite Durable Object has stable local storage", () => {
  const uniqueKeys: string[] = [];
  for (const pkg of PACKAGES) {
    const block = serviceBlock(pkg.name);
    const expectedClasses = (pkg.config.migrations ?? [])
      .flatMap(migration => migration.new_sqlite_classes ?? []);
    const declarations = [...block.matchAll(
      /\(className = "([^"]+)",[\s\S]*?uniqueKey = "([^"]+)",\s*enableSql = true\)/g,
    )];
    assert.deepEqual(
      declarations.map(match => match[1]),
      expectedClasses,
      `${pkg.name} Durable Object classes`,
    );
    uniqueKeys.push(...declarations.map(match => match[2]));
    if (expectedClasses.length > 0) {
      assert.match(block, /durableObjectStorage = \(localDisk = "durable-object-storage"\)/);
    }
  }

  const platform = serviceBlock("platform-services");
  const platformKey = platform.match(/uniqueKey = "([^"]+)"/)?.[1];
  assert.ok(platformKey, "platform metadata Durable Object has a unique key");
  uniqueKeys.push(platformKey);
  assert.equal(new Set(uniqueKeys).size, uniqueKeys.length, "Durable Object keys are unique");
  for (const key of uniqueKeys) {
    assert.match(key, /^[A-Za-z0-9._-]+$/, `portable uniqueKey: ${key}`);
  }
});

test("router and backend both receive every gatekeeper", () => {
  const router = serviceBlock("router");
  const backend = serviceBlock("workshop-backend");
  for (const pkg of PACKAGES.filter(candidate => candidate.name.startsWith("gatekeeper-"))) {
    const name = bindingName(pkg.name);
    assert.ok(
      router.includes(`(name = "${name}", service = "${pkg.name}")`),
      `router binding for ${pkg.name}`,
    );
    assert.match(
      backend,
      new RegExp(
        `name = "${name}"[\\s\\S]*?name = "${pkg.name}", entrypoint = "GatekeeperVendor"`,
      ),
      `backend vendor binding for ${pkg.name}`,
    );
  }
});

test("hosted platform bindings are local JSRPC services", () => {
  const backend = serviceBlock("workshop-backend");
  for (const [binding, entrypoint] of [
    ["BLUEPRINTS", "KvNamespace"],
    ["AVATARS", "KvNamespace"],
    ["BLUEPRINT_CONTENT", "R2Bucket"],
    ["WORKERS_AI", "WorkersAi"],
  ]) {
    assert.match(
      backend,
      new RegExp(
        `name = "${binding}"[\\s\\S]*?name = "platform-services", entrypoint = "${entrypoint}"`,
      ),
    );
  }
  assert.match(
    serviceBlock("gatekeeper-context"),
    /name = "CONTEXT_COLLECTIONS"[\s\S]*?entrypoint = "KvNamespace"/,
  );
  assert.doesNotMatch(CONFIG, /\b(?:kvNamespace|r2Bucket)\s*=/);
});

test("workshop-backend declares configurable PUBLIC_BASE_URL, auth, and shared provider bindings", () => {
  const backend = serviceBlock("workshop-backend");
  assert.match(backend, /\(name = "PUBLIC_BASE_URL", fromEnvironment = "PUBLIC_BASE_URL"\)/);
  assert.match(backend, /\(name = "AUTH_GATEKEEPERS", fromEnvironment = "AUTH_GATEKEEPERS"\)/);
  assert.match(backend, /\(name = "DISABLE_PASSWORD_AUTH", fromEnvironment = "DISABLE_PASSWORD_AUTH"\)/);
  assert.match(backend, /\(name = "ADMINS", fromEnvironment = "ADMINS"\)/);
  assert.match(backend, /\(name = "CF_AI_GATEWAY", fromEnvironment = "CF_AI_GATEWAY"\)/);
  assert.match(backend, /\(name = "CF_AI_GATEWAY_PROVIDERS", fromEnvironment = "CF_AI_GATEWAY_PROVIDERS"\)/);
  assert.match(backend, /\(name = "CF_AI_GATEWAY_ACCOUNT_ID", fromEnvironment = "CF_AI_GATEWAY_ACCOUNT_ID"\)/);
  assert.match(backend, /\(name = "CF_AI_GATEWAY_API_TOKEN", fromEnvironment = "CF_AI_GATEWAY_API_TOKEN"\)/);
  assert.match(backend, /\(name = "CF_AI_GATEWAY_USE_BINDING", fromEnvironment = "CF_AI_GATEWAY_USE_BINDING"\)/);
  assert.match(backend, /\(name = "LOADER", workerLoader = \(id = "cloudflare-os-gadgets"\)\)/);
});

test("gatekeepers configure credentials and base URLs via environment variables", () => {
  const google = serviceBlock("gatekeeper-google");
  assert.match(google, /\(name = "BASE_URL", fromEnvironment = "GATEKEEPER_GOOGLE_BASE_URL"\)/);
  assert.match(google, /\(name = "CLIENT_ID", fromEnvironment = "GOOGLE_CLIENT_ID"\)/);
  assert.match(google, /\(name = "CLIENT_SECRET", fromEnvironment = "GOOGLE_CLIENT_SECRET"\)/);

  const github = serviceBlock("gatekeeper-github");
  assert.match(github, /\(name = "BASE_URL", fromEnvironment = "GATEKEEPER_GITHUB_BASE_URL"\)/);
  assert.match(github, /\(name = "CLIENT_ID", fromEnvironment = "GITHUB_CLIENT_ID"\)/);
  assert.match(github, /\(name = "CLIENT_SECRET", fromEnvironment = "GITHUB_CLIENT_SECRET"\)/);
});

test("serve script enables the Worker Loader and configures directories", () => {
  const rootPackage = JSON.parse(readFileSync(join("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(rootPackage.scripts["workerd:serve"], /node scripts\/workerd\/serve\.ts/);
  const serveScript = readFileSync("scripts/workerd/serve.ts", "utf8");
  assert.match(serveScript, /--experimental/);
  assert.match(serveScript, /durable-object-storage=/);
  assert.match(serveScript, /object-storage=/);
  assert.match(serveScript, /WORKERD_BIN/);
});
