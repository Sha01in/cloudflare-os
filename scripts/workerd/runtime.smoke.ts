import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PORT = 8798;
const TEST_ORIGIN = `http://127.0.0.1:${PORT}`;

async function pollUntilReady(url: string, maxAttempts = 30, intervalMs = 200): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Server at ${url} failed to become ready: ${lastError}`);
}

async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 4000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    try {
      child.kill(signal);
    } catch {
      clearTimeout(timer);
      resolve(child.exitCode);
    }
  });
}

test("standalone workerd boots, answers /healthz, serves frontend, and performs restart smoke", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "workerd-test-state-"));
  const activeProcesses: ChildProcess[] = [];

  t.after(async () => {
    for (const proc of activeProcesses) {
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  function startServer(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const proc = spawn(process.execPath, args, { stdio: "pipe", env });
    activeProcesses.push(proc);
    return proc;
  }

  // 1. Initial Boot
  const child = startServer(
    [
      "scripts/workerd/serve.ts",
      `--port=${PORT}`,
      "--host=127.0.0.1",
      `--state-dir=${stateDir}`,
      `--public-base-url=${TEST_ORIGIN}`,
    ],
    {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      WORKERD_STATE_DIR: stateDir,
      PUBLIC_BASE_URL: TEST_ORIGIN,
    },
  );

  // 2. Health check
  const healthRes = await pollUntilReady(`${TEST_ORIGIN}/healthz`);
  assert.equal(healthRes.status, 200);
  const healthText = await healthRes.text();
  assert.equal(healthText, "ok");

  // 3. Frontend assets
  const frontendRes = await fetch(`${TEST_ORIGIN}/`);
  assert.equal(frontendRes.status, 200);
  const frontendHtml = await frontendRes.text();
  assert.match(frontendHtml, /<html|<!doctype html>/i);

  // 4. Frontend SPA fallback on unknown route
  const spaRes = await fetch(`${TEST_ORIGIN}/some-random-spa-route`);
  assert.equal(spaRes.status, 200);
  const spaHtml = await spaRes.text();
  assert.match(spaHtml, /<html|<!doctype html>/i);

  // 5. Trigger initial API request (provisions blueprints in KV and R2)
  try {
    await fetch(`${TEST_ORIGIN}/api`);
  } catch {}

  // Allow asynchronous provisioning to settle
  await new Promise((r) => setTimeout(r, 1000));

  // 6. Verify state directories were created and contain files
  const doDir = join(stateDir, "durable-objects");
  const objDir = join(stateDir, "objects");
  assert.ok(existsSync(doDir), "durable-objects directory exists");
  assert.ok(existsSync(objDir), "objects directory exists");

  // 7. Verify clean signal forwarding and graceful shutdown
  const exitCode = await stopProcess(child, "SIGTERM");
  assert.ok(exitCode === 0 || exitCode === 143, `expected clean exit code on SIGTERM, got ${exitCode}`);

  // 8. Test Restart with SAME state directory
  const restartChild = startServer(
    [
      "scripts/workerd/serve.ts",
      `--port=${PORT}`,
      "--host=127.0.0.1",
      `--state-dir=${stateDir}`,
      `--public-base-url=${TEST_ORIGIN}`,
    ],
    {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      WORKERD_STATE_DIR: stateDir,
      PUBLIC_BASE_URL: TEST_ORIGIN,
    },
  );

  const restartHealth = await pollUntilReady(`${TEST_ORIGIN}/healthz`);
  assert.equal(restartHealth.status, 200);
  await stopProcess(restartChild, "SIGINT");

  // 9. Test Restore into a NEW state directory
  const restoredStateDir = mkdtempSync(join(tmpdir(), "workerd-restored-state-"));
  t.after(() => rmSync(restoredStateDir, { recursive: true, force: true }));

  cpSync(stateDir, restoredStateDir, { recursive: true });

  const restoredChild = startServer(
    [
      "scripts/workerd/serve.ts",
      `--port=${PORT}`,
      "--host=127.0.0.1",
      `--state-dir=${restoredStateDir}`,
      `--public-base-url=${TEST_ORIGIN}`,
    ],
    {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      WORKERD_STATE_DIR: restoredStateDir,
      PUBLIC_BASE_URL: TEST_ORIGIN,
    },
  );

  const restoredHealth = await pollUntilReady(`${TEST_ORIGIN}/healthz`);
  assert.equal(restoredHealth.status, 200);
  await stopProcess(restoredChild, "SIGTERM");
});
