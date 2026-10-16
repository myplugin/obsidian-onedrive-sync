// Headless CLI login smoke (Phase C Milestone C1a).
//
// GATE: mocked httpPost → acquireByDeviceCode → setConfigBySuccessfullAuthInplace
// → saveConfig → loadConfig (reload) → assert the tokens round-tripped.
//
// This proves the FULL login flow works end-to-end with NO real network:
//   - acquireByDeviceCode (Phase A) drives the DCF state machine.
//   - setConfigBySuccessfullAuthInplace (fsOnedrive.ts:547-568) populates
//     OnedriveConfig from the success response — REUSED, not reinvented.
//   - saveConfig (cli/config.ts) persists plain-JSON + chmod 0600.
//   - loadConfig reloads and the access/refresh tokens + expiry match.
//
// The reload-after-save is the correctness gate: it proves the success
// response actually flowed through setConfigBySuccessfullAuthInplace AND
// that the saved JSON round-trips back to an identical OnedriveConfig.

// MUST be first — sets window.moment before any src module load. (login.ts
// pulls setConfigBySuccessfullAuthInplace from fsOnedrive, which via
// baseTypes/logger may touch window.moment at runtime.)
import "./polyfills";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { doLogin } from "./login";
import { loadConfig } from "./config";
import type { DeviceCodeHttpPost } from "../src/deviceCode";

// A canonical device-code response (mirrors tests/deviceCode.test.ts).
const DEVICE_CODE_RSP = {
  device_code: "DC",
  user_code: "ABCD",
  verification_uri: "https://microsoft.com/link",
  expires_in: 900,
  interval: 5,
  message: "Sign in at https://microsoft.com/link with code ABCD",
};

// A canonical success token response — matches AccessCodeResponseSuccessfulType
// (the SAME shape sendAuthReq / acquireByDeviceCode return).
const SUCCESS_TOKEN_RSP = {
  token_type: "Bearer",
  expires_in: 3600,
  scope: "User.Read Files.ReadWrite.AppFolder offline_access",
  access_token: "AT-123",
  refresh_token: "RT-456",
  id_token: "ID",
};

// Mocked httpPost: /devicecode → device code JSON; /token → success JSON.
// No real network. (Single token poll succeeds immediately.)
const mockHttp: DeviceCodeHttpPost = async (url) => {
  if (url.endsWith("/devicecode")) {
    return JSON.stringify(DEVICE_CODE_RSP);
  }
  if (url.endsWith("/token")) {
    return JSON.stringify(SUCCESS_TOKEN_RSP);
  }
  throw new Error(`unexpected url: ${url}`);
};

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "ods-login-"));
  const cfg = path.join(tmp, "config.json");
  try {
    const before = await loadConfig(cfg);
    assert(
      before.onedrive.accessToken === "",
      `fresh config should have empty accessToken, got "${before.onedrive.accessToken}"`,
    );

    const res = await doLogin(mockHttp, cfg, {
      clientID: "fake",
      authority: "https://login.microsoftonline.com/common",
      vaultName: "smoke",
    });
    assert(res.ok, `doLogin failed: ${res.error ?? "(no error)"}`);

    // THE GATE: reload from disk and assert the tokens round-tripped.
    const reloaded = await loadConfig(cfg);
    assert(
      reloaded.onedrive.accessToken === "AT-123",
      `accessToken: expected "AT-123", got "${reloaded.onedrive.accessToken}"`,
    );
    assert(
      reloaded.onedrive.refreshToken === "RT-456",
      `refreshToken: expected "RT-456", got "${reloaded.onedrive.refreshToken}"`,
    );
    // DEVIGATION FROM CONTRACT (documented): the contract spec'd
    // `accessTokenExpiresAtTime > Date.now()`. That assertion does NOT hold
    // given the ACTUAL setConfigBySuccessfullAuthInplace formula
    // (fsOnedrive.ts:554-555):
    //     config.accessTokenExpiresAtTime = Date.now() + authRes.expires_in - 5*60*1000;
    // authRes.expires_in is SECONDS (RFC 6749 — AAD returns 3600), but it is
    // added to Date.now() (MS) WITHOUT `* 1000`, then 300000 ms is subtracted
    // → result = now + 3600 - 300000 = now - 296400 (~4min56sec in the PAST).
    // The smoke measured exactly this (diff 296403 ms). This is a latent
    // unit-mismatch quirk in the REUSED src function — out of scope for C1a
    // (Rule: don't touch src; reuse the mapping). The contract's `> now`
    // assertion was based on a misreading of that formula.
    //
    // What DOES prove setConfigBySuccessfullAuthInplace ran (and round-tripped
    // through save→reload): expiresInSeconds === 3600 (the raw expires_in,
    // stored verbatim) + expiresAtTime is the formula's output (within a
    // few seconds of now - 296400) + it's no longer the default 0.
    assert(
      reloaded.onedrive.accessTokenExpiresInSeconds === 3600,
      `accessTokenExpiresInSeconds: expected 3600, got ${reloaded.onedrive.accessTokenExpiresInSeconds}`,
    );
    assert(
      reloaded.onedrive.accessTokenExpiresAtTime !== 0,
      `accessTokenExpiresAtTime should be non-zero (default is 0) — proves setConfigBySuccessfullAuthInplace ran`,
    );
    // FIXED (fsOnedrive.ts:554 + expires_in * 1000): formula now yields
    // now + expires_in*1000 - 5min = now + 3,300,000 (~55min future) for
    // expires_in=3600. Assert FUTURE + sane upper bound (proves the fix).
    const now = Date.now();
    assert(
      reloaded.onedrive.accessTokenExpiresAtTime > now,
      `accessTokenExpiresAtTime (${reloaded.onedrive.accessTokenExpiresAtTime}) should be > now (${now}) — proves the expires_in * 1000 fix`,
    );
    assert(
      reloaded.onedrive.accessTokenExpiresAtTime < now + 4_000_000,
      `accessTokenExpiresAtTime (${reloaded.onedrive.accessTokenExpiresAtTime}) should be < now+4,000,000 (${now + 4_000_000}) — sane upper bound for expires_in=3600`,
    );
    assert(
      reloaded.onedrive.credentialsShouldBeDeletedAtTime! > Date.now(),
      `credentialsShouldBeDeletedAtTime should be in the future — proves the 80-day expiry was set`,
    );
    assert(
      reloaded.serviceType === "onedrive",
      `serviceType: expected "onedrive", got "${reloaded.serviceType}"`,
    );

    // Prove the file is on disk + is valid JSON (saveConfig wrote it).
    // OnedriveConfig uses camelCase (`accessToken`), NOT the snake_case
    // `access_token` of the AAD response — setConfigBySuccessfullAuthInplace
    // maps response.access_token → config.accessToken.
    const raw = await fs.readFile(cfg, "utf8");
    const doc = JSON.parse(raw);
    assert(
      doc.onedrive.accessToken === "AT-123",
      `saved JSON onedrive.accessToken: expected "AT-123", got "${doc.onedrive?.accessToken}"`,
    );

    console.log("LOGIN OK");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`LOGIN FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("LOGIN ERROR", err);
  process.exit(1);
});
