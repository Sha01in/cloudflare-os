// Run inside the final image: docker run --rm -i --entrypoint node IMAGE < this-file
// Exercise native workerd's trust store; Node's own bundled CAs would hide failures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const scratch = await mkdtemp(join(tmpdir(), "workerd-https-"));
let runtime;
let exited;
try {
  await writeFile(join(scratch, "worker.js"), `
    export default {
      async fetch(request) {
        if (new URL(request.url).pathname === "/healthz") return new Response("ok");
        const response = await fetch("https://accounts.google.com/.well-known/openid-configuration");
        const discovery = await response.json();
        // An empty POST cannot grant access; its HTTP 400 proves the token host's TLS works.
        const token = await fetch("https://oauth2.googleapis.com/token", { method: "POST" });
        return Response.json({ status: response.status, issuer: discovery.issuer, tokenStatus: token.status });
      }
    };
  `);
  await writeFile(join(scratch, "config.capnp"), `
    using Workerd = import "/workerd/workerd.capnp";
    const config :Workerd.Config = (
      services = [(name = "probe", worker = (
        modules = [(name = "worker.js", esModule = embed "worker.js")],
        compatibilityDate = "2026-08-31"
      ))],
      sockets = [(name = "http", address = "127.0.0.1:18787", http = (), service = "probe")]
    );
  `);
  runtime = spawn(process.env.WORKERD_BIN ?? "/usr/local/bin/workerd",
    ["serve", join(scratch, "config.capnp")], { stdio: ["ignore", "ignore", "inherit"] });
  exited = once(runtime, "exit");
  const url = "http://127.0.0.1:18787";
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(runtime.exitCode, null, "workerd exited before readiness");
    try {
      ready = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) })).ok;
    } catch { /* Wait for this test's process to bind its socket. */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "workerd did not become ready");
  const response = await fetch(`${url}/check`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, "native workerd could not fetch Google's HTTPS discovery endpoint");
  assert.deepEqual(await response.json(), {
    status: 200, issuer: "https://accounts.google.com", tokenStatus: 400,
  });
  console.log("PASS: native workerd validates TLS for Google OAuth discovery and token endpoints");
} finally {
  if (runtime && runtime.exitCode === null) {
    runtime.kill("SIGTERM");
    const deadline = setTimeout(() => runtime.kill("SIGKILL"), 2000);
    deadline.unref();
    await exited;
    clearTimeout(deadline);
  }
  await rm(scratch, { recursive: true, force: true });
}
