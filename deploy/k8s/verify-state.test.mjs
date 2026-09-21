import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCESS_DENIED_MESSAGE,
  CALLBACK_INVOKE,
  CALLBACK_STORAGE,
  GADGET_SERVER_JS,
  IDENTITY_SCOPE,
  assertLoopbackUrl,
  completeCommand,
  parseArgs,
  passwordHashFor,
  readRecord,
  redactForLog,
  writeExclusiveRecord,
} from "./verify-state.mjs";

const SCRIPT = fileURLToPath(new URL("./verify-state.mjs", import.meta.url));

function runCli(args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
}

function tempRecord() {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-state-"));
  return path.join(dir, "fixture.json");
}

describe("parseArgs", () => {
  it("accepts seed and verify with url and record", () => {
    assert.deepEqual(
      parseArgs(["seed", "--url", "http://127.0.0.1:8787", "--record", "/tmp/a.json"]),
      { command: "seed", url: "http://127.0.0.1:8787", recordPath: "/tmp/a.json" },
    );
    assert.deepEqual(
      parseArgs(["verify", "--url", "http://127.0.0.1:9", "--record", "/tmp/b.json"]),
      { command: "verify", url: "http://127.0.0.1:9", recordPath: "/tmp/b.json" },
    );
  });

  it("rejects missing pieces and unknown flags", () => {
    assert.throws(() => parseArgs([]), /usage/i);
    assert.throws(() => parseArgs(["seed"]), /--url/);
    assert.throws(() => parseArgs(["seed", "--url", "http://127.0.0.1:1"]), /--record/);
    assert.throws(() => parseArgs(["nope", "--url", "http://127.0.0.1:1", "--record", "x"]), /seed\|verify/);
    assert.throws(() => parseArgs(["seed", "--url", "http://127.0.0.1:1", "--record", "x", "--oops"]), /unknown/i);
  });
});

describe("assertLoopbackUrl", () => {
  it("allows loopback http(s) targets", () => {
    for (const value of [
      "http://127.0.0.1:8787",
      "http://localhost:9",
      "https://127.0.0.1",
      "http://[::1]:8787",
      "http://::1",
    ]) {
      const parsed = assertLoopbackUrl(value);
      assert.equal(parsed.protocol.startsWith("http"), true);
    }
  });

  it("refuses non-loopback and non-http URLs so live state cannot be written", () => {
    for (const value of [
      "http://example.com",
      "http://cloudflare-os.internal.conduit.inc",
      "http://10.0.0.1:8787",
      "http://0.0.0.0:8787",
      "http://192.168.1.1",
      "http://[::ffff:8.8.8.8]",
      "ws://127.0.0.1:8787",
      "http://127.0.0.1.attacker.example",
      "http://user:pass@127.0.0.1:8787",
    ]) {
      assert.throws(() => assertLoopbackUrl(value), /loopback|refusing|http/i, value);
    }
  });
});

describe("fixture record", () => {
  it("creates an exclusive 0600 file and refuses overwrite", () => {
    const recordPath = tempRecord();
    writeExclusiveRecord(recordPath, { kind: "generated-fixture", n: 1 });
    const mode = statSync(recordPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const first = readFileSync(recordPath, "utf8");
    assert.throws(() => writeExclusiveRecord(recordPath, { n: 2 }), /exists|exclusive/i);
    assert.equal(readFileSync(recordPath, "utf8"), first);
    assert.equal(readRecord(recordPath).n, 1);
  });

  it("readRecord refuses missing files", () => {
    assert.throws(() => readRecord(tempRecord()), /not found|ENOENT|missing/i);
  });

  it("readRecord refuses non-fixture payloads so production data cannot be verified", () => {
    const recordPath = tempRecord();
    writeFileSync(recordPath, `${JSON.stringify({ users: [{ username: "prod" }] })}\n`);
    assert.throws(() => readRecord(recordPath), /generated fixture/i);
  });
});

describe("passwordHashFor", () => {
  it("matches integration-tests rpc-client stand-in", () => {
    const expected = new Uint8Array(
      createHash("sha256").update("integration-test:alice").digest(),
    );
    assert.deepEqual(passwordHashFor("alice"), expected);
  });
});

describe("redactForLog", () => {
  it("strips session-token-looking values and password hashes", () => {
    const token = "a".repeat(64);
    const text = redactForLog(`token=${token} hash=integration-test:alice`);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes("integration-test:alice"), false);
    assert.match(text, /\[redacted\]/);
  });
});

describe("CLI safety paths", () => {
  it("exits nonzero for usage errors without printing a token", () => {
    const result = runCli([]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /usage/i);
    assert.equal(`${result.stderr}${result.stdout}`.includes("authenticate"), false);
  });

  it("refuses a public URL before opening a socket", () => {
    const recordPath = tempRecord();
    const result = runCli([
      "seed",
      "--url",
      "http://example.com:8787",
      "--record",
      recordPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /loopback|refus/i);
    assert.throws(() => statSync(recordPath));
  });

  it("does not create a record when the loopback socket cannot connect", () => {
    const recordPath = tempRecord();
    const result = runCli([
      "seed",
      "--url",
      "http://127.0.0.1:1",
      "--record",
      recordPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.throws(() => statSync(recordPath));
    const combined = `${result.stderr}${result.stdout}`;
    assert.equal(/[A-Za-z0-9+/]{40,}={0,2}/.test(combined.replaceAll("[redacted]", "")), false);
  });

  it("verify refuses a missing record without writing one", () => {
    const recordPath = tempRecord();
    const result = runCli([
      "verify",
      "--url",
      "http://127.0.0.1:1",
      "--record",
      recordPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /not found|missing|ENOENT/i);
    assert.throws(() => statSync(recordPath));
  });
});

describe("access-denied message constant", () => {
  it("matches the workshop-shared openGadget copy", () => {
    assert.equal(ACCESS_DENIED_MESSAGE, "You don't have access to this workspace.");
  });
});

describe("callback persistence via gadget Durable Object storage", () => {
  it("stashes the restored callback in ctx.storage and pings that saved stub", () => {
    assert.match(GADGET_SERVER_JS, /async stashCallback\(tag\)/);
    assert.match(GADGET_SERVER_JS, /await this\.ctx\.restore\(\{ type: "callback", tag \}\)/);
    assert.match(GADGET_SERVER_JS, /this\.ctx\.storage\.put\("stashedCallback"/);
    assert.match(GADGET_SERVER_JS, /async pingStashed\(\)/);
    assert.match(GADGET_SERVER_JS, /this\.ctx\.storage\.get\("stashedCallback"\)/);
    assert.match(GADGET_SERVER_JS, /callback\.ping\(\)/);
    assert.equal(CALLBACK_INVOKE, "pingStashed");
    assert.equal(CALLBACK_STORAGE, "gadget-durable-object-storage");
  });

  it("does not expose a remint path that would false-pass after restart", () => {
    assert.doesNotMatch(GADGET_SERVER_JS, /mintCallback/);
  });
});

describe("completeCommand", () => {
  it("treats any gap as a nonzero non-pass, including untested callback persistence", () => {
    assert.equal(completeCommand("seed", []), undefined);
    assert.throws(
      () => completeCommand("seed", [{ id: "callback-persistence", reason: "callback persistence untested: x" }]),
      /callback persistence untested|not a pass/i,
    );
    try {
      completeCommand("verify", [{ id: "callback-persistence" }]);
      assert.fail("expected throw");
    } catch (err) {
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /verify gaps \(not a pass\): callback-persistence/);
    }
  });
});

describe("identity scope", () => {
  it("labels fresh password login and does not claim session-token persistence", () => {
    assert.match(IDENTITY_SCOPE, /fresh password login/i);
    assert.match(IDENTITY_SCOPE, /session tokens are not stored, reused, or asserted/i);
    assert.doesNotMatch(IDENTITY_SCOPE, /session token persistence/i);
  });
});
