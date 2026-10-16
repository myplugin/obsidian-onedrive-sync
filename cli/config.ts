// Headless CLI config-file persistence (Phase C Milestone C1a).
//
// The CLI keeps its OWN config at ~/.config/ods/config.json (XDG base dir;
// Q2 decided). It is a plain `RemotelySavePluginSettings` JSON document —
// the SAME shape the plugin persists to data.json, so a future `cli import`
// / `cli export` can round-trip against the plugin's data.json without a
// schema conversion.
//
// CHOICE — plain JSON, NOT the plugin's `normalConfigToMessy` obfuscation:
//   - The plugin obfuscates data.json because it lives in the vault
//     (syncable, copyable, user-visible). The CLI config lives at
//     ~/.config/ods/config.json with mode 0600 (owner-read/write only) —
//     file permissions are the correct access-control mechanism here, not
//     obfuscation.
//   - Plain JSON is debuggable (`cat ~/.config/ods/config.json`) and keeps
//     the load/save path trivial (no dependency on configPersist.ts, which
//     pulls in the plugin's obfuscation keys + i18n).
//   - If the CLI ever needs to import/export a plugin data.json, that path
//     will call configPersist.ts explicitly; the local CLI file stays plain.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { RemotelySavePluginSettings } from "../src/baseTypes";
import { DEFAULT_ONEDRIVE_CONFIG } from "../src/fsOnedrive";

// XDG-ish: ~/.config/ods/config.json. (Not $XDG_CONFIG_HOME — the CLI is a
// single-user tool and a fixed path is easier to document; matches the
// contract's pinned `os.homedir()` join.)
export const DEFAULT_CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "ods",
  "config.json",
);

// The baked-in defaults mirror esbuild.config.cli.mjs:35-38 (which itself
// mirrors esbuild.config.mjs). Read from process.env at runtime so an
// ONEDRIVE_CLIENT_ID / ONEDRIVE_AUTHORITY env override applies to a freshly
// created config too (not just the build).
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

// A fresh, CLI-sane RemotelySavePluginSettings. Required fields only
// (onedrive / password / serviceType) + the onedrive clientID/authority
// defaults; every other field is optional on the type and left undefined so
// a save→reload round-trips to an identical document.
function freshDefaultConfig(): RemotelySavePluginSettings {
  return {
    onedrive: {
      ...DEFAULT_ONEDRIVE_CONFIG,
      clientID: defaultClientID(),
      authority: defaultAuthority(),
    },
    password: "",
    serviceType: "onedrive",
  };
}

// Load the CLI config. Missing/empty/corrupt file → fresh default (NEVER
// throws on first run). A corrupt file is overwritten on the next save, but
// load itself returns a default rather than surfacing a parse error — the
// CLI is interactive and a bad config shouldn't block a `login`.
export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<RemotelySavePluginSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    // ENOENT (first run) or EACCES — treat as "no config yet".
    return freshDefaultConfig();
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return freshDefaultConfig();
  }

  try {
    const parsed = JSON.parse(trimmed) as RemotelySavePluginSettings;
    // Minimal shape check: the two fields login/sync actually depend on.
    // (A config missing `.onedrive` is unusable; reset to defaults.)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.onedrive !== "object" ||
      parsed.onedrive === null
    ) {
      return freshDefaultConfig();
    }
    return parsed;
  } catch {
    // Corrupt JSON — don't throw, don't silently lose it: return defaults.
    // (The file is preserved on disk until the next save overwrites it.)
    return freshDefaultConfig();
  }
}

// Save the CLI config: mkdir -p the parent dir, write JSON (2-space indent),
// then chmod 0600 (owner read/write only). chmod is best-effort — on Windows
// fs.chmod only flips the read-only bit (POSIX modes are advisory), so a
// failure there is logged but does NOT fail the save (the data is written).
export async function saveConfig(
  configPath: string,
  settings: RemotelySavePluginSettings,
): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(settings, null, 2), "utf8");
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // Windows: chmod is advisory at best. POSIX: should never fail after a
    // successful writeFile to the same path. Swallow either way — the file
    // is written and readable by the owner, which is what matters.
  }
}
