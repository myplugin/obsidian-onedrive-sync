# AAR: Settings export QR — blank modal + credential leak

Postmortem of the "设置-高级 导出 空白弹窗" bug and the split redesign, 2026-10-09.

## Symptom

Clicking Settings → Advanced → Export opened a blank modal. Console:

```
Uncaught (in promise) Error: The amount of data is too big to be stored in a QR Code
  at … (qrcode)
  at exportQrCodeUri (importExport.ts)
  at ExportSettingsQrCodeModal.onOpen
```

## Root cause

`exportQrCodeUri` read **`this.plugin.settings`** — the live in-memory settings. At `onload`, `mergeOnedriveAuthFromDBOrMigrate` overlays the OneDrive auth fields (refreshToken, deltaLink, username, …) FROM the IndexedDB auth record INTO `settings.onedrive`. So the "config" payload carried the **real** refreshToken + deltaLink → several KB → exceeded QR capacity → `QRCode.toDataURL` threw → `onOpen` didn't catch it → no modal content rendered (blank).

Two problems in one: (1) too-big → blank modal; (2) the "config" QR was **leaking the OneDrive refresh token** into what should be a shareable preferences blob.

## Key architectural fact that drove the fix

Device secrets (refreshToken, deltaLink, username, accessToken, **password**) are **NOT in `data.json`**. They live in IndexedDB (`OnedriveAuthFields`, `getOnedriveAuthByVault`/`upsertOnedriveAuthByVault` in `localdb.ts`). `saveSettings` does `extractOnedriveAuth` (→ DB) THEN `stripOnedriveAuthInPlace` (clears them from the data.json-bound copy). Rationale (comment at `localdb.ts:674`): keep device secrets out of the synced config file to prevent config-dir-sync ping-pong and cross-device secret leakage. **`data.json` is already credential-free.**

So the export's mistake was reading the live (post-merge) settings instead of respecting the storage separation: it pulled creds back INTO a "config" payload that storage had carefully kept apart.

## Fix: split export by storage source

Two QRs, each reading the right store:

- **Config QR** (`func=settings`) — clone settings, run `stripOnedriveAuthInPlace` on the onedrive copy + clear `password` (= the data.json shape). Credential-free by construction. ~1.4 KB, fits QR-L. Share-safe.
- **Credentials QR** (`func=onedrive_auth`) — read the IndexedDB auth record via `getOnedriveAuthByVault`; curate to `{refreshToken, password, username, credentialsShouldBeDeletedAtTime, clientID, authority}`. **Drop** `deltaLink` (per-device cursor — must not transfer) and `accessToken` (short-lived — useless to transfer).

QR rendered at ECC level **L** (max capacity); if it still doesn't fit, the modal shows a "too big" message + copy-URI button (fallback).

## Import: route by `func`, no deep merge needed

Single method `applyImportedUriParams(inputParams)` (shared by the `obsidian://` protocol handler and the settings-tab text paste) dispatches on `func`:

- `func=settings` (config): `Object.assign({}, this.settings, copied)` → **`await mergeOnedriveAuthFromDBOrMigrate()`** → `saveSettings()`. The re-merge restores the target's real auth from the DB BEFORE saveSettings, so the stripped placeholders (`refreshToken:""`, `password:""`) don't get extracted-and-written back as empty (which would clobber the target's login in the DB).
- `func=onedrive_auth` (credentials): read the target's existing DB auth record, **merge** the imported fields into it (preserving the target's `accessToken`/`deltaLink`/`accessTokenExpires*` — only `refreshToken`/`password`/`username`/`credentialsShouldBeDeletedAtTime`/`clientID`/`authority` come from the import), `upsertOnedriveAuthByVault`, `mergeOnedriveAuthFromDB`, `saveSettings`. `clientID`/`authority` land in data.json; the rest stay in the DB (stripped from data.json as usual).

## The shallow-merge clobber gotcha (avoided)

`this.settings = Object.assign({}, this.settings, {onedrive: {...}})` is a SHALLOW merge — it REPLACES the entire `onedrive` object. So importing a PARTIAL onedrive (e.g. a credentials payload nested as `{onedrive:{refreshToken:…}}`) would wipe the target's `clientID`/`authority`/`emptyFile`. Same hazard for a config QR whose stripped `onedrive` (`refreshToken:""`) would overwrite the target's in-memory refreshToken. The fix avoids deep-merge entirely by **routing each import to the right store** (config → settings + re-merge-auth; credentials → DB record merge) rather than nesting partial onedrive objects.

## Schema-version gate

Added `CONFIG_SCHEMA_VERSION` (independent of plugin release version). URI carries `sv=<n>`. Import rejects on mismatch. See `docs/CONVENTIONS.md` for the bump rules. This is what makes default-stripping (if ever added) safe across same-schema versions.

## Lesson

When a feature exports/transfers settings, read from the store that the architecture actually uses for each field — don't blindly serialize the live in-memory object, which may carry secrets that storage deliberately keeps elsewhere. "The config file is already credential-free" was the key insight: the export should have honored that separation instead of re-merging secrets back in.
