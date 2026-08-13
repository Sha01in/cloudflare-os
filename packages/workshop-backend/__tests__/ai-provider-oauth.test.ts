import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialsFromTokenResponse,
  oauthNeedsRefresh,
  parseDeviceCode,
  refreshXaiOAuth,
  validateVerificationUri,
} from "../src/ai-provider-oauth.js";

describe("xAI OAuth helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects non-https verification URIs", () => {
    expect(() => validateVerificationUri("http://auth.x.ai/device"))
      .toThrow("Untrusted verification URI");
    expect(() => validateVerificationUri("javascript:alert(1)"))
      .toThrow("Untrusted verification URI");
    expect(() => validateVerificationUri("not a url"))
      .toThrow("Untrusted verification URI");
  });

  it("accepts https verification URIs", () => {
    expect(validateVerificationUri("https://auth.x.ai/device?user_code=ABCD"))
      .toBe("https://auth.x.ai/device?user_code=ABCD");
  });

  it("prefers verification_uri_complete when present", () => {
    const device = parseDeviceCode({
      device_code: "dev-1",
      user_code: "WDJB-MJHT",
      verification_uri: "https://auth.x.ai/device",
      verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
      expires_in: 600,
      interval: 5,
    });
    expect(device.verificationUri).toBe("https://auth.x.ai/device?user_code=WDJB-MJHT");
    expect(device.userCode).toBe("WDJB-MJHT");
    expect(device.intervalSeconds).toBe(5);
  });

  it("rejects http verification_uri_complete", () => {
    expect(() => parseDeviceCode({
      device_code: "dev-1",
      user_code: "WDJB-MJHT",
      verification_uri: "https://auth.x.ai/device",
      verification_uri_complete: "http://evil.example/phish",
      expires_in: 600,
    })).toThrow("Untrusted verification URI");
  });

  it("keeps the previous refresh token when xAI omits it", () => {
    const cred = credentialsFromTokenResponse({
      access_token: "new-access",
      expires_in: 3600,
    }, "old-refresh", 1_000_000);
    expect(cred.access).toBe("new-access");
    expect(cred.refresh).toBe("old-refresh");
    // 3600s minus 5min skew, from the injected now.
    expect(cred.expires).toBe(1_000_000 + 3600 * 1000 - 5 * 60 * 1000);
  });

  it("requires a refresh token on the first exchange", () => {
    expect(() => credentialsFromTokenResponse({
      access_token: "new-access",
      expires_in: 3600,
    })).toThrow("refresh_token");
  });

  it("treats missing or expired access tokens as needing refresh", () => {
    expect(oauthNeedsRefresh({ access: "", refresh: "r", expires: Date.now() + 60_000 }))
      .toBe(true);
    expect(oauthNeedsRefresh({ access: "a", refresh: "r", expires: Date.now() - 1 }))
      .toBe(true);
    expect(oauthNeedsRefresh({ access: "a", refresh: "r", expires: Date.now() + 60_000 }))
      .toBe(false);
  });

  it("refreshes via the xAI token endpoint and preserves the refresh token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: "rotated-access",
        expires_in: 1800,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const next = await refreshXaiOAuth({
      access: "stale",
      refresh: "keep-me",
      expires: 0,
    });

    expect(next.access).toBe("rotated-access");
    expect(next.refresh).toBe("keep-me");
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call![1]?.body)).toContain("grant_type=refresh_token");
    expect(String(call![1]?.body)).toContain("refresh_token=keep-me");
  });

  it("surfaces xAI refresh failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }),
    ));
    await expect(refreshXaiOAuth({
      access: "stale",
      refresh: "dead",
      expires: 0,
    })).rejects.toThrow(/token refresh failed.*invalid_grant/);
  });
});
