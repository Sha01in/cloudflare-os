// Subscription OAuth for AI providers (device-code grant).
//
// Workers-safe (fetch only — no loopback callback server). Device authorization and token
// refresh live here; the User Durable Object owns pending attempts so tokens never leave
// the isolate.

import type {
  AiModelOAuthCredential,
  AiOAuthProvider,
  AiProviderOAuthDeviceCode,
} from "@gadgets/workshop-shared/api";

// Public client id used by pi/Hermes-style SuperGrok device-code login. Not a secret.
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";

// Refresh slightly before the reported expiry to avoid using a token that dies mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

type JsonObject = Record<string, unknown>;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

export function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

export function positiveNumber(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

// The verification URI is opened in the user's browser; force https://auth.x.ai so a
// malicious token response cannot launch something else.
export function validateVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  if (url.protocol !== "https:" || url.hostname !== "auth.x.ai") {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled", { cause: error });
    throw error;
  }

  let body: JsonObject;
  try {
    const parsed: unknown = await response.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled", { cause: error });
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`, { cause: error });
  }
  return { ok: response.ok, status: response.status, body };
}

function requestFailure(action: string, response: { status: number; body: JsonObject }): Error {
  const error = typeof response.body.error === "string" ? response.body.error : undefined;
  const description = typeof response.body.error_description === "string"
    ? response.body.error_description
    : undefined;
  const detail = [error, description].filter(Boolean).join(": ");
  return new Error(
    `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

export function credentialsFromTokenResponse(
  body: JsonObject,
  previousRefreshToken?: string,
  nowMs: number = Date.now(),
): AiModelOAuthCredential {
  const access = requiredString(body, "access_token");
  // xAI may omit refresh_token on refresh when the token is not rotated.
  const refresh = body.refresh_token === undefined && previousRefreshToken
    ? previousRefreshToken
    : requiredString(body, "refresh_token");
  const expiresInSeconds = body.expires_in === undefined
    ? DEFAULT_TOKEN_LIFETIME_SECONDS
    : positiveNumber(body, "expires_in");
  return {
    access,
    refresh,
    expires: nowMs + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
  };
}

export function parseDeviceCode(body: JsonObject): DeviceAuthorization {
  const interval = body.interval;
  const intervalSeconds = typeof interval === "number" && Number.isFinite(interval) && interval > 0
    ? interval
    : DEFAULT_POLL_INTERVAL_SECONDS;
  const verificationUriComplete =
    typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
      ? validateVerificationUri(body.verification_uri_complete)
      : undefined;
  return {
    deviceCode: requiredString(body, "device_code"),
    userCode: requiredString(body, "user_code"),
    verificationUri: verificationUriComplete
      ?? validateVerificationUri(requiredString(body, "verification_uri")),
    intervalSeconds,
    expiresInSeconds: positiveNumber(body, "expires_in"),
  };
}

export function toDeviceCodeInfo(device: DeviceAuthorization): AiProviderOAuthDeviceCode {
  return {
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    expiresInSeconds: device.expiresInSeconds,
  };
}

export async function requestXaiDeviceCode(signal?: AbortSignal): Promise<DeviceAuthorization> {
  const response = await postForm(XAI_DEVICE_CODE_URL, {
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
    referrer: "cloudflare-os",
  }, signal);
  if (!response.ok) throw requestFailure("device authorization", response);
  return parseDeviceCode(response.body);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Login cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollXaiDeviceTokens(
  device: DeviceAuthorization,
  signal?: AbortSignal,
): Promise<AiModelOAuthCredential> {
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalMs = device.intervalSeconds * 1000;

  // RFC 8628: wait one interval before the first poll.
  await sleep(intervalMs, signal);

  while (Date.now() < deadline) {
    const response = await postForm(XAI_TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_CLIENT_ID,
      device_code: device.deviceCode,
    }, signal);

    if (response.ok) {
      return credentialsFromTokenResponse(response.body);
    }

    const error = response.body.error;
    if (error === "authorization_pending") {
      await sleep(intervalMs, signal);
      continue;
    }
    if (error === "slow_down") {
      const next = response.body.interval;
      if (typeof next === "number" && Number.isFinite(next) && next > 0) {
        intervalMs = next * 1000;
      } else {
        intervalMs += 5000;
      }
      await sleep(intervalMs, signal);
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (error === "expired_token") {
      throw new Error("xAI device code expired");
    }
    throw requestFailure("device token polling", response);
  }

  throw new Error("xAI device code expired");
}

/** Refresh a stored xAI OAuth credential. Throws on failure (invalid_grant, network, etc.). */
export async function refreshXaiOAuth(
  credential: AiModelOAuthCredential,
  signal?: AbortSignal,
): Promise<AiModelOAuthCredential> {
  const response = await postForm(XAI_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: XAI_CLIENT_ID,
    refresh_token: credential.refresh,
  }, signal);
  if (!response.ok) throw requestFailure("token refresh", response);
  return credentialsFromTokenResponse(response.body, credential.refresh);
}

/** True when the access token is missing or past its (already-skewed) expiry. */
export function oauthNeedsRefresh(credential: AiModelOAuthCredential): boolean {
  return !credential.access || credential.expires <= Date.now();
}

/**
 * Refresh OAuth credentials for any supported provider when needed. Returns the input credential
 * unchanged when still valid.
 */
export async function refreshAiModelOAuthIfNeeded(
  provider: AiOAuthProvider | string,
  credential: AiModelOAuthCredential,
  signal?: AbortSignal,
): Promise<AiModelOAuthCredential> {
  if (!oauthNeedsRefresh(credential)) return credential;
  switch (provider) {
    case "xai":
      return refreshXaiOAuth(credential, signal);
    default:
      throw new Error(`OAuth refresh is not supported for provider "${provider}".`);
  }
}
