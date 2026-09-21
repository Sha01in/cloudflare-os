import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findWorkerdBinary } from "./serve.ts";

const WORKERD_BIN = findWorkerdBinary();
const PORT = 8797;
const TEST_URL = `http://127.0.0.1:${PORT}`;

const HARNESS_JS = `
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/kv-put') {
      const body = await req.text();
      await env.KV.put('test-key', body);
      return new Response('kv-ok');
    }
    if (url.pathname === '/kv-get') {
      const val = await env.KV.get('test-key');
      return new Response(val ?? 'null');
    }
    if (url.pathname === '/r2-put') {
      const body = await req.text();
      await env.R2.put('test-doc', body, { httpMetadata: { contentType: 'text/plain' } });
      return new Response('r2-ok');
    }
    if (url.pathname === '/r2-get') {
      const obj = await env.R2.get('test-doc');
      if (!obj) return new Response('null');
      const text = await new Response(obj.body).text();
      return new Response(JSON.stringify({ text, contentType: obj.httpMetadata?.contentType }));
    }
    if (url.pathname === '/ai-fetch') {
      const res = await env.AI.fetch('http://ai.invalid');
      return new Response(await res.text(), { status: res.status });
    }
    if (url.pathname === '/ai-gateway-log') {
      try {
        await env.AI.gateway().getLog('test');
        return new Response('unexpected-success');
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  }
};
`;

function writeTestConfig(targetDir: string, stateDir: string): string {
  const capnpPath = join(targetDir, "test.capnp");
  copyFileSync(join(process.cwd(), "workerd", "platform-services.js"), join(targetDir, "platform-services.js"));
  writeFileSync(join(targetDir, "harness.js"), HARNESS_JS);

  const capnpContent = `
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "durable-object-storage",
      disk = (path = "${join(stateDir, "durable-objects")}", writable = true)),
    (name = "object-storage",
      disk = (path = "${join(stateDir, "objects")}", writable = true)),

    (name = "platform-services",
      worker = (
        modules = [
          (name = "platform-services.js", esModule = embed "platform-services.js")
        ],
        compatibilityDate = "2026-09-04",
        compatibilityFlags = ["allow_irrevocable_stub_storage"],
        bindings = [
          (name = "DATA", service = "object-storage")
        ],
        durableObjectNamespaces = [
          (className = "PlatformStorage",
            uniqueKey = "test--platform-services--PlatformStorage--v1",
            enableSql = true)
        ],
        durableObjectStorage = (localDisk = "durable-object-storage")
      )),

    (name = "test-harness",
      worker = (
        modules = [
          (name = "harness.js", esModule = embed "harness.js")
        ],
        compatibilityDate = "2026-09-04",
        bindings = [
          (name = "KV",
            service = (name = "platform-services", entrypoint = "KvNamespace",
              props = (json = "{\\"namespace\\":\\"test-ns\\"}"))),
          (name = "R2",
            service = (name = "platform-services", entrypoint = "R2Bucket",
              props = (json = "{\\"namespace\\":\\"test-bucket\\"}"))),
          (name = "AI",
            service = (name = "platform-services", entrypoint = "WorkersAi"))
        ]
      ))
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "test-harness")
  ]
);
`;

  writeFileSync(capnpPath, capnpContent);
  return capnpPath;
}

async function pollUntilReady(url: string, maxAttempts = 30, intervalMs = 150): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status !== 502 && res.status !== 503) return res;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Server at ${url} failed to become ready: ${lastError}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 4000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

test("platform-services KV/R2 persistence, restart preservation, restore, and unsupported operation handling", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "workerd-persistence-test-"));
  const stateDir = join(testDir, "state");
  const doDir = join(stateDir, "durable-objects");
  const objDir = join(stateDir, "objects");

  mkdirSync(doDir, { recursive: true });
  mkdirSync(objDir, { recursive: true });

  const configPath = writeTestConfig(testDir, stateDir);

  const activeProcesses: ChildProcess[] = [];
  t.after(async () => {
    for (const proc of activeProcesses) {
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function startInstance(cfg: string): ChildProcess {
    const child = spawn(WORKERD_BIN, ["serve", "--experimental", cfg], {
      stdio: "pipe",
    });
    activeProcesses.push(child);
    return child;
  }

  // 1. Boot test harness workerd instance
  let currentChild: ChildProcess | null = startInstance(configPath);

  // Verify server is ready
  await pollUntilReady(`${TEST_URL}/kv-get`);

  // 2. Test KV put and get
  const kvPutRes = await fetch(`${TEST_URL}/kv-put`, { method: "POST", body: "hello-workerd-kv" });
  assert.equal(kvPutRes.status, 200);
  assert.equal(await kvPutRes.text(), "kv-ok");

  const kvGetRes = await fetch(`${TEST_URL}/kv-get`);
  assert.equal(await kvGetRes.text(), "hello-workerd-kv");

  // 3. Test R2 put and get
  const r2PutRes = await fetch(`${TEST_URL}/r2-put`, { method: "POST", body: "hello-workerd-r2-document" });
  assert.equal(r2PutRes.status, 200);
  assert.equal(await r2PutRes.text(), "r2-ok");

  const r2GetRes = await fetch(`${TEST_URL}/r2-get`);
  assert.equal(r2GetRes.status, 200);
  const r2Data = (await r2GetRes.json()) as { text: string; contentType: string };
  assert.equal(r2Data.text, "hello-workerd-r2-document");
  assert.equal(r2Data.contentType, "text/plain");

  // 4. Test unsupported Workers AI operations
  const aiFetchRes = await fetch(`${TEST_URL}/ai-fetch`, { method: "POST" });
  assert.equal(aiFetchRes.status, 501);
  const aiFetchText = await aiFetchRes.text();
  assert.match(aiFetchText, /Configure a BYOK model/);

  const aiGatewayRes = await fetch(`${TEST_URL}/ai-gateway-log`, { method: "POST" });
  assert.equal(aiGatewayRes.status, 500);
  const aiGatewayText = await aiGatewayRes.text();
  assert.match(aiGatewayText, /AI Gateway accounting and cost logging are not supported/);

  // 5. Verify files exist on disk in stateDir
  assert.ok(existsSync(doDir), "durable-objects storage dir exists");
  assert.ok(existsSync(objDir), "objects storage dir exists");
  assert.ok(readdirSync(doDir).length > 0, "Durable Object SQLite files written");
  assert.ok(readdirSync(objDir).length > 0, "Object storage files written");

  // 6. Stop instance
  await stopProcess(currentChild);
  currentChild = null;

  // 7. Restart with SAME state directory
  currentChild = startInstance(configPath);
  await pollUntilReady(`${TEST_URL}/kv-get`);

  // Verify state survived restart
  const restartedKvGet = await fetch(`${TEST_URL}/kv-get`);
  assert.equal(await restartedKvGet.text(), "hello-workerd-kv");

  const restartedR2Get = await fetch(`${TEST_URL}/r2-get`);
  const restartedR2Data = (await restartedR2Get.json()) as { text: string };
  assert.equal(restartedR2Data.text, "hello-workerd-r2-document");

  await stopProcess(currentChild);
  currentChild = null;

  // 8. Restore into a fresh state directory
  const restoredStateDir = join(testDir, "restored-state");
  cpSync(stateDir, restoredStateDir, { recursive: true });

  const restoredConfigDir = join(testDir, "restored-config");
  mkdirSync(restoredConfigDir, { recursive: true });
  const restoredConfigPath = writeTestConfig(restoredConfigDir, restoredStateDir);

  currentChild = startInstance(restoredConfigPath);
  await pollUntilReady(`${TEST_URL}/kv-get`);

  // Verify state is present in restored directory
  const restoredKvGet = await fetch(`${TEST_URL}/kv-get`);
  assert.equal(await restoredKvGet.text(), "hello-workerd-kv");

  const restoredR2Get = await fetch(`${TEST_URL}/r2-get`);
  const restoredR2Data = (await restoredR2Get.json()) as { text: string };
  assert.equal(restoredR2Data.text, "hello-workerd-r2-document");

  await stopProcess(currentChild);
  currentChild = null;
});
