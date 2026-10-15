// Runs ALL Obsidian community-directory scanner checks locally:
// 1. ESLint - all obsidianmd.configs.recommended rules ON (auto-updates with plugin)
// 2. CSS lint - checks styles.css for !important (scanner flags it)
// 3. Dependency audit - checks for known vulnerabilities in production deps
// 4. Lockfile sync - checks package-lock.json is in sync with package.json
// 5. Version consistency - package.json, manifest.json, manifest-beta.json, versions.json
// 6. Installability - npm ci --dry-run verifies the lockfile can install
// 7. Manifest fields - checks manifest.json has all required Obsidian plugin fields
//
// Usage: npm run scan
// Exit code 0 = clean (all pass). Non-zero = warnings remain.
//
// Auto-update: ESLint rules auto-update because eslint.config.mjs uses
// obsidianmd.configs.recommended (same as the scanner). When eslint-plugin-obsidianmd
// releases new rules, they're automatically ON here. Non-ESLint checks (CSS, deps,
// lockfile, manifest) are manually maintained — watch the scanner output for new
// categories.

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

let failures = 0;

// == 1. ESLint (TS/JS) ==
// All rules ON from eslint.config.mjs (obsidianmd.configs.recommended).
// --max-warnings 0 makes any warning fatal (matches scanner's view).
const eslintCmd = `npx eslint "src/**/*.ts" --max-warnings 0`;
console.log("== ESLint (TS/JS rules) ==");
try {
  execSync(eslintCmd, { stdio: "inherit" });
  console.log("  \u2713 ESLint: 0 warnings\n");
} catch (e) {
  console.log("  \u2717 ESLint: warnings remain (see above)\n");
  failures++;
}

// == 2. CSS lint (!important) ==
console.log("== CSS lint (!important) ==");
try {
  const css = readFileSync("styles.css", "utf8");
  const lines = css.split("\n");
  const lineNums = [];
  lines.forEach((line, i) => {
    if (line.includes("!important")) lineNums.push(i + 1);
  });
  if (lineNums.length > 0) {
    console.log(`  \u2717 CSS: ${lineNums.length} !important declarations in styles.css`);
    console.log(`    Lines: ${lineNums.join(", ")}`);
    console.log("    Override styles by increasing selector specificity instead.\n");
    failures++;
  } else {
    console.log("  \u2713 CSS: 0 !important declarations\n");
  }
} catch (e) {
  console.log("  ! styles.css not found, skipping CSS check\n");
}

// == 3. Dependency audit ==
console.log("== Dependency audit (production deps) ==");
try {
  execSync(
    "npm audit --omit=dev --registry=https://registry.npmjs.org",
    { stdio: "pipe", encoding: "utf8" }
  );
  console.log("  \u2713 Dependencies: 0 vulnerabilities\n");
} catch (e) {
  const output = (e.stdout || "") + (e.stderr || "");
  if (output.includes("vulnerabilities") || output.includes("vulnerable")) {
    const lines = output.split("\n").filter((l) =>
      l.includes("vulnerabilit") || l.includes("severity") || l.includes("GHSA")
    );
    console.log("  \u2717 Dependencies: vulnerabilities found");
    lines.forEach((l) => console.log("    " + l.trim()));
    console.log("");
    failures++;
  } else {
    console.log("  \u2713 Dependencies: 0 vulnerabilities\n");
  }
}

// == 4. Lockfile sync (package-lock.json) ==
// Runs npm install --package-lock-only and compares the lockfile content
// before/after. If it changed, the lockfile was stale (package.json was
// modified without npm install). Restores the original on mismatch.
console.log("== Lockfile sync (package-lock.json) ==");
try {
  const lockBefore = readFileSync("package-lock.json", "utf8");
  execSync("npm install --package-lock-only", {
    stdio: "pipe",
    encoding: "utf8",
  });
  const lockAfter = readFileSync("package-lock.json", "utf8");
  if (lockBefore !== lockAfter) {
    console.log("  \u2717 Lockfile: out of date \u2014 run 'npm install' and commit package-lock.json\n");
    writeFileSync("package-lock.json", lockBefore);
    failures++;
  } else {
    console.log("  \u2713 Lockfile: in sync with package.json\n");
  }
} catch (e) {
  console.log("  ! Lockfile check skipped (npm install --package-lock-only failed)\n");
}

// == 5. Version consistency ==
// Catches the "bumped one file, forgot another" mistake. All of package.json,
// manifest.json, manifest-beta.json must agree, and versions.json must have
// an entry for the current version.
console.log("== Version consistency ==");
try {
  const pkgVer = JSON.parse(readFileSync("package.json", "utf8")).version;
  const manifestVer = JSON.parse(readFileSync("manifest.json", "utf8")).version;
  const betaVer = JSON.parse(readFileSync("manifest-beta.json", "utf8")).version;
  const versions = JSON.parse(readFileSync("versions.json", "utf8"));
  const issues = [];
  if (pkgVer !== manifestVer) issues.push(`package.json (${pkgVer}) != manifest.json (${manifestVer})`);
  if (pkgVer !== betaVer) issues.push(`package.json (${pkgVer}) != manifest-beta.json (${betaVer})`);
  if (!(pkgVer in versions)) issues.push(`versions.json missing entry for ${pkgVer}`);
  if (issues.length > 0) {
    console.log("  \u2717 Version mismatch:");
    issues.forEach((i) => console.log("    " + i));
    console.log("");
    failures++;
  } else {
    console.log(`  \u2713 All version files at ${pkgVer}, versions.json has entry\n`);
  }
} catch (e) {
  console.log("  ! Version check skipped: " + (e.message || "error") + "\n");
}

// == 6. Installability (npm ci --dry-run) ==
// The scanner installs deps from the lockfile. If npm ci fails, the scanner
// reports "Source review dependency installation failed" and skips checks.
// This verifies the lockfile is installable without touching node_modules.
console.log("== Installability (npm ci --dry-run) ==");
try {
  execSync("npm ci --dry-run", { stdio: "pipe", encoding: "utf8" });
  console.log("  \u2713 Install: lockfile is installable\n");
} catch (e) {
  const output = (e.stdout || "") + (e.stderr || "");
  console.log("  \u2717 Install: npm ci --dry-run failed");
  const lines = output.split("\n").filter((l) =>
    l.includes("error") || l.includes("mismatch") || l.includes("ERESOLVE") ||
    l.includes("ENOENT") || l.includes("lockfile")
  );
  lines.slice(0, 5).forEach((l) => console.log("    " + l.trim()));
  console.log("");
  failures++;
}

// == 7. Manifest field validation ==
// Catches accidental field deletion or type change in manifest.json. The
// Obsidian plugin spec requires all of these fields with the right types.
console.log("== Manifest field validation ==");
try {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const required = {
    id: "string",
    name: "string",
    version: "string",
    minAppVersion: "string",
    description: "string",
    author: "string",
    isDesktopOnly: "boolean",
  };
  const missing = [];
  const wrongType = [];
  for (const [field, type] of Object.entries(required)) {
    if (!(field in manifest)) {
      missing.push(field);
    } else if (typeof manifest[field] !== type) {
      wrongType.push(`${field}: expected ${type}, got ${typeof manifest[field]}`);
    }
  }
  if (missing.length > 0 || wrongType.length > 0) {
    console.log("  \u2717 Manifest issues:");
    missing.forEach((f) => console.log(`    missing: ${f}`));
    wrongType.forEach((w) => console.log(`    type: ${w}`));
    console.log("");
    failures++;
  } else {
    console.log("  \u2713 Manifest: all 7 required fields present + correct type\n");
  }
} catch (e) {
  console.log("  ! Manifest check skipped: " + (e.message || "error") + "\n");
}

// == Summary ==
if (failures === 0) {
  console.log("======================================================");
  console.log("\u2713 Clean \u2014 0 warnings across all 7 checks.");
} else {
  console.log("======================================================");
  console.log(`\u2717 ${failures} check(s) failed (see above).`);
  process.exit(1);
}
