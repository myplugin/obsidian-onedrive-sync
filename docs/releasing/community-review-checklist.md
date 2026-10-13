# Obsidian Community Plugin Review — Self-Check Checklist

> Persisted reference of every check the Obsidian community directory's
> automated scanner runs against this plugin. Walk through it (and run the
> linters) **before** tagging a release, so the directory review passes on the
> first try. Findings are grouped by review section and severity.
>
> Source: derived from the official scan of `onedrive-vault-sync` 0.6.7
> (2026-10-13) plus the Obsidian developer docs. Update this file when the
> scanner surfaces a new rule type.

## Severity

| Level | Meaning |
|---|---|
| **Error** | Blocks listing. The plugin is **not installable** from the directory until fixed. Must fix before every release. |
| **Warning** | Non-blocking, but fix where reasonable; clusters of warnings draw reviewer attention. |
| **Recommendation** | Suggestion — style, privacy disclosure, or dead/unused code. |
| **Pass** | Already satisfied. |

## How to self-check locally

1. **Official ESLint plugin** — the directory enforces the `obsidianmd/*` rules
   from <https://github.com/obsidianmd/eslint-plugin>. Install it per that
   repo's README, enable the `obsidianmd/*` rules, and run
   `npx eslint "src/**/*.ts"`. This reproduces the Source-code section below.
2. **Biome** — `npm run format` (`biome check --write .`) catches the generic
   formatting / escape / unused-variable rules.
3. **Build reproducibility** — the scanner rebuilds the repo with the first
   script it finds (`build` → `npm run build`) and diffs the output against the
   released `main.js` byte-for-byte. Run `npm run build` locally and confirm the
   produced `main.js` matches the release asset (same Node version, clean tree).
4. **Manual guideline pass** — re-read
   <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines> for the
   human-facing rules the linter cannot fully encode.

---

## Review sections & check items

### 1. Releases
- [ ] GitHub Release exists whose tag **=== `manifest.json` `version`** (semver `x.y.z`).
- [ ] Release carries `main.js`, `manifest.json`, `styles.css` as binary assets.
- [ ] *(Recommended)* GitHub **artifact attestation** on each asset (the release
      workflow's `actions/attest-build-provenance` step does this).

### 2. Behavior (privacy disclosures) — must be clearly stated in README
- [ ] **Vault enumeration** — if the plugin calls `vault.getFiles()` /
      `getMarkdownFiles()` / iterates every vault file, disclose it. (Inherent to
      a sync plugin — already disclosed.)
- [ ] **Clipboard access** — reads/writes the system clipboard → disclose.
- [ ] **Local storage** — uses `localStorage`/`sessionStorage` instead of the
      Obsidian plugin data APIs → disclose. Prefer `loadSettings`/`saveData()`.
- [ ] **Vault read/write** — use the Obsidian Vault API (`vault.read`,
      `vault.modify`, `vault.create`), not the raw Adapter, for reads & writes.
- [ ] **Network use** — disclose which remote services are used and why
      (OneDrive Graph, here) per the Developer Policies "Disclosures".

### 3. Source code — Obsidian ESLint rules (`obsidianmd/*`)
- [ ] **`no-unsupported-api`** *(Error)* — don't use Obsidian APIs newer than the
      declared `minAppVersion`. Either avoid the new API, or bump `minAppVersion`
      **and** add the version → `versions.json`.
      *0.6.7 finding: `src/main.ts:2110, 2111-2113`.*
- [ ] **`no-static-styles-assignment`** *(Error)* — don't set `el.style.x = …`
      directly; use CSS classes, `setCssProps`, or `setCssStyles`.
      *0.6.7 findings: `src/misc.ts:581, 602`, `src/settings.ts:591`.*
- [ ] **`prefer-setting-heading`** *(Error)* — use
      `new Setting(containerEl).setName(…).setHeading()` instead of building HTML
      heading elements (`createEl("h2")`, …) directly.
      *0.6.7 findings: `src/settings.ts` (16 sites: 593, 644-647, 649-652, 926-929, 985-988, 1119-1122, 1287-1290, 1444-1447, 1650-1653, 1729-1732, 1756-1759, 1804-1807, 1864-1867, 1965-1968, 2042-2045, 2169-2172).*
- [ ] **`no-innerHTML`** *(Error/Warning)* — never assign to `.innerHTML` /
      `.outerHTML` / `insertAdjacentHTML` with variable content; use
      `createEl`/`createSpan`/`setText`. Assigning a **function parameter** to
      `innerHTML` is flagged as an Error (untrusted source).
      *0.6.7 findings: `src/misc.ts:527` (Error — param), `src/regexListSetting.ts:110`,
      `src/settings.ts:568, 571, 684, 702, 707-708, 719-720`.*
- [ ] **`prefer-create-el`** *(Warning)* — use Obsidian's `createEl`/`createDiv`/
      `createSpan` helpers instead of `document.createElement`.

### 4. Source code — Obsidian platform guidelines
- [ ] **No `global`** — use `window` / `activeWindow()` for popout-window
      compatibility. *`src/baseTypes.ts:14, 15`.*
- [ ] **No raw `fetch`** — use Obsidian's `requestUrl` (handles CORS/proxy/mobile).
      *`src/fsOnedrive.ts` (several).*
- [ ] **`window.setTimeout`** not bare `setTimeout` (popout).
      *`src/fsOnedrive.ts:739`, `src/misc.ts:537`.*
- [ ] **No Node.js builtins on mobile** — don't `import "path"`/`"fs"`/`"os"` at
      module top level. Guard with `Platform.isDesktop` + dynamic `import()`, or
      use `normalizePath()`. *`src/misc.ts:1` (imports `path`).*
- [ ] **No `obj.hasOwnProperty(k)`** — use `Object.prototype.hasOwnProperty.call(obj, k)`
      or `Object.hasOwn(obj, k)`.
- [ ] **`PluginSettingTab.getSettingDefinitions()`** — implement the declarative
      settings API so settings appear in Obsidian's settings search (1.13.0+).
      *`src/settings.ts:581`.*
- [ ] **No runtime `<script>` injection** *(Code-obfuscation Error)* — never
      `createElement("script")`; it can load/execute arbitrary external code.
- [ ] **No `console.log`** in default config — route through the plugin's logger.

### 5. Source code — generic TypeScript/lint (Warning)
- [ ] No `any` (`@typescript-eslint/no-explicit-any`). *(Large footprint across
      `fsOnedrive.ts`, `sync.ts`, `driveItemConvert.ts`, `misc.ts`, `settings.ts`,
      `main.ts`, etc. This repo's convention accepts `any` — see
      `docs/CONVENTIONS.md` — so these are expected warnings, not blockers.)*
- [ ] No unsafe return / assignment / call / member-access / argument of `any`
      or `error` typed values (`@typescript-eslint/no-unsafe-*`).
- [ ] No unnecessary type assertions (`as X` where the receiver already accepts
      the original type).
- [ ] No non-null assertion on an optional chain (`?.foo!`) — wrong by design.
- [ ] No floating promises — `await`, `.catch()`, `.then(rej)`, or prefix `void`.
- [ ] Reject with an `Error`, not a string/value (`prefer-promise-reject-errors`).
- [ ] No `this` aliasing (`const self = this`); use arrow functions.
- [ ] No unnecessary escape characters (`\/`, `\"` in regex/strings).
- [ ] No unused vars / imports / dead code.
- [ ] No constant conditions (`if (true)`).

### 6. CSS lint
- [ ] No duplicate CSS properties (e.g. `background-color` declared twice).
      *`styles.css:167, 202`.*
- [ ] Avoid `!important` — override via selector specificity or CSS variables.
      *`styles.css:374-379, 383-385, 399-403, 411-415`.*

### 7. Dependencies
- [ ] Replace deprecated / discouraged packages
      ([es-tooling module-replacements](https://github.com/es-tooling/module-replacements)):
      `dotenv`, `emoji-regex`, `lodash`, `rimraf`.
      *`package.json:48, 71, 76, 88`.*
- [ ] No dependency vulnerability advisories — run `npm audit`. The scanner flags
      transitive vulns (e.g. `brace-expansion`, `elliptic`, `pbkdf2`, `qs`, `uuid`
      → upgrade outside the vulnerable range).

### 8. Code obfuscation
- [ ] No runtime `createElement("script")` / dynamic code injection. *(Error.)*
- [ ] *(Implied)* No `eval` / `new Function(...)` / dynamic import of remote code.

### 9. Build verification
- [ ] A clean `npm run build` reproduces the released `main.js` **byte-for-byte**
      (provenance). The scanner rebuilds the repo and diffs against the release
      asset. *0.6.7: Pass.*

---

## This plugin's current blocking Errors (0.6.7 review)

These six must be fixed before the directory will list the plugin:

| # | Rule | Location | Fix direction |
|---|------|----------|---------------|
| 1 | `no-unsupported-api` | `src/main.ts:2110, 2111-2113` | Avoid the newer API, or bump `minAppVersion` (manifest + `manifest-beta` + `versions.json`) to a version that has it |
| 2 | `no-innerHTML` (Error — function-param source) | `src/misc.ts:527` | Replace `el.innerHTML = string` with `createEl`/`setText` |
| 3 | `no-static-styles-assignment` | `src/misc.ts:581, 602`; `src/settings.ts:591` | Use a CSS class, `setCssProps`, or `setCssStyles` |
| 4 | `no-innerHTML` | `src/regexListSetting.ts:110`; `src/settings.ts:568, 571, 684, 702, 707-708, 719-720` | `createEl`/`setText` |
| 5 | `prefer-setting-heading` (HTML headings) | `src/settings.ts` (16 sites) | `new Setting(containerEl).setName(…).setHeading()` |
| 6 | code-obfuscation: `createElement("script")` | runtime | Remove the dynamic script injection |

> Note: items 3, 4, 5 touch `src/settings.ts`, `src/misc.ts`,
> `src/regexListSetting.ts` — **Apache-2.0** files (not the PolyForm-Strict
> sync-core). Fixing them is unrestricted.

## Official references
- Submit your plugin: <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>
- Plugin guidelines (human review comments): <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- Developer policies (license & disclosures): <https://docs.obsidian.md/Plugins/Releasing/Developer+policies>
- Official ESLint plugin (the `obsidianmd/*` rules): <https://github.com/obsidianmd/eslint-plugin>
- Community directory FAQ: <https://docs.obsidian.md/Community+directory/Frequently+asked+questions>
- Manifest reference: <https://docs.obsidian.md/Plugins/Reference/Manifest>
