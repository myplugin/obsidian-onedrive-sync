// Headless CLI `login` command (Phase C Milestone C1a).
//
// Implements the Device Code Flow → populate OnedriveConfig → save cycle.
// REUSES the existing `acquireByDeviceCode` (src/deviceCode.ts) and
// `setConfigBySuccessfullAuthInplace` (src/fsOnedrive.ts:547-568) — does NOT
// reinvent the token→config mapping. The HTTP transport is INJECTED
// (`httpPost`) so:
//   - the smoke (cli/login-smoke.ts) mocks httpPost (no real network), and
//   - the real `loginCommand` wires a node-fetch wrapper.
//
// This module is obsidian-free at runtime: deviceCode.ts has NO runtime
// obsidian import, and setConfigBySuccessfullAuthInplace mutates the passed
// OnedriveConfig in place (the saveFunc is passed undefined — saving is the
// caller's job, done here via cli/config.ts saveConfig).

import {
  acquireByDeviceCode,
  type DeviceCodeHttpPost,
} from "../src/deviceCode";
import { setConfigBySuccessfullAuthInplace } from "../src/fsOnedrive";
import type { RemotelySavePluginSettings } from "../src/baseTypes";
import { loadConfig, saveConfig } from "./config";

export interface LoginOpts {
  clientID: string;
  authority: string;
  vaultName: string;
}

// Core login flow with an injectable httpPost. Used by both the smoke
// (mocked httpPost) and loginCommand (real fetch). Returns `{ok:true}` on
// success (config saved) or `{ok:false, error}` on any DCF failure.
export async function doLogin(
  httpPost: DeviceCodeHttpPost,
  configPath: string,
  opts: LoginOpts,
): Promise<{ ok: boolean; error?: string }> {
  // Load (or create) the CLI config — the onedrive sub-object is mutated
  // in place by setConfigBySuccessfullAuthInplace, then the whole settings
  // object is saved back.
  const config = await loadConfig(configPath);

  const res = await acquireByDeviceCode(opts.clientID, opts.authority, httpPost, {
    deviceCodeCallback: (msg) => console.log(msg),
  });

  if ("error" in res) {
    // AccessCodeResponseFailedType — same shape a real AAD error response
    // has. Surface error + error_description (the two human-readable fields).
    return { ok: false, error: `${res.error}: ${res.error_description}` };
  }

  // Success — mutate config.onedrive in place. Pass saveFunc=undefined:
  // setConfigBySuccessfullAuthInplace's saveFunc would save the PLUGIN's
  // data.json (via the plugin's save path); the CLI saves its own config
  // file separately via saveConfig below.
  await setConfigBySuccessfullAuthInplace(config.onedrive, res, undefined);
  await saveConfig(configPath, config);
  return { ok: true };
}

// Default clientID/authority: mirror esbuild.config.cli.mjs:35-38 (which
// mirrors the plugin build). env override > baked default.
function defaultClientID(): string {
  return (
    process.env.ONEDRIVE_CLIENT_ID || "5be03f08-f4bf-406b-9e78-ff6a7d4e7cd4"
  );
}
function defaultAuthority(): string {
  return (
    process.env.ONEDRIVE_AUTHORITY ||
    "https://login.microsoftonline.com/common"
  );
}

// The real `login` command: wires a node-fetch httpPost and runs doLogin.
// /devicecode and /token both return JSON-as-text (the same shape deviceCode.ts
// JSON.parses), so the wrapper just returns the response text — matching
// DeviceCodeHttpPost's `(url, body) => Promise<string>` contract.
export async function loginCommand(
  configPath: string,
  opts: Partial<LoginOpts>,
): Promise<void> {
  const fullOpts: LoginOpts = {
    clientID: opts.clientID ?? defaultClientID(),
    authority: opts.authority ?? defaultAuthority(),
    vaultName: opts.vaultName ?? "cli",
  };

  const httpPost: DeviceCodeHttpPost = async (url, body) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return r.text();
  };

  const res = await doLogin(httpPost, configPath, fullOpts);
  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }
  console.log("login ok");
}
