# Obsidian scanner checklist + CI gate evolution

## Timeline

### 0.6.30 — CSS !important + elliptic vuln
- Discovered the Obsidian scanner has **3 categories** beyond ESLint: CSS lint (`!important`), dependency audit (npm audit), and lockfile sync. Previously incorrectly assumed "ESLint doesn't check CSS."
- CSS fix: 17 `!important` declarations replaced with selector specificity (`span.`/`button.` element type + doubled class for buttons). Specificity (0,3,1) beats Obsidian mobile's button-stretch rule (≈0,2,1).
- elliptic fix: `npm overrides` + `stubs/elliptic/` stub package. No fixed elliptic version exists (6.6.1 = latest = vulnerable). Plugin uses RSA (Azure AD JWTs), never EC crypto.

### 0.6.31 — Lockfile staleness incident
- **Root cause**: bumped version in `package.json` (0.6.29→0.6.30) without running `npm install` to sync `package-lock.json`. Scanner flagged: "The npm lockfile is out of date."
- **Process failure**: ran `npm run scan` (3 checks at the time: ESLint + CSS + deps) which passed, but the lockfile check didn't exist yet. Pushed without verifying the lockfile was synced.
- **Fix**: added lockfile sync check to `npm run scan` — runs `npm install --package-lock-only` + compares content before/after. Restores original on mismatch.
- Added version consistency check (package.json == manifest.json == manifest-beta.json, versions.json has entry).
- Added installability check (`npm ci --dry-run`).
- Scan went from 3 → 6 checks.

### 0.6.32 — CI build failure (esbuild "Could not resolve elliptic")
- **Root cause**: `file:./stubs/elliptic` npm override creates a symlink that works on Windows (local dev) but NOT on Linux CI (`npm ci` resolves `file:` symlinks differently). esbuild can't find `elliptic` → 3 errors: `browserify-sign/browser/sign.js`, `browserify-sign/browser/verify.js`, `create-ecdh/browser.js`.
- **Why local passed**: Windows `npm install` creates a working symlink in `node_modules/elliptic` → `stubs/elliptic/`. Linux `npm ci` recreates the lockfile's symlink structure, but the target path doesn't resolve.
- **Fix**: added esbuild `alias` to redirect `require('elliptic')` → `stubs/elliptic/index.js` at bundle time. Bypasses node_modules resolution entirely — platform-independent.
- **Debugging process**: couldn't access CI logs (no admin). Used annotations API to identify the failed step. Used `$GITHUB_STEP_SUMMARY` + browser snapshot to read the actual error message.

### CI workflow improvements
- Node 20 → Node 22 (LTS) — Node 20 deprecated on GitHub Actions.
- `npm install` → `npm ci` — deterministic install from lockfile.
- Added `npm run scan` step before `npm run build` — CI gate now matches local gate.

## Key lessons

1. **Local build passing ≠ CI passing.** Windows and Linux differ in npm symlink resolution. Must verify on CI (or at least on Linux).
2. **`file:` npm overrides are NOT cross-platform safe for bundling.** Use esbuild `alias` as a companion.
3. **The scan must cover EVERYTHING the scanner checks.** The lockfile staleness slipped through because the check didn't exist. Continuously audit the scan against the scanner's actual output.
4. **"改 package.json → npm install → npm run build → npm run scan → 再 push"** — never skip steps. The lockfile staleness was a direct result of skipping `npm install` after a version bump.
