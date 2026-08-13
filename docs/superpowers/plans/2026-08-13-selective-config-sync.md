# Selective Config Sync (Sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync user-selected plugin config items across devices via a plain-JSON sidecar file, while keeping `data.json` obfuscated and local-only (never synced), and moving the encryption `password` into the device-local DB alongside the existing onedrive auth.

**Architecture:** Add `synced_settings.json` (plain multi-line JSON projection of selected fields) as the sync unit; remove `data.json` from the sync whitelist. Strip `password` into the existing `OnedriveAuthFields` DB record (mirroring the existing auth→DB pattern). Reconcile the sidecar back into in-memory settings on `SYNC_DONE` so the running plugin never goes stale (design-level fix for the original clobber bug). No changes to `sync.ts`/`conflictLogic.ts`/`fileContentHistory.ts`/`clearDupFiles.ts`/`settingsClearDupFiles.ts` (PolyForm, clean-room off-limits).

**Tech Stack:** TypeScript, esbuild, mocha + tsx tests, Obsidian Plugin API, localforage (DB), Biome (format).

## Global Constraints

- Never read or modify the 5 PolyForm files: `src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts`.
- Biome style: 2-space indent, LF, 80-col, double quotes, semicolons, `es5` trailing commas. `any` and non-null assertions are accepted.
- Test command (single file): `npx mocha --import=tsx tests/<file>.test.ts`
- Typecheck: `npm run typecheck` (`tsc -noEmit -skipLibCheck`)
- Full test: `npm test`
- Build: `npm run build`
- Folders end with `/`. `src/misc.ts` must not depend on internal modules. `fs*.ts` must not import `sync.ts`.
- Versioning: keep `package.json`, `manifest.json`, `manifest-beta.json` in sync if version touched (this feature may bump version in a final task).

## File Structure

- **Create** `src/syncSettings.ts` (Apache) — pure functions: `SYNCABLE_FIELDS`, `DEFAULT_SYNCED_FIELDS`, `projectSyncableFields`, `applySyncedFields`, `stripPasswordInPlace`. One responsibility: the sidecar projection + secret-strip helpers. No internal imports beyond `baseTypes`.
- **Create** `tests/syncSettings.test.ts` — mocha+tsx unit tests for the pure module.
- **Modify** `src/localdb.ts:658-666` — add `password: string` to `OnedriveAuthFields`. (get/upsert at `:668/677` are generic, no change.)
- **Modify** `src/main.ts` — `extractOnedriveAuth` (`:929`), `mergeOnedriveAuthFromDB` (`:942`), `saveSettings` (`:996-1023`), `loadSettings` (`:825-925`), DEFAULT_SETTINGS (`:~70-95`), onload SYNC_DONE listener registration (new), add `writeSidecar`/`readSidecar`/`_reconcileSidecar` methods.
- **Modify** `src/obsFolderLister.ts:18-32` — `isLikelyPluginSubFiles`: remove `data.json`, add `synced_settings.json`.
- **Modify** `src/baseTypes.ts:56-111` — add `syncedSettingFields?: string[]` to `RemotelySavePluginSettings`.
- **Modify** `src/settings.ts` — add "同步的配置项" toggle UI + wire `syncedSettingFields`.
- **Modify** `tests/configPersist.test.ts` — add a regression test that obfuscated data.json carries no password once stripped.

---

### Task 1: Pure sidecar projection module (`src/syncSettings.ts`)

**Files:**
- Create: `src/syncSettings.ts`
- Test: `tests/syncSettings.test.ts`

**Interfaces:**
- Produces: `SYNCABLE_FIELDS` (`readonly string[]`), `DEFAULT_SYNCED_FIELDS` (`string[]`), `projectSyncableFields(settings, fields): Partial<RemotelySavePluginSettings>`, `applySyncedFields(settings, partial, fields): RemotelySavePluginSettings`, `stripPasswordInPlace(copy): void`.

- [ ] **Step 1: Write the failing test**

`tests/syncSettings.test.ts`:
```ts
import { strict as assert } from "assert";
import type { RemotelySavePluginSettings } from "../src/baseTypes";
import {
  SYNCABLE_FIELDS,
  DEFAULT_SYNCED_FIELDS,
  projectSyncableFields,
  applySyncedFields,
  stripPasswordInPlace,
} from "../src/syncSettings";

const baseSettings = (): RemotelySavePluginSettings =>
  ({
    onedrive: { username: "u" } as any,
    password: "secret",
    serviceType: "onedrive",
    ignorePaths: ["myregex"],
    conflictAction: "smart_conflict",
    enableMobileStatusBar: true,
    currLogLevel: "info",
  } as any);

describe("syncSettings projection", () => {
  it("projects only the selected fields", () => {
    const projected = projectSyncableFields(baseSettings(), [
      "ignorePaths",
      "conflictAction",
    ]);
    assert.deepEqual(projected, {
      ignorePaths: ["myregex"],
      conflictAction: "smart_conflict",
    });
  });

  it("never projects password or onedrive even if mis-selected", () => {
    const projected = projectSyncableFields(baseSettings(), [
      "ignorePaths",
      "password",
      "onedrive",
    ] as any);
    assert.deepEqual(projected, { ignorePaths: ["myregex"] });
  });

  it("applySyncedFields touches only selected fields", () => {
    const local = baseSettings();
    local.ignorePaths = [];
    const partial = {
      ignorePaths: ["syncedregex"],
      conflictAction: "keep_newer",
    } as any;
    const merged = applySyncedFields(local, partial, ["ignorePaths"]);
    assert.deepEqual(merged.ignorePaths, ["syncedregex"]);
    assert.equal(merged.conflictAction, "smart_conflict");
  });

  it("apply then project is idempotent over the default field set", () => {
    const s = baseSettings();
    const partial = projectSyncableFields(s, DEFAULT_SYNCED_FIELDS);
    const merged = applySyncedFields(
      { ...s },
      partial,
      DEFAULT_SYNCED_FIELDS
    );
    const reprojected = projectSyncableFields(merged, DEFAULT_SYNCED_FIELDS);
    assert.deepEqual(reprojected, partial);
  });

  it("ignores unknown keys in the downloaded partial", () => {
    const s = baseSettings();
    const partial = {
      ignorePaths: ["x"],
      futureUnknownField: 123,
    } as any;
    const merged = applySyncedFields(s, partial, ["ignorePaths"]);
    assert.deepEqual(merged.ignorePaths, ["x"]);
    assert.equal((merged as any).futureUnknownField, undefined);
  });

  it("stripPasswordInPlace empties only password", () => {
    const s: any = {
      password: "secret",
      ignorePaths: ["x"],
      conflictAction: "smart_conflict",
    };
    stripPasswordInPlace(s);
    assert.equal(s.password, "");
    assert.deepEqual(s.ignorePaths, ["x"]);
    assert.equal(s.conflictAction, "smart_conflict");
  });

  it("SYNCABLE_FIELDS excludes password, onedrive, and device-level fields", () => {
    assert.ok(!SYNCABLE_FIELDS.includes("password" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("onedrive" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("enableMobileStatusBar" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("currLogLevel" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("obfuscateSettingFile" as any));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --import=tsx tests/syncSettings.test.ts`
Expected: FAIL — module `../src/syncSettings` not found.

- [ ] **Step 3: Write minimal implementation**

`src/syncSettings.ts`:
```ts
// License: Apache-2.0. See LICENSE.
import type { RemotelySavePluginSettings } from "./baseTypes";

/**
 * Catalog of settings fields eligible for cross-device sync via the
 * synced_settings.json sidecar. Device-specific fields
 * (enableMobileStatusBar, currLogLevel, disclaimerAcknowledged,
 * obfuscateSettingFile, enableStatusBarInfo) are intentionally NOT selectable
 * — they stay per-device. password and onedrive auth live in the device-local
 * DB and are never synced.
 */
export const SYNCABLE_FIELDS = [
  "ignorePaths",
  "onlyAllowPaths",
  "conflictAction",
  "syncConfigDir",
  "syncBookmarks",
  "syncAppearance",
  "syncUnderscoreItems",
  "lang",
  "concurrency",
  "skipSizeLargerThan",
  "protectModifyPercentage",
  "syncDirection",
  "deleteToWhere",
  "encryptionMethod",
  "autoRunEveryMilliseconds",
  "initRunAfterMilliseconds",
  "syncOnSaveAfterMilliseconds",
] as const;

/** Default selection: every catalog field is synced unless the user opts out. */
export const DEFAULT_SYNCED_FIELDS: string[] = [...SYNCABLE_FIELDS];

const SYNCABLE_SET: Set<string> = new Set(SYNCABLE_FIELDS);

/**
 * Project the user-selected syncable fields out of the full settings into a
 * plain object for the sidecar. Only fields that are (a) in the user's
 * selection AND (b) in the SYNCABLE_FIELDS catalog are included — the safety
 * rail that keeps password/onedrive/device fields out even if mis-selected.
 */
export function projectSyncableFields(
  settings: RemotelySavePluginSettings,
  fields: string[]
): Partial<RemotelySavePluginSettings> {
  const out: Partial<RemotelySavePluginSettings> = {};
  for (const f of fields) {
    if (!SYNCABLE_SET.has(f)) continue;
    if (f in settings) {
      (out as any)[f] = (settings as any)[f];
    }
  }
  return out;
}

/**
 * Merge a downloaded sidecar partial into settings, touching ONLY the user's
 * selected syncable fields. Non-selected fields are untouched; unknown keys in
 * `partial` are ignored (forward/back compat). Mutates and returns `settings`.
 */
export function applySyncedFields(
  settings: RemotelySavePluginSettings,
  partial: Partial<RemotelySavePluginSettings>,
  fields: string[]
): RemotelySavePluginSettings {
  for (const f of fields) {
    if (!SYNCABLE_SET.has(f)) continue;
    if (f in partial) {
      (settings as any)[f] = (partial as any)[f];
    }
  }
  return settings;
}

/**
 * Strip the encryption password from a settings copy before it is written to
 * data.json. password lives in the device-local DB (like onedrive auth), so it
 * must never appear in the synced/obfuscated data.json. Mutates in place.
 */
export function stripPasswordInPlace(
  copy: RemotelySavePluginSettings
): void {
  copy.password = "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha --import=tsx tests/syncSettings.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/syncSettings.ts tests/syncSettings.test.ts
git commit -m "feat: add syncSettings pure module for sidecar projection + password strip"
```

---

### Task 2: Move `password` into the device-local DB

**Files:**
- Modify: `src/localdb.ts:658-666` (interface), `src/main.ts:929-952,980-1023,825-925`
- Test: `tests/configPersist.test.ts`

**Interfaces:**
- Consumes: `stripPasswordInPlace` (Task 1).
- Produces: `OnedriveAuthFields` now carries `password: string`; `extractOnedriveAuth`/`mergeOnedriveAuthFromDB` handle password; `saveSettings` strips password before obfuscating; `loadSettings` merges password from DB.

- [ ] **Step 1: Write the failing test**

Append to `tests/configPersist.test.ts` (add import `stripPasswordInPlace` at top):
```ts
import { stripPasswordInPlace } from "../src/syncSettings";
```
Append a new `it` inside the existing `describe`:
```ts
  it("obfuscated data.json carries no password after stripPasswordInPlace", () => {
    const k = { ...DEFAULT_SETTINGS, password: "supersecret" };
    stripPasswordInPlace(k as any);
    const messy = normalConfigToMessy(k);
    const blob = JSON.stringify(messy);
    assert.ok(
      !blob.includes("supersecret"),
      "password leaked into the obfuscated data.json blob"
    );
    assert.equal((messyConfigToNormal(messy) as any).password, "");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --import=tsx tests/configPersist.test.ts`
Expected: FAIL — `stripPasswordInPlace` import resolves (Task 1) but the assertion holds only after the strip helper exists; it passes already because Task 1 made `stripPasswordInPlace` work. **Re-evaluate:** this test actually passes once Task 1 is in. To make it a meaningful regression for Task 2's *wiring*, keep it as a guard that the strip helper does its job (it will go green after Task 1). The Task 2 wiring (saveSettings calling it) is integration-level; verify via typecheck + the manual integration test in Task 7.

- [ ] **Step 3: Extend `OnedriveAuthFields`**

`src/localdb.ts:658-666` — add `password` field and update the doc comment:
```ts
/**
 * Device-specific secrets stored in the DB (NOT in synced data.json): the
 * onedrive auth tokens AND the vault encryption password. Each device holds
 * its own; keeping these out of data.json prevents the config-dir sync
 * ping-pong and avoids leaking one device's secrets to the other.
 */
export interface OnedriveAuthFields {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  password: string;
}
```

- [ ] **Step 4: Thread password through extract/merge**

`src/main.ts` `extractOnedriveAuth` (~`:929-940`) — add `password: o.password,` to the returned object (after the existing fields, before the closing brace):
```ts
  private extractOnedriveAuth(): OnedriveAuthFields {
    const o = this.settings.onedrive;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      accessTokenExpiresInSeconds: o.accessTokenExpiresInSeconds,
      accessTokenExpiresAtTime: o.accessTokenExpiresAtTime,
      deltaLink: o.deltaLink,
      username: o.username,
      credentialsShouldBeDeletedAtTime: o.credentialsShouldBeDeletedAtTime,
      password: this.settings.password,
    };
  }
```

`src/main.ts` `mergeOnedriveAuthFromDB` (~`:942-952`) — append (use `??` so a pre-migration DB record lacking `password` does NOT wipe the value loaded from data.json):
```ts
  private mergeOnedriveAuthFromDB(auth: OnedriveAuthFields) {
    const o = this.settings.onedrive;
    o.accessToken = auth.accessToken;
    o.refreshToken = auth.refreshToken;
    o.accessTokenExpiresInSeconds = auth.accessTokenExpiresInSeconds;
    o.accessTokenExpiresAtTime = auth.accessTokenExpiresAtTime;
    o.deltaLink = auth.deltaLink;
    o.username = auth.username;
    o.credentialsShouldBeDeletedAtTime = auth.credentialsShouldBeDeletedAtTime;
    // Guard: old DB records (pre-password-migration) lack this field; keep the
    // value loaded from data.json until the first saveSettings persists it.
    this.settings.password = auth.password ?? this.settings.password;
  }
```

- [ ] **Step 5: Strip password in saveSettings**

`src/main.ts` `saveSettings` (~`:1010-1013`) — after `stripOnedriveAuthInPlace(settingsCopy.onedrive);`, also strip the password:
```ts
    const settingsCopy = dbReady ? cloneDeep(this.settings) : this.settings;
    if (dbReady) {
      this.stripOnedriveAuthInPlace(settingsCopy.onedrive);
      stripPasswordInPlace(settingsCopy);
    }
```
Add the import at the top of `src/main.ts` (near the other `./` imports):
```ts
import { stripPasswordInPlace } from "./syncSettings";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx mocha --import=tsx tests/configPersist.test.ts tests/syncSettings.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/localdb.ts src/main.ts tests/configPersist.test.ts
git commit -m "feat: move encryption password into device-local DB (mirror onedrive auth)"
```

---

### Task 3: Sidecar read/write + wire into save/load

**Files:**
- Modify: `src/main.ts` — add `writeSidecar`/`readSidecar` methods; call from `saveSettings` and `loadSettings`.

**Interfaces:**
- Consumes: `projectSyncableFields`, `applySyncedFields` (Task 1); `syncedSettingFields` (added to settings in Task 6, but guarded with `??` here so Task 3 lands first).
- Produces: sidecar file `${manifest.dir}/synced_settings.json` written on save, read on load + reconcile.

- [ ] **Step 1: Add the sidecar path helper + read/write methods**

In `src/main.ts`, add a constant near the top (after imports):
```ts
const SIDECAR_NAME = "synced_settings.json";
```
Add two methods on the plugin class (place near `saveSettings`/`loadSettings`, e.g. after `tryToAddIgnoreFile`):
```ts
  private sidecarPath(): string {
    // manifest.dir is the plugin folder, e.g. ".obsidian/plugins/remotely-save-onedrive"
    return `${this.manifest.dir}/${SIDECAR_NAME}`;
  }

  /** Pretty-printed projection of selected fields; null if nothing selected. */
  private buildSidecarText(): string | null {
    const fields = this.settings.syncedSettingFields ?? [];
    if (fields.length === 0) return null;
    const projected = projectSyncableFields(this.settings, fields);
    return JSON.stringify(projected, null, 2);
  }

  /** Write the sidecar only when content changed (diff guard — no spurious
   *  mtime bump, no ping-pong). No-op if no fields selected. */
  async writeSidecar() {
    const newText = this.buildSidecarText();
    const p = this.sidecarPath();
    const exists = await this.app.vault.adapter.exists(p);
    if (newText === null) {
      if (exists) await this.app.vault.adapter.remove(p);
      return;
    }
    if (exists) {
      const oldText = await this.app.vault.adapter.read(p);
      if (oldText === newText) return; // diff guard: no change, no write
    }
    await this.app.vault.adapter.write(p, newText);
  }

  /** Read + parse the sidecar. null if missing/corrupt. Never throws. */
  async readSidecar(): Promise<Partial<RemotelySavePluginSettings> | null> {
    const p = this.sidecarPath();
    try {
      const exists = await this.app.vault.adapter.exists(p);
      if (!exists) return null;
      const text = await this.app.vault.adapter.read(p);
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Partial<RemotelySavePluginSettings>;
    } catch (e) {
      console.warn("synced_settings.json unreadable, skipping reconcile", e);
      return null;
    }
  }
```
Add the import at top of `src/main.ts`:
```ts
import { applySyncedFields, projectSyncableFields } from "./syncSettings";
```

- [ ] **Step 2: Call writeSidecar from saveSettings**

In `src/main.ts` `saveSettings` (~`:996-1023`), add a call after the `saveData` block (after the `if (JSON.stringify(...) !== ...) { await this.saveData(...); }`):
```ts
    // project selected fields into the plain-JSON sidecar (sync unit)
    await this.writeSidecar();
  }
```
Note: `writeSidecar` reads on-disk sidecar for the diff, so it must run after `saveData` to keep ordering simple; it does not touch data.json.

- [ ] **Step 3: Call readSidecar from loadSettings**

In `src/main.ts` `loadSettings` (~`:825-830`), after the `messyConfigToNormal` + DB merge, reconcile the sidecar:
```ts
  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );
    await this.mergeOnedriveAuthFromDBOrMigrate();
    // sidecar (cross-device) values win for the user-selected fields
    const sidecar = await this.readSidecar();
    if (sidecar !== null) {
      applySyncedFields(
        this.settings,
        sidecar,
        this.settings.syncedSettingFields ?? []
      );
    }
    // ... existing defaulting `if (...) { ... }` block continues unchanged
```
(Insert the `mergeOnedriveAuthFromDBOrMigrate` + sidecar block right after the `Object.assign`, before the existing `if (this.settings.syncBookmarks === undefined)` defaults. If `mergeOnedriveAuthFromDBOrMigrate` is currently called elsewhere in onload, leave that call; calling it twice is idempotent. Otherwise add it here as shown.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: write/read synced_settings.json sidecar in save/load"
```

---

### Task 4: Reconcile sidecar on SYNC_DONE (clobber-proof)

**Files:**
- Modify: `src/main.ts` — add `_reconcileSidecar` method + register on `SYNC_DONE` in `onload`.

**Interfaces:**
- Consumes: `readSidecar`, `applySyncedFields`, `saveSettings` (Task 3).

- [ ] **Step 1: Add the reconcile handler**

In `src/main.ts`, add the method on the plugin class:
```ts
  /** Re-read the sidecar (possibly just downloaded/merged) into in-memory
   *  settings + persist to data.json. This is the design-level fix for the
   *  original clobber bug: after every sync the plugin's memory tracks the
   *  synced sidecar, so a later saveSettings can never write stale values over
   *  a freshly-pulled config. Swallows all errors — must never break the sync
   *  chain. */
  _reconcileSidecar = async () => {
    try {
      const sidecar = await this.readSidecar();
      if (sidecar === null) return;
      const fields = this.settings.syncedSettingFields ?? [];
      if (fields.length === 0) return;
      applySyncedFields(this.settings, sidecar, fields);
      await this.saveSettings(); // persist to data.json; writeSidecar diff=no-op
    } catch (e) {
      console.warn("sidecar reconcile failed", e);
    }
  };
```

- [ ] **Step 2: Register the listener in onload**

In `src/main.ts` `onload`, inside `this.app.workspace.onLayoutReady(() => { ... })` (or wherever SYNC_DONE registration fits, mirroring `toggleSyncOnSaveIfSet` at `:1225-1229`), add:
```ts
      this.registerEvent(
        this.syncEvent?.on("SYNC_DONE", this._reconcileSidecar)!
      );
```
Place it unconditionally (not gated on `syncOnSaveAfterMilliseconds`). Ensure `this.syncEvent` is initialised before this point (it is — `main.ts:486` `this.syncEvent = new Events()` runs early in onload).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: reconcile synced_settings.json sidecar on SYNC_DONE (clobber-proof)"
```

---

### Task 5: Swap the sync whitelist (`data.json` out, sidecar in)

**Files:**
- Modify: `src/obsFolderLister.ts:18-32`

**Interfaces:**
- Produces: the plugin folder now syncs `synced_settings.json` (plain, mergeable) instead of `data.json` (obfuscated, unmergegable).

- [ ] **Step 1: Update `isLikelyPluginSubFiles`**

`src/obsFolderLister.ts:18-32`:
```ts
const isLikelyPluginSubFiles = (x: string) => {
  const reqFiles = [
    "main.js",
    "manifest.json",
    ".gitignore",
    "styles.css",
    "synced_settings.json",
  ];
  for (const iterator of reqFiles) {
    if (x === iterator || x.endsWith(`/${iterator}`)) {
      return true;
    }
  }
  return false;
};
```
(`data.json` removed from the list — it is now local-only.)

- [ ] **Step 2: Typecheck + existing tests**

Run: `npm run typecheck`
Expected: no errors.
Run: `npx mocha --import=tsx tests/sync.test.ts`
Expected: PASS (the clean-room skipFilter tests don't depend on this whitelist).

- [ ] **Step 3: Commit**

```bash
git add src/obsFolderLister.ts
git commit -m "feat: sync synced_settings.json instead of data.json in plugin folder"
```

---

### Task 6: `syncedSettingFields` setting + settings UI

**Files:**
- Modify: `src/baseTypes.ts:56-111`, `src/main.ts` (DEFAULT_SETTINGS + loadSettings default), `src/settings.ts`

**Interfaces:**
- Consumes: `SYNCABLE_FIELDS`, `DEFAULT_SYNCED_FIELDS` (Task 1).

- [ ] **Step 1: Add the field to the settings type**

`src/baseTypes.ts` `RemotelySavePluginSettings` (after `obfuscateSettingFile?: boolean;` ~`:84`):
```ts
  /** Which settings fields sync across devices via synced_settings.json.
   *  Per-device (not itself synced). Undefined → DEFAULT_SYNCED_FIELDS. */
  syncedSettingFields?: string[];
```

- [ ] **Step 2: Default + load guard in main.ts**

`src/main.ts` DEFAULT_SETTINGS object (~`:70-95`) — add:
```ts
  syncedSettingFields: [...DEFAULT_SYNCED_FIELDS],
```
Add the import at top:
```ts
import { DEFAULT_SYNCED_FIELDS } from "./syncSettings";
```
In `loadSettings` defaults block, add (near the other `if (... === undefined)` lines):
```ts
    if (this.settings.syncedSettingFields === undefined) {
      this.settings.syncedSettingFields = [...DEFAULT_SYNCED_FIELDS];
    }
```

- [ ] **Step 3: Settings UI toggle list**

In `src/settings.ts`, add a new Setting in the appropriate section (e.g., near the regex `ignorePaths` setting ~`:1071`). Import at top:
```ts
import { SYNCABLE_FIELDS } from "./syncSettings";
```
Render a toggle per catalog field:
```ts
    new Setting(containerEl)
      .setName(t("settings_syncedsettingfields"))
      .setDesc(t("settings_syncedsettingfields_desc"));
    for (const field of SYNCABLE_FIELDS) {
      new Setting(containerEl)
        .setName(field)
        .addToggle((toggle) => {
          const selected =
            this.plugin.settings.syncedSettingFields?.includes(field) ?? true;
          toggle.setValue(selected);
          toggle.onChange(async (val) => {
            const cur = new Set(
              this.plugin.settings.syncedSettingFields ?? [
                ...SYNCABLE_FIELDS,
              ]
            );
            if (val) cur.add(field);
            else cur.delete(field);
            this.plugin.settings.syncedSettingFields = [...cur];
            await this.plugin.saveSettings();
          });
        });
    }
```
Add i18n keys to `src/langs/en.json`, `zh_cn.json`, `zh_tw.json`:
```json
  "settings_syncedsettingfields": "Synced config items",
  "settings_syncedsettingfields_desc": "Pick which settings travel across devices via synced_settings.json. Device-specific items (mobile status bar, log level, obfuscate toggle) always stay per-device. Sensitive items (password, onedrive auth) are never synced."
```
(zh_cn / zh_tw translations analogous — translate the two strings.)

- [ ] **Step 4: Typecheck + format**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run format`
Expected: Biome applies style; no semantic change.

- [ ] **Step 5: Commit**

```bash
git add src/baseTypes.ts src/main.ts src/settings.ts src/langs/en.json src/langs/zh_cn.json src/langs/zh_tw.json
git commit -m "feat: syncedSettingFields setting + per-field sync toggle UI"
```

---

### Task 7: Final validation (typecheck + tests + build + manual)

**Files:** none (validation only).

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (existing tests + new syncSettings + extended configPersist).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: `main.js` produced, no errors.

- [ ] **Step 4: Manual integration test (the original failing case)**

On desktop (obfuscation ON, conflictAction=smart_conflict, syncConfigDir ON):
1. Add an `ignorePaths` regex.
2. Sync.
3. On the phone: sync, then restart the plugin.
4. Verify the regex appears in the phone's settings.
5. Repeat 3x — verify it's stable (not intermittent).
Expected: regex reliably present (was intermittent/broken before this change).

- [ ] **Step 5: Verify data.json no longer carries the password**

On desktop, decode `data.json` (via the existing "Output settings to console" debug button at `settings.ts:1576`, or by reading the obfuscated blob). Confirm the `password` field is empty (it now lives in the device DB).
Expected: `password: ""` in data.json.

- [ ] **Step 6: Verify the sidecar exists and is plain JSON**

Confirm `.obsidian/plugins/<id>/synced_settings.json` exists and is readable plain JSON containing the selected fields (and NOT password/onedrive auth).
Expected: plain JSON, selected fields only.

- [ ] **Step 7: (Optional) version bump + commit**

If releasing: bump `package.json`, `manifest.json`, `manifest-beta.json` in sync; commit:
```bash
git add package.json manifest.json manifest-beta.json
git commit -m "build: bump version for selective config sync"
```

## Self-Review (run after writing — done inline)

**1. Spec coverage:**
- §6.1 password→DB → Task 2 ✓
- §6.2 syncSettings pure module → Task 1 ✓
- §6.3 sidecar read/write + diff guard → Task 3 ✓ (`writeSidecar` diff guard present)
- §6.4 SYNC_DONE reconcile → Task 4 ✓
- §6.5 whitelist swap → Task 5 ✓
- §6.6 settings UI + syncedSettingFields → Task 6 ✓
- §8 error handling (corrupt sidecar, missing sidecar, unknown fields) → Task 3 `readSidecar` try/catch + Task 1 `applySyncedFields` ignores unknown + SYNCABLE_SET guard ✓
- §9 migration (password from old data.json → DB) → Task 2 `mergeOnedriveAuthFromDB` `??` guard + first saveSettings migrates ✓
- §11 tests → Task 1 (unit) + Task 2 (configPersist extension) + Task 7 (integration) ✓
- §12 risks (writeSidecar diff guard, reconcile recursion) → Task 3 diff guard + Task 4 reconcile→saveSettings→writeSidecar diff no-op ✓

**2. Placeholder scan:** no TBD/TODO; all code blocks contain real code; field lists are concrete.

**3. Type consistency:** `SYNCABLE_FIELDS`/`DEFAULT_SYNCED_FIELDS`/`projectSyncableFields`/`applySyncedFields`/`stripPasswordInPlace` names match across Tasks 1–4. `OnedriveAuthFields.password` added in Task 2 and consumed by `extractOnedriveAuth`/`mergeOnedriveAuthFromDB`. `syncedSettingFields` name consistent in baseTypes/main/settings. `SIDECAR_NAME`/`sidecarPath`/`writeSidecar`/`readSidecar`/`_reconcileSidecar` consistent.

**4. Ambiguity:** `mergeOnedriveAuthFromDBOrMigrate` call placement in Task 3 Step 3 noted as idempotent-if-duplicated — acceptable. Manual test in Task 7 is the final black-box gate.
