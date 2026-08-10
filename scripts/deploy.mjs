// Deploys main.js + manifest.json + styles.css to the Obsidian vault plugin folder.
// Reads VAULT_PATH from .env (or process.env). Creates the plugin dir if needed.
// Standalone use: `npm run deploy`. Auto-invoked by webpack afterEmit plugin on dev/build.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error("[deploy] VAULT_PATH not set in .env — skipping deploy.");
  process.exit(0);
}

const pluginDir = path.join(
  vaultPath,
  ".obsidian",
  "plugins",
  "remotely-save-onedrive",
);

if (!fs.existsSync(pluginDir)) {
  fs.mkdirSync(pluginDir, { recursive: true });
  console.log(`[deploy] created ${pluginDir}`);
}

const files = ["main.js", "manifest.json", "styles.css"];
let copied = 0;
for (const file of files) {
  const src = path.join(projectRoot, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(pluginDir, file));
    console.log(`[deploy] ${file} -> ${pluginDir}`);
    copied++;
  } else {
    console.warn(`[deploy] ${file} not found in project root — skipping.`);
  }
}
console.log(
  `[deploy] done (${copied}/${files.length} files). ` +
    "In Obsidian: toggle the plugin off/on (or Ctrl+R in a dev vault) to pick up changes.",
);
