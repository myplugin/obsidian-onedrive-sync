// Tests for the shared Device Code Flow module (src/deviceCode.ts).
//
// This module is obsidian-free at runtime (only `import type` from
// fsOnedrive), so — unlike tests/_obsidianStub.ts — no obsidian stub is
// required here. No real network is hit: `httpPost` is scripted, and poll
// waits are made instant via the `waitSeconds` override.

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { acquireByDeviceCode } from "../src/deviceCode";
import type {
  AccessCodeResponseFailedType,
  AccessCodeResponseSuccessfulType,
} from "../src/fsOnedrive";

const AUTHORITY = "https://login.microsoftonline.com/common";
const CLIENT_ID = "test-client-id";

// A canonical device-code response. Tests override fields as needed.
const DEVICE_CODE_RSP = {
  device_code: "DC-TEST-CODE",
  user_code: "ABCD1234",
  verification_uri: "https://microsoft.com/link",
  expires_in: 900,
  interval: 5,
  message: "Sign in at https://microsoft.com/link with code ABCD1234",
};

// A canonical success token response (matches AccessCodeResponseSuccessfulType
// — the SAME shape sendAuthReq returns).
const SUCCESS_TOKEN_RSP = {
  token_type: "Bearer",
  expires_in: 3600,
  scope: "User.Read Files.ReadWrite.AppFolder offline_access",
  access_token: "AT-123",
  refresh_token: "RT-456",
  id_token: "ID-789",
};

function errRsp(
  error: string,
  error_description = "desc",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    error,
    error_description,
    error_codes: [500],
    timestamp: "2026-01-01T00:00:00Z",
    trace_id: "trace",
    correlation_id: "corr",
    ...extra,
  });
}

// Build an httpPost mock: the device-code response is fixed; token responses
// are returned in sequence (one per poll).
function makeHttpPost(
  tokenResponses: string[],
  opts: {
    deviceCodeBody?: object;
    onDeviceCode?: (url: string, body: Record<string, string>) => void;
    onToken?: (url: string, body: Record<string, string>) => void;
  } = {},
): {
  post: (url: string, body: Record<string, string>) => Promise<string>;
  tokenCalls: Array<{ url: string; body: Record<string, string> }>;
} {
  const tokenCalls: Array<{ url: string; body: Record<string, string> }> = [];
  let tokenIdx = 0;
  const post = async (
    url: string,
    body: Record<string, string>,
  ): Promise<string> => {
    if (url.endsWith("/devicecode")) {
      opts.onDeviceCode?.(url, body);
      return JSON.stringify({ ...DEVICE_CODE_RSP, ...opts.deviceCodeBody });
    }
    if (url.endsWith("/token")) {
      tokenCalls.push({ url, body });
      opts.onToken?.(url, body);
      const rsp = tokenResponses[tokenIdx];
      tokenIdx += 1;
      if (rsp === undefined) {
        throw new Error("makeHttpPost: no more scripted token responses");
      }
      return rsp;
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { post, tokenCalls };
}

// Instant wait that records the requested intervals (for slow_down checks).
function recordingWait(): {
  wait: (seconds: number) => Promise<void>;
  intervals: number[];
} {
  const intervals: number[] = [];
  return {
    wait: async (seconds: number) => {
      intervals.push(seconds);
    },
    intervals,
  };
}

describe("acquireByDeviceCode", () => {
  it("(a) success on first poll returns the success type", async () => {
    const { post } = makeHttpPost([JSON.stringify(SUCCESS_TOKEN_RSP)]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).access_token,
      "AT-123",
    );
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).refresh_token,
      "RT-456",
    );
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).token_type,
      "Bearer",
    );
  });

  it("(b) authorization_pending then success", async () => {
    const { post, tokenCalls } = makeHttpPost([
      errRsp("authorization_pending", "user has not signed in yet"),
      JSON.stringify(SUCCESS_TOKEN_RSP),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).access_token,
      "AT-123",
    );
    assert.strictEqual(tokenCalls.length, 2);
  });

  it("(c) slow_down then success — interval increases between polls", async () => {
    const rec = recordingWait();
    // Start interval = 1 so the slow_down increase is observable.
    const { post } = makeHttpPost(
      [
        errRsp("slow_down", "too many requests"),
        JSON.stringify(SUCCESS_TOKEN_RSP),
      ],
      { deviceCodeBody: { interval: 1 } },
    );
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      {
        waitSeconds: rec.wait,
      },
    );
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).access_token,
      "AT-123",
    );
    // Two waits: first at interval=1, second at ceil(1*1.5)=2.
    assert.strictEqual(rec.intervals.length, 2);
    assert.strictEqual(rec.intervals[0], 1);
    assert.strictEqual(rec.intervals[1], 2);
    assert.ok(rec.intervals[1] > rec.intervals[0]);
  });

  it("(d) authorization_declined → returns failed type", async () => {
    const { post } = makeHttpPost([
      errRsp("authorization_declined", "user declined"),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "authorization_declined",
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error_description,
      "user declined",
    );
  });

  it("(e) expired_token → stops and returns failed type", async () => {
    const { post, tokenCalls } = makeHttpPost([
      errRsp("expired_token", "code expired"),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "expired_token",
    );
    // Stopped after a single poll — no further requests.
    assert.strictEqual(tokenCalls.length, 1);
  });

  it("(e2) bad_verification_code → returns failed type", async () => {
    const { post } = makeHttpPost([
      errRsp("bad_verification_code", "bad code"),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "bad_verification_code",
    );
  });

  it("(e3) any other error → returns failed type", async () => {
    const { post } = makeHttpPost([
      errRsp("invalid_client", "something unexpected"),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "invalid_client",
    );
  });

  it("(f) cancel signal aborts between polls", async () => {
    const signal = { cancelled: false };
    // Flip cancelled to true during the first wait; the post-poll cancel check
    // must then abort WITHOUT hitting the token endpoint.
    const { post, tokenCalls } = makeHttpPost([
      JSON.stringify(SUCCESS_TOKEN_RSP),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      {
        signal,
        waitSeconds: async () => {
          signal.cancelled = true;
        },
      },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "cancelled",
    );
    assert.strictEqual(tokenCalls.length, 0);
  });

  it("(f2) cancel signal already set at start aborts before first poll", async () => {
    const signal = { cancelled: true };
    const { post, tokenCalls } = makeHttpPost([
      JSON.stringify(SUCCESS_TOKEN_RSP),
    ]);
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { signal, waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "cancelled",
    );
    assert.strictEqual(tokenCalls.length, 0);
  });

  it("(g) devicecode response parsed + deviceCodeCallback invoked with user_code/verification_uri", async () => {
    const captured: string[] = [];
    const { post } = makeHttpPost(
      [JSON.stringify(SUCCESS_TOKEN_RSP)],
      {
        // Omit `message` to exercise the fallback prompt construction.
        deviceCodeBody: {
          message: undefined,
          user_code: "WXYZ9999",
          verification_uri: "https://microsoft.com/devicelogin",
        },
        onDeviceCode: (url, body) => {
          // devicecode body carries client_id + scope, NO tenant.
          assert.ok(url.endsWith("/devicecode"));
          assert.strictEqual(body.client_id, CLIENT_ID);
          assert.ok(body.scope.includes("offline_access"));
          assert.ok(!("tenant" in body));
        },
        onToken: (url, body) => {
          assert.ok(url.endsWith("/token"));
          assert.strictEqual(
            body.grant_type,
            "urn:ietf:params:oauth:grant-type:device_code",
          );
          assert.strictEqual(body.client_id, CLIENT_ID);
          assert.ok(!("tenant" in body));
        },
      },
    );
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      {
        deviceCodeCallback: (msg) => captured.push(msg),
        waitSeconds: async () => {},
      },
    );
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /WXYZ9999/);
    assert.match(captured[0], /microsoft\.com\/devicelogin/);
    assert.strictEqual(
      (res as AccessCodeResponseSuccessfulType).access_token,
      "AT-123",
    );
  });

  it("(g2) deviceCodeCallback receives server message when provided", async () => {
    const captured: string[] = [];
    const { post } = makeHttpPost([JSON.stringify(SUCCESS_TOKEN_RSP)]);
    await acquireByDeviceCode(CLIENT_ID, AUTHORITY, post, {
      deviceCodeCallback: (msg) => captured.push(msg),
      waitSeconds: async () => {},
    });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0], DEVICE_CODE_RSP.message);
  });

  it("devicecode request failure → failed type (no throw)", async () => {
    const post = async (): Promise<string> => {
      throw new Error("network down");
    };
    const res = await acquireByDeviceCode(
      CLIENT_ID,
      AUTHORITY,
      post,
      { waitSeconds: async () => {} },
    );
    assert.strictEqual(
      (res as AccessCodeResponseFailedType).error,
      "device_code_request_failed",
    );
    assert.match(
      (res as AccessCodeResponseFailedType).error_description,
      /network down/,
    );
  });
});
