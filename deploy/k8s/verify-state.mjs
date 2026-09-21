#!/usr/bin/env node
// Persistence acceptance probe for a locally running Workshop.
// Speaks the real Cap'n Web WebSocket at /api. Parent owns runtime start/restart.
// This file (and its companion test) is the only owned path in this worktree.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTEGRATION_TESTS_PACKAGE_JSON = path.resolve(
  HERE,
  "../../packages/integration-tests/package.json",
);

const PROCESS_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 20_000;
const WAIT_MS = 10_000;

export const ACCESS_DENIED_MESSAGE = "You don't have access to this workspace.";
const ACCESS_DENIED_CODE = "WORKSPACE_ACCESS_DENIED";
const FIXTURE_KIND = "generated-fixture";

const WORKSPACE_TITLE = "k8s-persistence-probe";
const GADGET_TITLE = "Persistence Counter";
const GADGET_BINDING = "COUNTER";
const CHAT_MESSAGES = Object.freeze(["k8s probe first", "k8s probe second"]);
const CALLBACK_TAG = "probe";
const COUNTER_VALUE = 2;
export const CALLBACK_INVOKE = "pingStashed";
export const CALLBACK_STORAGE = "gadget-durable-object-storage";
export const IDENTITY_SCOPE =
  "fresh password login; session tokens are not stored, reused, or asserted";

const PNG_1X1 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

export const GADGET_CLIENT_JS = `document.body.textContent = "k8s-persistence-counter";\n`;

/**
 * Real gadget Durable Object: ctx.storage holds the counter and a restored
 * callback stub. Verify must ping that saved stub (pingStashed), never remint.
 */
export const GADGET_SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

async function loadCount(storage) {
  const kv = storage.kv;
  if (kv && typeof kv.get === "function") {
    const value = kv.get("count");
    return typeof value === "number" ? value : 0;
  }
  const value = await storage.get("count");
  return typeof value === "number" ? value : 0;
}

async function saveCount(storage, n) {
  const kv = storage.kv;
  if (kv && typeof kv.put === "function") {
    kv.put("count", n);
    return;
  }
  await storage.put("count", n);
}

export class Gadget extends DurableObject {
  async increment() {
    const n = (await loadCount(this.ctx.storage)) + 1;
    await saveCount(this.ctx.storage, n);
    return n;
  }

  async getCount() {
    return loadCount(this.ctx.storage);
  }

  async stashCallback(tag) {
    const callback = await this.ctx.restore({ type: "callback", tag });
    await this.ctx.storage.put("stashedCallback", callback);
    return "stashed:" + tag;
  }

  async pingStashed() {
    const callback = await this.ctx.storage.get("stashedCallback");
    if (!callback) throw new Error("no stashed callback");
    return callback.ping();
  }

  [restore](params) {
    if (params.type !== "callback") throw new TypeError("unknown restore type");
    return new Callback(params.tag);
  }
}

class Callback extends RpcTarget {
  constructor(tag) {
    super();
    this.tag = tag;
  }
  ping() {
    return "pong:" + this.tag;
  }
}
`.trimStart();

export function completeCommand(command, gaps) {
  const gapIds = (gaps ?? []).map((gap) => gap.id);
  if (gapIds.length === 0) return;
  const untested = (gaps ?? [])
    .filter((gap) => gap.id === "callback-persistence")
    .map((gap) => gap.reason ?? "callback persistence untested")
    .join("; ");
  const extra = untested ? `; ${untested}` : "";
  const err = new Error(`${command} gaps (not a pass): ${gapIds.join(",")}${extra}`);
  err.exitCode = 1;
  throw err;
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

const USAGE =
  "usage: node deploy/k8s/verify-state.mjs seed|verify --url http://127.0.0.1:PORT --record /tmp/fixture.json";

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new UsageError(USAGE);
  }
  const command = argv[0];
  if (command !== "seed" && command !== "verify") {
    throw new UsageError(`${USAGE} (expected seed|verify)`);
  }
  let url;
  let recordPath;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--url") {
      if (!value) throw new UsageError(`${USAGE} (missing --url value)`);
      url = value;
      i++;
    } else if (flag === "--record") {
      if (!value) throw new UsageError(`${USAGE} (missing --record value)`);
      recordPath = value;
      i++;
    } else {
      throw new UsageError(`unknown flag: ${flag}\n${USAGE}`);
    }
  }
  if (!url) throw new UsageError(`${USAGE} (missing --url)`);
  if (!recordPath) throw new UsageError(`${USAGE} (missing --record)`);
  return { command, url, recordPath };
}

export function assertLoopbackUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError("refusing: missing url");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    const bare = value.match(/^(https?):\/\/::1(?::(\d+))?(\/.*)?$/iu);
    if (!bare) throw new UsageError("refusing: invalid url");
    url = new URL(
      `${bare[1]}://[::1]${bare[2] ? `:${bare[2]}` : ""}${bare[3] ?? ""}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("refusing: only http(s) loopback urls are allowed");
  }
  if (url.username || url.password) {
    throw new UsageError("refusing: url must not include credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new UsageError(`refusing non-loopback url host ${host}`);
  }
  return url;
}

export function passwordHashFor(username) {
  return new Uint8Array(
    createHash("sha256").update(`integration-test:${username}`).digest(),
  );
}

export function redactForLog(value) {
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(/integration-test:[A-Za-z0-9_-]+/gu, "[redacted]");
  text = text.replace(/[A-Fa-f0-9]{32,}/gu, "[redacted]");
  text = text.replace(/[A-Za-z0-9+/]{40,}={0,2}/gu, "[redacted]");
  return text;
}

export function writeExclusiveRecord(recordPath, data) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(
      recordPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new UsageError(`record already exists (exclusive create): ${recordPath}`);
    }
    throw err;
  }
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, json);
  } finally {
    closeSync(fd);
  }
}

export function readRecord(recordPath) {
  let raw;
  try {
    raw = readFileSync(recordPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new UsageError(`record not found: ${recordPath}`);
    }
    throw err;
  }
  const data = JSON.parse(raw);
  if (!data || data.kind !== FIXTURE_KIND) {
    throw new UsageError("record is not generated fixture data");
  }
  return data;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("expected binary avatar bytes");
}

function disposeQuiet(stub) {
  if (stub == null) return;
  try {
    const dispose = stub[Symbol.dispose];
    if (typeof dispose === "function") dispose.call(stub);
  } catch {
    // Session teardown must not hide the original failure.
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(what, attempt, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result != null) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function loadCapnweb() {
  const requireFromIntegrationTests = createRequire(INTEGRATION_TESTS_PACKAGE_JSON);
  let capnweb;
  try {
    capnweb = requireFromIntegrationTests("capnweb");
  } catch (err) {
    throw new Error(
      `failed to load capnweb via integration-tests: ${redactForLog(err)}`,
      { cause: err },
    );
  }
  if (
    typeof capnweb.newWebSocketRpcSession !== "function" ||
    typeof capnweb.RpcTarget !== "function" ||
    typeof capnweb.RpcStub !== "function"
  ) {
    throw new Error("capnweb export surface is missing WebSocket RPC helpers");
  }
  return capnweb;
}

function connectPublicApi(capnweb, httpUrl) {
  const wsUrl = new URL("/api", httpUrl);
  wsUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return capnweb.newWebSocketRpcSession(wsUrl.toString());
}

function uniqueUsername(prefix) {
  return `${prefix}${randomBytes(5).toString("hex")}`;
}

function humanMessages(history) {
  return (history.messages ?? [])
    .filter((message) => message.type === "message")
    .map((message) => message.message);
}

function isAccessDenied(err) {
  if (!err || typeof err !== "object") return false;
  if (err.code === ACCESS_DENIED_CODE) return true;
  return err.message === ACCESS_DENIED_MESSAGE;
}

async function listWorkpieces(capnweb, workspace) {
  class WorkpiecesCollector extends capnweb.RpcTarget {
    constructor() {
      super();
      this.entries = new Map();
      this.readyPromise = new Promise((resolve) => {
        this._resolveReady = resolve;
      });
    }
    entry(summary) {
      this.entries.set(summary.id, summary);
    }
    removed(id) {
      this.entries.delete(id);
    }
    ready() {
      this._resolveReady();
    }
  }

  const collector = new WorkpiecesCollector();
  const stub = new capnweb.RpcStub(collector);
  let subscription;
  try {
    subscription = await withTimeout(
      workspace.subscribeToWorkpieces(stub),
      RPC_TIMEOUT_MS,
      "subscribeToWorkpieces",
    );
    await withTimeout(collector.readyPromise, RPC_TIMEOUT_MS, "workpieces ready");
    return [...collector.entries.values()];
  } finally {
    disposeQuiet(subscription);
    disposeQuiet(stub);
  }
}

async function signUp(api, username, displayName) {
  const token = await withTimeout(
    api.createAccount(username, displayName, passwordHashFor(username)),
    RPC_TIMEOUT_MS,
    "createAccount",
  );
  if (!token) {
    throw new Error(`Signup failed for "${username}" — username already taken?`);
  }
  return withTimeout(api.authenticate(token), RPC_TIMEOUT_MS, "authenticate");
}

async function logIn(api, username) {
  const token = await withTimeout(
    api.login(username, passwordHashFor(username)),
    RPC_TIMEOUT_MS,
    "login",
  );
  if (token === null) throw new Error(`Login failed for "${username}"`);
  return withTimeout(api.authenticate(token), RPC_TIMEOUT_MS, "authenticate");
}

async function expectUnauthorized(auth, workspaceId) {
  let opened;
  try {
    opened = await withTimeout(
      auth.openGadget(workspaceId),
      RPC_TIMEOUT_MS,
      "openGadget unauthorized",
    );
    await withTimeout(opened.getMetadata(), RPC_TIMEOUT_MS, "getMetadata unauthorized");
  } catch (err) {
    if (isAccessDenied(err)) return;
    throw new Error(
      `expected workspace access denied, got: ${redactForLog(err && err.message ? err.message : err)}`,
      { cause: err },
    );
  } finally {
    disposeQuiet(opened);
  }
  throw new Error("expected workspace access denied, openGadget succeeded");
}

async function seedGadget(capnweb, workspace, chatId, gaps) {
  const result = {
    id: null,
    title: GADGET_TITLE,
    bindingName: GADGET_BINDING,
    codePath: "server.js",
    codeSha256: sha256Hex(Buffer.from(GADGET_SERVER_JS, "utf8")),
    commitId: null,
    counter: null,
    callback: null,
  };

  let gadget;
  try {
    gadget = await withTimeout(
      workspace.createGadget(GADGET_TITLE, undefined, GADGET_BINDING),
      RPC_TIMEOUT_MS,
      "createGadget",
    );
    result.id = await withTimeout(gadget.getId(), RPC_TIMEOUT_MS, "gadget.getId");
    const title = await withTimeout(gadget.getTitle(), RPC_TIMEOUT_MS, "gadget.getTitle");
    if (title !== GADGET_TITLE) {
      throw new Error(`gadget title ${JSON.stringify(title)}`);
    }

    const summary = await waitFor("gadget head commit", async () => {
      const list = await listWorkpieces(capnweb, workspace);
      return list.find((item) =>
        item.type === "gadget" && item.id === result.id && item.commitId
      ) ?? null;
    });
    const baseCommit = summary.commitId;

    await withTimeout(
      workspace.submitCodeChange(chatId, {
        generation: 0,
        revision: 0,
        clientId: crypto.randomUUID(),
        seq: 1,
        pins: [{ gadgetId: result.id, baseCommit }],
        change: {
          [result.id]: [
            ["server.js", { set: GADGET_SERVER_JS }],
            ["client.js", { set: GADGET_CLIENT_JS }],
          ],
        },
      }),
      RPC_TIMEOUT_MS,
      "submitCodeChange",
    );

    const merged = await withTimeout(
      workspace.mergeChanges(chatId),
      RPC_TIMEOUT_MS,
      "mergeChanges",
    );
    if (!merged || merged.outcome !== "merged") {
      throw new Error(`mergeChanges outcome ${merged && merged.outcome}`);
    }

    const after = await waitFor("committed gadget code", async () => {
      const list = await listWorkpieces(capnweb, workspace);
      const item = list.find((entry) =>
        entry.type === "gadget" && entry.id === result.id && entry.commitId
      );
      if (!item) return null;
      const files = await workspace.readFilesAtCommit(item.commitId, ["server.js"]);
      const pair = files.find(([filePath]) => filePath === "server.js");
      if (!pair || pair[1].kind !== "text") return null;
      if (sha256Hex(Buffer.from(pair[1].text, "utf8")) !== result.codeSha256) return null;
      return item;
    });
    result.commitId = after.commitId;
  } catch (err) {
    const reason = redactForLog(err && err.message ? err.message : err);
    gaps.push({ id: "gadget-code", reason });
    gaps.push({ id: "gadget-facet-counter", reason: `skipped: gadget-code failed (${reason})` });
    gaps.push({
      id: "callback-persistence",
      reason: `callback persistence untested: skipped because gadget-code failed (${reason})`,
    });
    disposeQuiet(gadget);
    return result;
  }

  try {
    const facet = await withTimeout(
      gadget.connectToGadget(),
      RPC_TIMEOUT_MS,
      "connectToGadget",
    );
    try {
      const n1 = await withTimeout(facet.increment(), RPC_TIMEOUT_MS, "increment");
      const n2 = await withTimeout(facet.increment(), RPC_TIMEOUT_MS, "increment");
      const got = await withTimeout(facet.getCount(), RPC_TIMEOUT_MS, "getCount");
      if (n1 !== 1 || n2 !== 2 || got !== COUNTER_VALUE) {
        throw new Error(`counter seed values ${n1},${n2},${got}`);
      }
      result.counter = { value: COUNTER_VALUE };
      try {
        const stashed = await withTimeout(
          facet.stashCallback(CALLBACK_TAG),
          RPC_TIMEOUT_MS,
          "stashCallback",
        );
        if (stashed !== `stashed:${CALLBACK_TAG}`) {
          throw new Error(`stashCallback ${JSON.stringify(stashed)}`);
        }
        const ping = await withTimeout(facet.pingStashed(), RPC_TIMEOUT_MS, "pingStashed");
        if (ping !== `pong:${CALLBACK_TAG}`) {
          throw new Error(`stashed callback ping ${JSON.stringify(ping)}`);
        }
        result.callback = {
          tag: CALLBACK_TAG,
          ping,
          storedIn: CALLBACK_STORAGE,
          invoke: CALLBACK_INVOKE,
        };
      } catch (err) {
        gaps.push({
          id: "callback-persistence",
          reason: `callback persistence untested: ${redactForLog(err && err.message ? err.message : err)}`,
        });
      }
    } finally {
      disposeQuiet(facet);
    }
  } catch (err) {
    const reason = redactForLog(err && err.message ? err.message : err);
    gaps.push({ id: "gadget-facet-counter", reason });
    if (!gaps.some((gap) => gap.id === "callback-persistence")) {
      gaps.push({
        id: "callback-persistence",
        reason: `callback persistence untested: skipped because gadget-facet-counter failed (${reason})`,
      });
    }
  } finally {
    disposeQuiet(gadget);
  }
  return result;
}

async function seed(httpUrl, recordPath) {
  const capnweb = loadCapnweb();
  const publicApi = connectPublicApi(capnweb, httpUrl);
  const stubs = [publicApi];
  try {
    await withTimeout(publicApi.ping(), CONNECT_TIMEOUT_MS, "PublicApi.ping");

    const suffix = randomBytes(3).toString("hex");
    const ownerName = uniqueUsername("k8so");
    const strangerName = uniqueUsername("k8ss");
    const ownerDisplay = `K8s Owner ${suffix}`;
    const strangerDisplay = `K8s Stranger ${suffix}`;

    const owner = await signUp(publicApi, ownerName, ownerName);
    stubs.push(owner);
    await withTimeout(owner.setOwnDisplayName(ownerDisplay), RPC_TIMEOUT_MS, "setOwnDisplayName");
    await withTimeout(owner.setAvatar(PNG_1X1), RPC_TIMEOUT_MS, "setAvatar");
    const who = await withTimeout(owner.whoami(), RPC_TIMEOUT_MS, "whoami");
    if (who.id !== ownerName) {
      throw new Error(`whoami id mismatch: expected username identity`);
    }
    if (who.name !== ownerDisplay) {
      throw new Error(`whoami name mismatch after setOwnDisplayName`);
    }
    const avatar = asBytes(
      await withTimeout(owner.getAvatar(who.id), RPC_TIMEOUT_MS, "getAvatar"),
    );
    if (sha256Hex(avatar) !== sha256Hex(PNG_1X1)) {
      throw new Error("avatar round-trip mismatch at seed");
    }

    const workspace = await withTimeout(owner.newGadget(), RPC_TIMEOUT_MS, "newGadget");
    stubs.push(workspace);
    await withTimeout(workspace.setTitle(WORKSPACE_TITLE), RPC_TIMEOUT_MS, "setTitle");
    await withTimeout(workspace.setPinned(true), RPC_TIMEOUT_MS, "setPinned");
    const chatId = await withTimeout(
      workspace.newChat(CHAT_MESSAGES[0], null),
      RPC_TIMEOUT_MS,
      "newChat",
    );
    await withTimeout(
      workspace.sendChatMessage(chatId, CHAT_MESSAGES[1], null),
      RPC_TIMEOUT_MS,
      "sendChatMessage",
    );
    const metadata = await withTimeout(workspace.getMetadata(), RPC_TIMEOUT_MS, "getMetadata");
    if (metadata.title !== WORKSPACE_TITLE) {
      throw new Error("workspace title mismatch at seed");
    }

    const history = await withTimeout(
      workspace.getChatHistory(chatId),
      RPC_TIMEOUT_MS,
      "getChatHistory",
    );
    if (JSON.stringify(humanMessages(history)) !== JSON.stringify([...CHAT_MESSAGES])) {
      throw new Error("human-only chat history mismatch at seed");
    }
    const chats = await withTimeout(workspace.listChats(), RPC_TIMEOUT_MS, "listChats");
    const listedChat = chats.find((chat) => chat.id === chatId);
    if (!listedChat) throw new Error("seeded chat missing from listChats");
    if (listedChat.activeAgent !== undefined) {
      throw new Error("human-only chat started an agent");
    }

    await waitFor("workspace in listGadgets", async () => {
      const list = await owner.listGadgets();
      return list.some((entry) =>
        entry.id === metadata.id && entry.title === WORKSPACE_TITLE && entry.pinned === true
      ) ? true : null;
    });

    const gaps = [];
    const gadget = await seedGadget(capnweb, workspace, chatId, gaps);

    const stranger = await signUp(publicApi, strangerName, strangerName);
    stubs.push(stranger);
    await withTimeout(
      stranger.setOwnDisplayName(strangerDisplay),
      RPC_TIMEOUT_MS,
      "stranger setOwnDisplayName",
    );
    await expectUnauthorized(stranger, metadata.id);

    const record = {
      kind: FIXTURE_KIND,
      version: 1,
      identityScope: IDENTITY_SCOPE,
      users: {
        owner: { username: ownerName, displayName: ownerDisplay, id: who.id },
        stranger: { username: strangerName, displayName: strangerDisplay },
      },
      workspace: {
        id: metadata.id,
        title: WORKSPACE_TITLE,
        pinned: true,
      },
      chat: {
        id: chatId,
        messages: [...CHAT_MESSAGES],
      },
      gadget,
      avatar: {
        userId: who.id,
        sha256: sha256Hex(PNG_1X1),
        byteLength: PNG_1X1.byteLength,
      },
      gaps,
    };
    writeExclusiveRecord(recordPath, record);

    const gapIds = gaps.map((gap) => gap.id);
    console.log(gapIds.length === 0 ? "seed: ok" : "seed: incomplete");
    console.log(`identity-scope: ${IDENTITY_SCOPE}`);
    console.log(`workspace: ${metadata.id}`);
    console.log(`owner: ${ownerName}`);
    console.log(`stranger: ${strangerName}`);
    console.log(`gaps: ${gapIds.length === 0 ? "none" : gapIds.join(",")}`);
    completeCommand("seed", gaps);
  } finally {
    for (const stub of stubs.toReversed()) disposeQuiet(stub);
  }
}

async function verifyGadget(capnweb, workspace, record, failures) {
  const expected = record.gadget;
  if (!expected || expected.id == null) {
    if ((record.gaps ?? []).some((gap) => gap.id === "gadget-code")) return;
    failures.push("gadget: missing from fixture");
    return;
  }

  let gadget;
  try {
    gadget = await withTimeout(
      workspace.getGadget(expected.id),
      RPC_TIMEOUT_MS,
      "getGadget",
    );
    const title = await withTimeout(gadget.getTitle(), RPC_TIMEOUT_MS, "gadget.getTitle");
    if (title !== expected.title) {
      failures.push(`gadget title: ${JSON.stringify(title)}`);
    }

    const codeGap = (record.gaps ?? []).some((gap) => gap.id === "gadget-code");
    if (!codeGap && expected.commitId && expected.codeSha256) {
      const files = await withTimeout(
        workspace.readFilesAtCommit(expected.commitId, ["server.js"]),
        RPC_TIMEOUT_MS,
        "readFilesAtCommit",
      );
      const pair = files.find(([filePath]) => filePath === "server.js");
      const text = pair && pair[1].kind === "text" ? pair[1].text : "";
      if (sha256Hex(Buffer.from(text, "utf8")) !== expected.codeSha256) {
        failures.push("gadget code sha256 mismatch");
      }
    } else if (!codeGap) {
      failures.push("gadget code: no commitId recorded (not marked as gap)");
    }

    const counterGap = (record.gaps ?? []).some((gap) => gap.id === "gadget-facet-counter");
    const callbackGap = (record.gaps ?? []).some((gap) => gap.id === "callback-persistence");
    if (!counterGap && expected.counter) {
      const facet = await withTimeout(
        gadget.connectToGadget(),
        RPC_TIMEOUT_MS,
        "connectToGadget",
      );
      try {
        const got = await withTimeout(facet.getCount(), RPC_TIMEOUT_MS, "getCount");
        if (got !== expected.counter.value) {
          failures.push(`gadget counter: got ${got}, expected ${expected.counter.value}`);
        }
        if (!callbackGap && expected.callback) {
          if (
            expected.callback.storedIn !== CALLBACK_STORAGE ||
            expected.callback.invoke !== CALLBACK_INVOKE
          ) {
            failures.push("callback persistence untested: fixture did not record a storage-backed callback");
          } else {
            try {
              const ping = await withTimeout(facet.pingStashed(), RPC_TIMEOUT_MS, "pingStashed");
              if (ping !== expected.callback.ping) {
                failures.push(`stashed callback ping: ${JSON.stringify(ping)}`);
              }
            } catch (err) {
              failures.push(
                `saved callback not restorable: ${redactForLog(err && err.message ? err.message : err)}`,
              );
            }
          }
        } else if (!callbackGap && expected.callback == null) {
          failures.push("callback persistence untested: not recorded and not marked as gap");
        }
      } finally {
        disposeQuiet(facet);
      }
    } else if (!counterGap && expected.counter == null) {
      failures.push("gadget counter: not recorded and not marked as gap");
    }
  } catch (err) {
    failures.push(`gadget: ${redactForLog(err && err.message ? err.message : err)}`);
  } finally {
    disposeQuiet(gadget);
  }
}

async function verify(httpUrl, recordPath) {
  const record = readRecord(recordPath);
  const capnweb = loadCapnweb();
  const publicApi = connectPublicApi(capnweb, httpUrl);
  const stubs = [publicApi];
  const failures = [];
  try {
    await withTimeout(publicApi.ping(), CONNECT_TIMEOUT_MS, "PublicApi.ping");

    const owner = await logIn(publicApi, record.users.owner.username);
    stubs.push(owner);
    const who = await withTimeout(owner.whoami(), RPC_TIMEOUT_MS, "whoami");
    if (who.id !== record.users.owner.id) failures.push("fresh password login identity id");
    if (who.name !== record.users.owner.displayName) failures.push("profile display name");

    const avatar = asBytes(
      await withTimeout(
        owner.getAvatar(record.avatar.userId),
        RPC_TIMEOUT_MS,
        "getAvatar",
      ),
    );
    if (sha256Hex(avatar) !== record.avatar.sha256) failures.push("avatar kv blob");
    if (avatar.byteLength !== record.avatar.byteLength) failures.push("avatar byteLength");

    const listed = await waitFor("workspace in listGadgets", async () => {
      const list = await owner.listGadgets();
      const entry = list.find((item) => item.id === record.workspace.id);
      return entry ?? null;
    });
    if (listed.title !== record.workspace.title) failures.push("workspace title");
    if (listed.pinned !== record.workspace.pinned) failures.push("workspace pinned");

    const workspace = await withTimeout(
      owner.openGadget(record.workspace.id),
      RPC_TIMEOUT_MS,
      "openGadget",
    );
    stubs.push(workspace);
    const metadata = await withTimeout(workspace.getMetadata(), RPC_TIMEOUT_MS, "getMetadata");
    if (metadata.id !== record.workspace.id) failures.push("workspace metadata id");
    if (metadata.title !== record.workspace.title) failures.push("workspace metadata title");

    const history = await withTimeout(
      workspace.getChatHistory(record.chat.id),
      RPC_TIMEOUT_MS,
      "getChatHistory",
    );
    if (JSON.stringify(humanMessages(history)) !== JSON.stringify(record.chat.messages)) {
      failures.push("human-only chat history");
    }
    const chats = await withTimeout(workspace.listChats(), RPC_TIMEOUT_MS, "listChats");
    const listedChat = chats.find((chat) => chat.id === record.chat.id);
    if (!listedChat) failures.push("chat missing");
    else if (listedChat.activeAgent !== undefined) failures.push("chat started an agent");

    await verifyGadget(capnweb, workspace, record, failures);

    const stranger = await logIn(publicApi, record.users.stranger.username);
    stubs.push(stranger);
    const strangerWho = await withTimeout(stranger.whoami(), RPC_TIMEOUT_MS, "stranger whoami");
    if (strangerWho.name !== record.users.stranger.displayName) {
      failures.push("stranger display name");
    }
    try {
      await expectUnauthorized(stranger, record.workspace.id);
    } catch (err) {
      failures.push(redactForLog(err && err.message ? err.message : err));
    }

    if (failures.length > 0) {
      const error = new Error(`verify failed: ${failures.join("; ")}`);
      error.exitCode = 1;
      throw error;
    }
    completeCommand("verify", record.gaps ?? []);
    console.log("verify: ok");
    console.log(`identity-scope: ${IDENTITY_SCOPE}`);
    console.log(`workspace: ${record.workspace.id}`);
    console.log("gaps: none");
  } finally {
    for (const stub of stubs.toReversed()) disposeQuiet(stub);
  }
}

function isCliEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === fileURLToPath(import.meta.url);
}

export async function main(argv) {
  const args = parseArgs(argv);
  const url = assertLoopbackUrl(args.url);
  if (args.command === "seed") await seed(url, args.recordPath);
  else await verify(url, args.recordPath);
}

if (isCliEntry()) {
  const timer = setTimeout(() => {
    console.error("verify-state: timed out");
    process.exit(2);
  }, PROCESS_TIMEOUT_MS);
  main(process.argv.slice(2)).then(() => {
    clearTimeout(timer);
  }).catch((err) => {
    clearTimeout(timer);
    const code = Number.isInteger(err?.exitCode) ? err.exitCode : 1;
    console.error(redactForLog(err && err.message ? err.message : err));
    process.exit(code);
  });
}
