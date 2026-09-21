import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  findWorkerdBinary,
  validateAdminsConfig,
  validateAuthConfig,
  validatePublicBaseUrl,
  validateUnsupportedFeatures,
} from "./serve.ts";

test("validatePublicBaseUrl permits https origins and loopback http", () => {
  assert.equal(
    validatePublicBaseUrl("https://cloudflare-os-nonprod-k8s.internal.conduit.inc"),
    "https://cloudflare-os-nonprod-k8s.internal.conduit.inc",
  );
  assert.equal(
    validatePublicBaseUrl("https://cloudflare-os.internal.conduit.inc/"),
    "https://cloudflare-os.internal.conduit.inc",
  );
  assert.equal(validatePublicBaseUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(validatePublicBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(validatePublicBaseUrl("http://[::1]:8787"), "http://[::1]:8787");
});

test("validatePublicBaseUrl rejects non-https non-loopback URLs", () => {
  assert.throws(
    () => validatePublicBaseUrl("http://cloudflare-os.internal.conduit.inc"),
    /PUBLIC_BASE_URL must use https:\/\/ in production/,
  );
  assert.throws(
    () => validatePublicBaseUrl("http://example.com"),
    /PUBLIC_BASE_URL must use https:\/\/ in production/,
  );
});

test("validatePublicBaseUrl rejects URLs with credentials, query, fragment, or path", () => {
  assert.throws(
    () => validatePublicBaseUrl("https://user:pass@example.com"),
    /PUBLIC_BASE_URL must not contain user credentials/,
  );
  assert.throws(
    () => validatePublicBaseUrl("https://example.com/?query=1"),
    /PUBLIC_BASE_URL must not contain query parameters/,
  );
  assert.throws(
    () => validatePublicBaseUrl("https://example.com/#fragment"),
    /PUBLIC_BASE_URL must not contain a URL hash\/fragment/,
  );
  assert.throws(
    () => validatePublicBaseUrl("https://example.com/some/path"),
    /PUBLIC_BASE_URL must be a bare origin without a path prefix/,
  );
});

test("validateAuthConfig requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET when google auth is enabled", () => {
  assert.throws(
    () => validateAuthConfig({ AUTH_GATEKEEPERS: "google" }),
    /GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing/,
  );
  assert.throws(
    () => validateAuthConfig({ AUTH_GATEKEEPERS: "google", GOOGLE_CLIENT_ID: "client-id" }),
    /GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing/,
  );
  // Valid dummy credentials pass without error
  assert.doesNotThrow(() =>
    validateAuthConfig({
      AUTH_GATEKEEPERS: "google",
      GOOGLE_CLIENT_ID: "test-id",
      GOOGLE_CLIENT_SECRET: "test-secret",
    }),
  );
});

test("validateAuthConfig rejects DISABLE_PASSWORD_AUTH=true if no auth gatekeeper is configured", () => {
  assert.throws(
    () => validateAuthConfig({ DISABLE_PASSWORD_AUTH: "true" }),
    /DISABLE_PASSWORD_AUTH=true requires at least one gatekeeper in AUTH_GATEKEEPERS/,
  );
  assert.doesNotThrow(() =>
    validateAuthConfig({
      DISABLE_PASSWORD_AUTH: "true",
      AUTH_GATEKEEPERS: "google",
      GOOGLE_CLIENT_ID: "dummy-id",
      GOOGLE_CLIENT_SECRET: "dummy-secret",
    }),
  );
});

test("validateUnsupportedFeatures rejects unsupported cloud-only flags", () => {
  assert.throws(
    () => validateUnsupportedFeatures({ ENABLE_CLOUDFLARE_LIMITS: "true" }),
    /ENABLE_CLOUDFLARE_LIMITS=true is not supported/,
  );
  assert.throws(
    () => validateUnsupportedFeatures({ CF_AI_GATEWAY_USE_BINDING: "true" }),
    /CF_AI_GATEWAY_USE_BINDING=true is not supported/,
  );
  assert.doesNotThrow(() =>
    validateUnsupportedFeatures({ ENABLE_CLOUDFLARE_LIMITS: "false", CF_AI_GATEWAY_USE_BINDING: "false" }),
  );
});

test("validateAdminsConfig provides safe empty default and validates array format", () => {
  assert.equal(validateAdminsConfig(undefined), "[]");
  assert.equal(validateAdminsConfig(""), "[]");
  assert.equal(validateAdminsConfig("   "), "[]");
  assert.equal(validateAdminsConfig('["admin@example.com"]'), '["admin@example.com"]');
  assert.throws(() => validateAdminsConfig("admin"), /ADMINS must be a JSON array/);
  assert.throws(() => validateAdminsConfig('{"admin": true}'), /ADMINS must be a JSON array/);
});

test("findWorkerdBinary throws on explicitly invalid path without falling back", () => {
  assert.throws(
    () => findWorkerdBinary("/path/does/not/exist/workerd"),
    /no such file exists/,
  );
});

test("all supported sign-in vendors require credentials and unknown vendors are rejected", () => {
  for (const vendor of ["github", "cloudflare"]) {
    assert.throws(() => validateAuthConfig({
      AUTH_GATEKEEPERS: vendor,
      DISABLE_PASSWORD_AUTH: "true",
    }), /CLIENT_ID or .*CLIENT_SECRET is missing/);
  }
  assert.throws(() => validateAuthConfig({ AUTH_GATEKEEPERS: "typo" }), /Unsupported sign-in/);
  assert.doesNotThrow(() => validateAuthConfig({
    AUTH_GATEKEEPERS: "github,cloudflare",
    GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: "test",
    CLOUDFLARE_OAUTH_CLIENT_ID: "test", CLOUDFLARE_OAUTH_CLIENT_SECRET: "test",
  }));
});

test("production launcher requires an explicit public origin before starting workerd", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./serve.ts", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "production", PUBLIC_BASE_URL: "" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PUBLIC_BASE_URL is required in production/);
});
