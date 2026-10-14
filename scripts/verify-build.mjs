// Post-build artifact assertion.
//
// WHY THIS EXISTS: esbuild's `define` is a LEXICAL (token-level) substitution.
// It replaces the literal token `global.DEFAULT_ONEDRIVE_CLIENT_ID` in source
// with a string literal at build time. It does NOT define a property on the
// runtime `window` object. So if source ever reads `window.DEFAULT_ONEDRIVE_*`
// instead of `global.DEFAULT_ONEDRIVE_*`, the define silently does NOT match,
// the constant compiles to `undefined`, and OneDrive auth breaks with an empty
// modal (clientID resolves to "" -> invalid auth URL).
//
// This failure is INVISIBLE to every other gate we have:
//   - `tsc -noEmit` passes (the `declare global { var ... }` types it as string)
//   - `mocha --import=tsx` passes (tsx doesn't run esbuild's define, so the
//     constant is undefined in tests too — but nothing asserts it's non-empty)
//   - esbuild exits 0 (it does not warn that a defined token was never matched)
//
// Only a BUILD-ARTIFACT assertion can catch it. This script reads the emitted
// main.js and proves the define actually fired:
//   1. No `.DEFAULT_ONEDRIVE_CLIENT_ID` / `.DEFAULT_ONEDRIVE_AUTHORITY` member
//      access survives (property names are NOT renamed by minify, so an
//      unmatched define leaves the `.DEFAULT_ONEDRIVE_*` token literally in
//      the bundle — a reliable smoking gun).
//   2. The expected client-id and authority string literals are present.
//
// Run automatically at the end of `npm run build`. Exits non-zero on failure
// so CI / local builds break loudly the instant the define stops matching.
//
// KEEP IN SYNC with esbuild.config.mjs for the expected values + .env loader.

import fs from "fs";
import path from "path";

const cwd = process.cwd();

// Inline .env loader — mirrors esbuild.config.mjs (single source of truth
// lives there; this is duplicated because esbuild.config.mjs has build side
// effects on import, so we can't import it).
const expected = {
  clientId: "5be03f08-f4bf-406b-9e78-ff6a7d4e7cd4",
  authority: "https://login.microsoftonline.com/common",
};
const envPath = path.join(cwd, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (m[1] === "ONEDRIVE_CLIENT_ID") expected.clientId = m[2];
    if (m[1] === "ONEDRIVE_AUTHORITY") expected.authority = m[2];
  }
}

const mainJsPath = path.join(cwd, "main.js");
if (!fs.existsSync(mainJsPath)) {
  console.error("[verify-build] main.js not found — run the build first.");
  process.exit(1);
}
const mainJs = fs.readFileSync(mainJsPath, "utf8");

let failures = 0;
const assert = (cond, msg) => {
  if (cond) {
    console.log(`[verify-build] PASS: ${msg}`);
  } else {
    console.error(`[verify-build] FAIL: ${msg}`);
    failures++;
  }
};

// 1. No unmatched define — the `.DEFAULT_ONEDRIVE_*` member-access token must
//    NOT survive in the bundle. (If the define matched, the whole member
//    expression is replaced by a string literal and the property name
//    disappears entirely. Minify does not rename property names, so any
//    leftover `.DEFAULT_ONEDRIVE_*` means the define silently did not fire.)
assert(
  !/\.DEFAULT_ONEDRIVE_CLIENT_ID/.test(mainJs),
  "no leftover `.DEFAULT_ONEDRIVE_CLIENT_ID` member access (define fired)"
);
assert(
  !/\.DEFAULT_ONEDRIVE_AUTHORITY/.test(mainJs),
  "no leftover `.DEFAULT_ONEDRIVE_AUTHORITY` member access (define fired)"
);

// 2. The expected build-time-injected string literals are actually present.
assert(
  mainJs.includes(expected.clientId),
  `client-id string literal injected into bundle (${expected.clientId})`
);
assert(
  mainJs.includes(expected.authority),
  `authority string literal injected into bundle (${expected.authority})`
);

if (failures > 0) {
  console.error(
    `\n[verify-build] ${failures} assertion(s) failed.\n` +
      `This means an esbuild \`define\` stopped matching the source — usually\n` +
      `because source reads \`window.DEFAULT_ONEDRIVE_*\` (or \`globalThis.*\`)\n` +
      `instead of \`global.DEFAULT_ONEDRIVE_*\`. esbuild define is lexical and\n` +
      `does NOT set a runtime property on window. Fix the source to read\n` +
      `\`global.DEFAULT_ONEDRIVE_*\` (see src/baseTypes.ts header comment).\n`
  );
  process.exit(1);
}
console.log("[verify-build] all build-artifact assertions passed.");
