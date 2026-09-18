// Deploys main.js + manifest.json + styles.css to the Obsidian vault plugin folder.
//
// Vault resolution order:
//   1. VAULT_PATH env var (or .env) — explicit, preferred.
//   2. Auto-discovery from Obsidian's obsidian.json — finds a vault that
//      already has this plugin's folder installed, so `npm run deploy` works
//      with NO .env on a dev machine where the plugin is installed somewhere.
//      (Multi-vault: picks the first vault whose .obsidian/plugins/<id> exists;
//      set VAULT_PATH to disambiguate.)
//
// Creates the plugin dir if needed. Standalone use: `npm run deploy`.
// (The esbuild watch/build auto-deploy is a SEPARATE inline plugin in
// esbuild.config.mjs and is unaffected by changes here.)
import "dotenv/config";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const PLUGIN_ID = "remotely-save-onedrive";
const FILES = ["main.js", "manifest.json", "styles.css"];

// Reload the plugin in the running Obsidian instance so deployed changes take
// effect immediately. Uses the `obsidian` CLI (https://help.obsidian.md/cli);
// requires Obsidian to be open. Gracefully no-ops (warning only) when the CLI
// is missing or Obsidian isn't running, so this is safe in CI / headless use.
function reloadPlugin(pluginId) {
  const res = spawnSync("obsidian", ["plugin:reload", `id=${pluginId}`], {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) {
    console.warn(
      `[deploy] plugin reload skipped — install the Obsidian CLI and open ` +
        `Obsidian to auto-reload, or toggle the plugin off/on manually.`
    );
    return;
  }
  console.log(`[deploy] reloaded plugin "${pluginId}" in Obsidian.`);
}

// Path to Obsidian's global config, which lists every known vault + its path.
function obsidianConfigPath() {
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  if (process.platform === "win32" && appdata) {
    return path.join(appdata, "obsidian", "obsidian.json");
  }
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "obsidian",
      "obsidian.json"
    );
  }
  return path.join(home, ".config", "obsidian", "obsidian.json");
}

// Auto-discover a vault that already has this plugin's folder installed.
// Returns the vault path, or null if none found / config unreadable.
function discoverVaultPath() {
  const cfgPath = obsidianConfigPath();
  if (!fs.existsSync(cfgPath)) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }
  const vaults = cfg?.vaults;
  if (!vaults || typeof vaults !== "object") return null;
  for (const key of Object.keys(vaults)) {
    const v = vaults[key];
    const p = v?.path;
    if (!p) continue;
    const pluginDir = path.join(p, ".obsidian", "plugins", PLUGIN_ID);
    if (fs.existsSync(pluginDir)) {
      return p;
    }
  }
  return null;
}

let vaultPath = process.env.VAULT_PATH;
let discovered = false;
if (!vaultPath) {
  vaultPath = discoverVaultPath();
  if (vaultPath) {
    discovered = true;
    console.log(
      `[deploy] VAULT_PATH not set — auto-discovered vault: ${vaultPath}`
    );
  } else {
    console.error(
      `[deploy] VAULT_PATH not set and no vault with plugin "${PLUGIN_ID}" ` +
        `found in ${obsidianConfigPath()}. ` +
        "Set VAULT_PATH in .env, or install the plugin in a vault first."
    );
    // Fail loud: a no-op deploy is almost always a mistake (the build won't
    // reach any vault). The previous silent-exit-0 hid exactly this failure.
    process.exit(1);
  }
}

const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);

if (!fs.existsSync(pluginDir)) {
  fs.mkdirSync(pluginDir, { recursive: true });
  console.log(`[deploy] created ${pluginDir}`);
}

let copied = 0;
for (const file of FILES) {
  const src = path.join(projectRoot, file);
  if (fs.existsSync(src)) {
    const dest = path.join(pluginDir, file);
    fs.copyFileSync(src, dest);
    const st = fs.statSync(dest);
    console.log(
      `[deploy] ${file} -> ${pluginDir}  (${st.size} bytes, ${st.mtime.toISOString()})`
    );
    copied++;
  } else {
    console.warn(`[deploy] ${file} not found in project root — skipping.`);
  }
}
reloadPlugin(PLUGIN_ID);
console.log(
  `[deploy] done (${copied}/${FILES.length} files${discovered ? ", auto-discovered" : ""}).`
);
