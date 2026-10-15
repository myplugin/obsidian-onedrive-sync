// Runs ALL Obsidian community-directory scanner checks locally:
// 1. ESLint — with all scanner rules ON (re-enables rules turned OFF in eslint.config.mjs)
// 2. CSS lint — checks styles.css for !important (scanner flags it)
// 3. Dependency audit — checks for known vulnerabilities in production deps
//
// Usage: npm run scan
// Exit code 0 = clean (all pass). Non-zero = warnings remain.

import { execSync } from "child_process";
import { readFileSync } from "fs";

let failures = 0;

// ── 1. ESLint (TS/JS) ──────────────────────────────────────────────
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

const eslintCmd = `npx eslint "src/**/*.ts" --max-warnings 0 ${REENABLED.join(" ")}`;
console.log("── ESLint (TS/JS rules) ──────────────────────────────");
console.log(eslintCmd);
try {
  execSync(eslintCmd, { stdio: "inherit" });
  console.log("  \u2713 ESLint: 0 warnings\n");
} catch (e) {
  console.log("  \u2717 ESLint: warnings remain (see above)\n");
  failures++;
}

// ── 2. CSS lint (!important) ───────────────────────────────────────
console.log("── CSS lint (!important) ────────────────────────────");
try {
  const css = readFileSync("styles.css", "utf8");
  const matches = [...css.matchAll(/!important/g)];
  if (matches.length > 0) {
    // Find line numbers for each match
    const lines = css.split("\n");
    const sites = [];
    let charIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (charIdx + lines[i].length >= matches[0]?.index ?? -1) {
        // simplistic — just count per line
      }
      charIdx += lines[i].length + 1;
    }
    // Simpler: grep line by line
    const lineNums = [];
    lines.forEach((line, i) => {
      if (line.includes("!important")) lineNums.push(i + 1);
    });
    console.log(`  \u2717 CSS: ${matches.length} !important declarations in styles.css`);
    console.log(`    Lines: ${lineNums.join(", ")}`);
    console.log("    Override styles by increasing selector specificity instead.\n");
    failures++;
  } else {
    console.log("  \u2713 CSS: 0 !important declarations\n");
  }
} catch (e) {
  console.log("  ! styles.css not found, skipping CSS check\n");
}

// ── 3. Dependency audit ────────────────────────────────────────────
console.log("── Dependency audit (production deps) ────────────────");
try {
  execSync(
    "npm audit --omit=dev --registry=https://registry.npmjs.org",
    { stdio: "pipe", encoding: "utf8" }
  );
  console.log("  \u2713 Dependencies: 0 vulnerabilities\n");
} catch (e) {
  const output = (e.stdout || "") + (e.stderr || "");
  if (output.includes("vulnerabilities") || output.includes("vulnerable")) {
    // Extract just the summary line
    const lines = output.split("\n").filter((l) =>
      l.includes("vulnerabilit") || l.includes("severity") || l.includes("elliptic") ||
      l.includes("moment") || l.includes("GHSA")
    );
    console.log("  \u2717 Dependencies: vulnerabilities found");
    lines.forEach((l) => console.log("    " + l.trim()));
    console.log("");
    failures++;
  } else {
    console.log("  \u2713 Dependencies: 0 vulnerabilities\n");
  }
}

// ── Summary ────────────────────────────────────────────────────────
if (failures === 0) {
  console.log("======================================================");
  console.log("\u2713 Clean \u2014 0 warnings across ESLint, CSS, and dependencies.");
} else {
  console.log("======================================================");
  console.log(`\u2717 ${failures} check(s) failed (see above).`);
  process.exit(1);
}
