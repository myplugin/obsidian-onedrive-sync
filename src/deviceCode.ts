// Environment-agnostic Device Code Flow (RFC 8628) for OneDrive personal
// (MSA, /common tenant). Shared by the headless Node CLI and Obsidian mobile
// ("Phase 3 mobile DCF").
//
// This module loads in pure Node: it has NO runtime import from `obsidian` and
// NO runtime import from `./fsOnedrive`. The success/fail response shapes are
// imported as TYPES ONLY (`import type`), so callers reuse the existing
// `setConfigBySuccessfullAuthInplace` to populate `OnedriveConfig` — exactly
// like `sendAuthReq` / `sendRefreshTokenReq` in fsOnedrive.ts. The response
// shape is NOT reinvented.
//
// The HTTP transport is injected (`httpPost`) so the same module runs under
// Node `fetch` (CLI) and Obsidian `request` (mobile), sidestepping the
// CORS-unknown that motivated the raw-request approach in fsOnedrive.ts.

import type {
  AccessCodeResponseFailedType,
  AccessCodeResponseSuccessfulType,
} from "./fsOnedrive";

// Must match the const in src/fsOnedrive.ts exactly (App Folder scopes for
// personal MSA). Redefined locally to keep this module free of a runtime
// fsOnedrive import.
const SCOPES = ["User.Read", "Files.ReadWrite.AppFolder", "offline_access"];

export type DeviceCodeHttpPost = (
  url: string,
  body: Record<string, string>,
) => Promise<string>; // returns response body text

export interface DeviceCodeOptions {
  // Surfaced with the user_code / verification_uri so the UI/CLI can prompt.
  deviceCodeCallback?: (msg: string) => void;
  // Honored between polls. Accepts either a simple `{ cancelled }` flag or a
  // standard AbortSignal (mobile/Node both can supply one).
  signal?: { cancelled: boolean } | AbortSignal;
  // Optional timing override (the contract's sanctioned "fake timer / override"
  // for fast tests, and a cross-env scheduler hook for mobile). Defaults to a
  // setTimeout-based wait of `interval` seconds.
  waitSeconds?: (seconds: number) => Promise<void>;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message?: string;
}

function isCancelled(
  signal?: { cancelled: boolean } | AbortSignal,
): boolean {
  if (signal === undefined) {
    return false;
  }
  if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) {
    return signal.aborted;
  }
  return (signal as { cancelled: boolean }).cancelled;
}

// Build a failed-type with the project's exact response shape, so callers
// handle every abort/expiry/transport failure through the SAME code path as a
// real AAD error response. Mirrors sendAuthReq's "return parsed object as
// AccessCodeResponseFailedType" contract for non-OK branches.
function failed(
  error: string,
  error_description: string,
): AccessCodeResponseFailedType {
  return {
    error,
    error_description,
    error_codes: [],
    timestamp: new Date().toISOString(),
    trace_id: "",
    correlation_id: "",
  };
}

const defaultWaitSeconds = (seconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));

/**
 * Acquire an OAuth2 token via the Device Code Flow against `${authority}`
 * (use the /common tenant for personal + work/school MSA).
 *
 * Returns the SAME success/fail types as `sendAuthReq`, so the caller runs
 * `setConfigBySuccessfullAuthInplace` on success — no new response handling.
 * Does NOT fetch the username; that stays via the existing
 * `getUserDisplayName`.
 */
export async function acquireByDeviceCode(
  clientID: string,
  authority: string,
  httpPost: DeviceCodeHttpPost,
  opts?: DeviceCodeOptions,
): Promise<AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType> {
  const deviceCodeUrl = `${authority}/oauth2/v2.0/devicecode`;
  const tokenUrl = `${authority}/oauth2/v2.0/token`;
  const scopeStr = SCOPES.join(" ");
  const wait = opts?.waitSeconds ?? defaultWaitSeconds;

  // 1. Request the device code. NO `tenant` in the body — the /common path in
  //    the URL is authoritative (same Tier-1 reasoning as sendAuthReq:482-486).
  let dcRspText: string;
  try {
    dcRspText = await httpPost(deviceCodeUrl, {
      client_id: clientID,
      scope: scopeStr,
    });
  } catch (e) {
    return failed(
      "device_code_request_failed",
      `Device code request failed: ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }

  let dc: DeviceCodeResponse;
  try {
    dc = JSON.parse(dcRspText) as DeviceCodeResponse;
  } catch (e) {
    return failed(
      "device_code_parse_failed",
      `Could not parse device code response: ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }

  const deviceCode = dc.device_code;
  const userCode = dc.user_code;
  const verificationUri = dc.verification_uri;
  let interval = Math.max(dc.interval ?? 5, 0);
  const expiresIn = dc.expires_in;
  const deadline = Date.now() + expiresIn * 1000;

  // Surface the user_code / verification_uri to the caller. Prefer the
  // server-provided `message`; fall back to a constructed prompt.
  const message =
    dc.message ??
    `Go to ${verificationUri} and enter code ${userCode}`;
  opts?.deviceCodeCallback?.(message);

  // 2. Poll the token endpoint. State machine over the parsed JSON:
  //    - authorization_pending → keep polling
  //    - slow_down             → increase interval, keep polling (RFC 8628)
  //    - authorization_declined | expired_token | bad_verification_code → fail
  //    - any other error      → fail (consistent with sendAuthReq)
  //    - no error              → success
  // The loop also honors cancellation (between polls) and the device-code
  // expiry deadline. A hard iteration cap is a last-resort guard so no branch
  // can hang or silently drop.
  const MAX_POLLS = 1000;
  for (let i = 0; i < MAX_POLLS; i++) {
    if (isCancelled(opts?.signal)) {
      return failed("cancelled", "Device code sign-in was cancelled.");
    }
    if (Date.now() >= deadline) {
      return failed(
        "expired_token",
        "Device code expired before the user signed in.",
      );
    }

    // Poll: wait `interval` seconds, THEN post (per the flow spec).
    await wait(interval);

    // Re-check after the wait — cancellation typically fires during the wait.
    if (isCancelled(opts?.signal)) {
      return failed("cancelled", "Device code sign-in was cancelled.");
    }
    if (Date.now() >= deadline) {
      return failed(
        "expired_token",
        "Device code expired before the user signed in.",
      );
    }

    let tkRspText: string;
    try {
      tkRspText = await httpPost(tokenUrl, {
        client_id: clientID,
        scope: scopeStr,
        // NO `tenant` body param — /common path is authoritative.
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      });
    } catch (e) {
      return failed(
        "token_request_failed",
        `Token request failed: ${(e as Error)?.message ?? String(e)}`,
      );
    }

    let tk: { error?: string; error_description?: string };
    try {
      tk = JSON.parse(tkRspText) as typeof tk;
    } catch (e) {
      return failed(
        "token_parse_failed",
        `Could not parse token response: ${
          (e as Error)?.message ?? String(e)
        }`,
      );
    }

    if (tk.error === undefined) {
      // Success — caller runs setConfigBySuccessfullAuthInplace.
      return tk as unknown as AccessCodeResponseSuccessfulType;
    }

    switch (tk.error) {
      case "authorization_pending":
        // Keep polling at the current interval.
        break;
      case "slow_down":
        // RFC 8628: back off. Not in MS's official device-code error table,
        // but handled per the spec. Increase the interval and keep polling.
        interval = Math.ceil(interval * 1.5);
        break;
      case "authorization_declined":
      case "expired_token":
      case "bad_verification_code":
        return tk as unknown as AccessCodeResponseFailedType;
      default:
        // Any other error → fail (consistent with sendAuthReq's failure path).
        return tk as unknown as AccessCodeResponseFailedType;
    }
  }

  return failed("poll_limit_exceeded", "Exceeded maximum poll iterations.");
}
