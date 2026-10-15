# Project Conventions — onedrive-vault-sync

Accumulated project-level rules. Append-only. (See also `AGENTS.md` for the canonical project guide; this file captures conventions surfaced during work that aren't yet in AGENTS.md.)

## Converter purity

`fromDriveItemToEntity` and its split helpers (`extractDriveItemMetadata`, `deriveKeyFromPath`, `fromDriveItemToEntityWithIdFallback`, `isApprootRootDriveItem`) in `src/driveItemConvert.ts` must be **PURE** — no I/O, no `obsidian`/`msal` runtime imports, no side effects. This is what makes them unit-testable against realistic Graph delta shapes (which is how the `parentReference.path`-omission bug was caught). Inject dependencies (converter, `idToKeyMap`) via parameters; do not reach for module-level state.

## Throw-order preservation

When refactoring `fromDriveItemToEntity`, preserve the **exact throw order**: approot-root → `remoteItem`/`package`/`bundle` → path-missing → missing-mtime. Existing `assert.throws` tests pin which error fires first (a path-less item with no `fileSystemInfo` must throw `"parentReference.path is undefinded or null"`, NOT `"onedrive cannot parse mtime"`). In the split, `deriveKeyFromPath` (throws on path-missing) is called BEFORE `extractDriveItemMetadata` (throws on mtime).

## Error-coupling via `.code`, not message-string

Throws that a `catch` matches on must carry a stable `.code` property (e.g. `ONEDRIVE_PATH_MISSING`, `REMOTE_ETAG_MISMATCH`, `REMOTE_NOT_FOUND`), NOT a fragile `e.message.includes("...")` string match. Message text may contain historical typos; a catch coupled to the message silently breaks if the typo is "fixed" without updating both sites. Mirror the `remoteEtagMismatchError` / `remoteNotFoundError` pattern (`new Error(msg); (err as any).code = "..."; return err`). Keep the message verbatim for `assert.throws` regex tests; add `.code` for programmatic matching.

## Entity is flat-primitive-copyable; prevRemoteEntities is session-scoped

`Entity` (`src/baseTypes.ts`) is designed "flat and primitive, so we can copy." Adding optional fields (e.g. `remoteId`, `etag`) is backward-compatible. `prevRemoteEntities` is cleared on every plugin load (`main.ts:712`) — session-scoped — so new Entity fields need no long-lived persisted-state migration; the first full-walk of each session populates them fresh.

## Build-time external commands must fail gracefully

Any build/deploy step that shells out to an external tool — e.g. the `obsidian` CLI (`obsidian plugin:reload id=onedrive-vault-sync`) invoked from the deploy hooks — must degrade **gracefully**: warn-only on absence/failure, never throw or exit non-zero. CI and headless builds (where the tool/Obsidian isn't present) must stay green. Use `spawnSync(..., { shell: true })` (handles Windows `.cmd` shims) and treat any `error`/non-zero `status` as a soft skip.

## Keep both deploy paths in sync

The project has two deploy paths — the inline `deployPlugin` `onEnd` in `esbuild.config.mjs` (build/watch-coupled, gated on `VAULT_PATH`) and `scripts/deploy.mjs` (standalone `npm run deploy`, vault auto-discovery). They intentionally don't share a helper. Any deploy-affecting change (files copied, the post-deploy `reloadPlugin` step, path logic) must be applied to **both**. Do not couple the esbuild plugin to `scripts/deploy.mjs` — its `process.exit`/auto-discovery semantics don't belong inside `onEnd`.

## parent-id-chain fallback (delta id-walk)

When `parentReference.path` is missing for a non-root delta item (the documented Graph delta shape — "track items by id"), resolve the vault-relative key by walking `parentReference.id` upward instead of throwing:

- `deriveKeyFromParentChain(x, lookupMap, approotRootId, remoteBaseDir)` + `fromDriveItemToEntityWithChainFallback(...)` in `src/driveItemConvert.ts` are PURE — same purity rule as the rest of the converter family (`lookupMap` + `approotRootId` injected via params, no I/O). `fromDriveItemToEntityWithIdFallback` is kept (test-only surface now) — do NOT delete unless its tests migrate to the chain variant.
- Resolution tiers: own-id in `lookupMap` (modify case, reuse `keyRaw` verbatim) → baseline `parentReference.id === approotRootId` (`name(+"/")`) → chain `parentKey+name(+"/")` (`parentKey=="/"` degrades to baseline, never `//`) → else throw `ONEDRIVE_PATH_MISSING` → skip + deltaLink self-heal.
- `approotRootId` is captured in `FakeFsOnedrive._init()` from the `/drive/special/approot/children` filter hit (`x.name === remoteBaseDir`); stable per-instance, populated on the first `_init()` of each session. Gracefully degrades to `undefined` (baseline branch never matches → self-heal) if capture is missed.
- `classifyDeltaItems` takes a shared `lookupMap` (4th param; prev `idToKeyMap` ∪ `{approotRootId→"/"}`) and mutates it IN-PLACE across a two-pass rescan (each resolved item seeds `id→keyRaw` for in-batch parent-child chains, order-independent). The caller MUST pass a FRESH COPY (`new Map(idToKeyMap)`) so `prevRemoteEntities` is never mutated. The 5th param `approotRootId?` documents caller intent; the actual fallback is performed by the closure-bound converter (same pattern as the 4th param).

## Settings export: split by storage source

Settings export (`src/importExport.ts`, modal in `src/settings.ts`) produces **two** independent URIs/QRs, each reading the store that actually holds that data:

- **Config QR** (`func=settings`): credential-free. Take a settings clone, run `stripOnedriveAuthInPlace` on `onedrive` (clears refreshToken/deltaLink/username/accessToken/expiry) AND clear `settings.password` (= the data.json shape). Share-safe; this is the default export.
- **Credentials QR** (`func=onedrive_auth`): read the IndexedDB auth record (`getOnedriveAuthByVault`); payload is exactly `{refreshToken, password, username, credentialsShouldBeDeletedAtTime, clientID, authority}`. Opt-in (modal shows a strong warning). Shows "not connected" if no refreshToken.

`deltaLink` is NEVER exported (per-device sync cursor; importing a foreign one makes a device skip files it never saw). `accessToken` is NEVER exported (short-lived; the target refreshes). See `docs/aar/settings-export-qr-split.md`.

## CONFIG_SCHEMA_VERSION

`CONFIG_SCHEMA_VERSION` (in `src/baseTypes.ts`) is an integer **independent of the plugin release version**, carried in export URIs as `sv=<n>`. Bump rules:

- **+1 ONLY on an incompatible change** to the exported settings shape: renamed/removed/redefined field, narrowed type, a default change that silently alters imported behavior.
- **No bump** for compatible changes: adding an optional field (importer fills its default), changing a default value, adding an enum value, widening a type.

Import (`applyImportedUriParams` in `main.ts`) rejects when exporter's `sv` ≠ importer's. The importer must (a) fill defaults for fields missing in the incoming payload (the `Object.assign({}, DEFAULT_SETTINGS, loaded)` pattern already does), and (b) tolerate/ignore unknown fields. Same-`sv` ⇒ default-stripping is safe.

## QR rendering: ECC L + copy-URI fallback

`QRCode.toDataURL` is called with `errorCorrectionLevel: "L"` (max capacity; we control the display so low redundancy is acceptable). The call is wrapped in try/catch and returns `imgUri?: string` — `undefined` when the payload won't fit a QR. The modal must handle `imgUri === undefined` by showing a "too big" message AND a copy-URI button (the URI itself always builds, so clipboard transfer still works). Never let a QR-too-big throw reach the modal's `onOpen` uncaught (that was the original blank-modal bug).

## Import merge routing (no shallow-merge of partial onedrive)

`applyImportedUriParams(inputParams)` is the SINGLE entry for applying an imported `obsidian://onedrive-sync?...` URI (shared by the protocol handler and the settings-tab text paste). It dispatches on `func`:

- `func=settings`: `Object.assign({}, this.settings, copied)` then **`await mergeOnedriveAuthFromDBOrMigrate()`** then `saveSettings()`. The re-merge is mandatory: the config payload's stripped onedrive (`refreshToken:""`, `password:""`) would otherwise be extracted-and-written to the DB by `saveSettings`, clobbering the target's login. The re-merge restores the target's real auth first.
- `func=onedrive_auth`: merge the imported fields into the target's EXISTING DB auth record (`getOnedriveAuthByVault` → `upsertOnedriveAuthByVault`), preserving the target's `accessToken`/`deltaLink`/`accessTokenExpires*`. Never replace the whole record with a partial. Then `mergeOnedriveAuthFromDB` + `saveSettings`.

Never `Object.assign` a partial `onedrive` object onto `this.settings` — shallow merge replaces the whole `onedrive` and clobbers sibling fields. Route to the right store instead.

## Device secrets storage (IndexedDB, not data.json)

Device-specific secrets — `refreshToken`, `deltaLink`, `username`, `accessToken`, `accessTokenExpires*`, and the vault `password` — live in IndexedDB as one `OnedriveAuthFields` record keyed `<vaultRandomID>-onedriveAuth` (`getOnedriveAuthByVault` / `upsertOnedriveAuthByVault` in `localdb.ts`). They are NOT persisted to `data.json`: `saveSettings` calls `extractOnedriveAuth` (→ DB) then `stripOnedriveAuthInPlace` (clears them from the data.json-bound copy). At load, `loadSettings` reads data.json then `mergeOnedriveAuthFromDBOrMigrate` overlays the auth fields back into in-memory `settings.onedrive`. Do not regress this: any new code reading `this.settings.onedrive.refreshToken` (etc.) for EXPORT purposes must remember the live value is the DB-merged one, while data.json on disk is stripped.

## Mandatory pre-push gate

**Any change to `package.json` → `npm install` → `npm run build` → `npm run scan` → then push.** No exceptions, no skipping steps. The lockfile staleness incident (0.6.31) was caused by bumping the version in `package.json` without running `npm install` to sync `package-lock.json`. `npm run scan` (6 checks: ESLint + CSS + deps + lockfile sync + version consistency + installability) must pass with 0 warnings before pushing. See `scripts/obsidian-scan.mjs`.

## CI workflow conventions

- **Node 22 LTS** (not 20 — Node 20 is deprecated on GitHub Actions).
- **`npm ci`** (not `npm install`) — deterministic install from the lockfile.
- **`npm run scan` before `npm run build`** — the CI runs the same 6-check gate as local. If scan fails, the build doesn't proceed.
- The release workflow is `.github/workflows/release.yml`. It triggers on semver tag pushes (`*.*.*`).

## npm `file:` overrides require a companion esbuild `alias`

When using `package.json` `"overrides"` with `"file:./local/stub"` to replace a vulnerable transitive dep, the symlink created by npm works on Windows but **does not reliably resolve on Linux CI** (`npm ci` recreates the lockfile's symlink structure, which may be broken cross-platform). Always add a matching `alias` in `esbuild.config.mjs` to redirect the `require()` at bundle time — this bypasses node_modules resolution entirely and is platform-independent. See `docs/aar/elliptic-stub-dual-mechanism.md`.

## Deploy paths read PLUGIN_ID from manifest.json dynamically

Both `esbuild.config.mjs` (inline `deployPlugin` + `reloadPlugin`) and `scripts/deploy.mjs` derive the plugin folder name from `manifest.json`'s `id` field at runtime, not a hardcoded string. When the plugin id changes, update `manifest.json` — deploy paths + reload id follow automatically. Do not re-introduce a hardcoded `"onedrive-vault-sync"` string in either file.

## The Obsidian scanner checks 3 categories (not just ESLint)

The Obsidian community directory scanner checks: (1) ESLint (TS/JS rules via `eslint-plugin-obsidianmd`), (2) CSS lint (`!important` detection), (3) dependency audit (npm audit on production deps), and (4) lockfile sync (package-lock.json must match package.json). `npm run scan` mirrors all of these locally. If the scanner reports a new category not covered by `npm run scan`, add a check for it.
