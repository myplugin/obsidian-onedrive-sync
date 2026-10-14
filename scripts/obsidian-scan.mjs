// Runs eslint with ALL Obsidian community-directory scanner rules enabled.
// The local eslint.config.mjs turns OFF some rules (any/unsafe-*/assertion/
// unbound-method) to prevent --fix from mangling the style. This script
// re-enables them to match the scanner's DEFAULT config (all rules ON).
//
// Usage: npm run scan
// Exit code 0 = clean (0 warnings). Non-zero = warnings remain.
import { execSync } from "child_process";

// Rules that eslint.config.mjs turns OFF locally — re-enable to match scanner.
const REENABLED = [
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-unnecessary-type-assertion",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/unbound-method",
  "@typescript-eslint/no-empty-object-type",
  "@typescript-eslint/await-thenable",
  "@typescript-eslint/no-base-to-string",
  "@typescript-eslint/restrict-template-expressions",
  "@typescript-eslint/no-duplicate-type-constituents",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/no-floating-promises",
  "no-self-compare",
  "obsidianmd/prefer-window-timers",
  "obsidianmd/settings-tab/prefer-setting-definitions",
  "obsidianmd/settings-tab/no-deprecated-display",
].map((r) => `--rule "${r}:warn"`);

const cmd = `npx eslint "src/**/*.ts" --max-warnings 0 ${REENABLED.join(" ")}`;
console.log("Obsidian community-directory scanner view (all rules ON):");
console.log(cmd + "\n");
try {
  execSync(cmd, { stdio: "inherit" });
  console.log("\n\u2713 Clean \u2014 0 warnings.");
} catch (e) {
  console.log("\n\u2717 Warnings remain (see above).");
  process.exit(1);
}
