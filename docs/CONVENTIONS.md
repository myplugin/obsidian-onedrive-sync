# Project Conventions — onedrive-sync

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

Any build/deploy step that shells out to an external tool — e.g. the `obsidian` CLI (`obsidian plugin:reload id=onedrive-sync`) invoked from the deploy hooks — must degrade **gracefully**: warn-only on absence/failure, never throw or exit non-zero. CI and headless builds (where the tool/Obsidian isn't present) must stay green. Use `spawnSync(..., { shell: true })` (handles Windows `.cmd` shims) and treat any `error`/non-zero `status` as a soft skip.

## Keep both deploy paths in sync

The project has two deploy paths — the inline `deployPlugin` `onEnd` in `esbuild.config.mjs` (build/watch-coupled, gated on `VAULT_PATH`) and `scripts/deploy.mjs` (standalone `npm run deploy`, vault auto-discovery). They intentionally don't share a helper. Any deploy-affecting change (files copied, the post-deploy `reloadPlugin` step, path logic) must be applied to **both**. Do not couple the esbuild plugin to `scripts/deploy.mjs` — its `process.exit`/auto-discovery semantics don't belong inside `onEnd`.

## parent-id-chain fallback (delta id-walk)

When `parentReference.path` is missing for a non-root delta item (the documented Graph delta shape — "track items by id"), resolve the vault-relative key by walking `parentReference.id` upward instead of throwing:

- `deriveKeyFromParentChain(x, lookupMap, approotRootId, remoteBaseDir)` + `fromDriveItemToEntityWithChainFallback(...)` in `src/driveItemConvert.ts` are PURE — same purity rule as the rest of the converter family (`lookupMap` + `approotRootId` injected via params, no I/O). `fromDriveItemToEntityWithIdFallback` is kept (test-only surface now) — do NOT delete unless its tests migrate to the chain variant.
- Resolution tiers: own-id in `lookupMap` (modify case, reuse `keyRaw` verbatim) → baseline `parentReference.id === approotRootId` (`name(+"/")`) → chain `parentKey+name(+"/")` (`parentKey=="/"` degrades to baseline, never `//`) → else throw `ONEDRIVE_PATH_MISSING` → skip + deltaLink self-heal.
- `approotRootId` is captured in `FakeFsOnedrive._init()` from the `/drive/special/approot/children` filter hit (`x.name === remoteBaseDir`); stable per-instance, populated on the first `_init()` of each session. Gracefully degrades to `undefined` (baseline branch never matches → self-heal) if capture is missed.
- `classifyDeltaItems` takes a shared `lookupMap` (4th param; prev `idToKeyMap` ∪ `{approotRootId→"/"}`) and mutates it IN-PLACE across a two-pass rescan (each resolved item seeds `id→keyRaw` for in-batch parent-child chains, order-independent). The caller MUST pass a FRESH COPY (`new Map(idToKeyMap)`) so `prevRemoteEntities` is never mutated. The 5th param `approotRootId?` documents caller intent; the actual fallback is performed by the closure-bound converter (same pattern as the 4th param).
