# Per-Setting Sync Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Orchestrator note: this feature is small + well-specified; direct inline implementation + verify per task is appropriate.)

**Goal:** Add a cloud/cloud-off icon next to the title of 3 timing settings (auto-run, run-once, sync-on-save) that toggles each field's membership in `syncedSettingFields` (i.e., whether it syncs across devices via the sidecar).

**Architecture:** A reusable `addSyncToggle(setting, fieldName, plugin, t)` UI helper in a new `src/syncToggle.ts` inserts a clickable icon into `setting.nameEl`; click toggles the field in `syncedSettingFields` via a pure `toggleFieldInList` helper (kept in `syncSettings.ts`, unit-tested). The underlying sidecar mechanism (project/apply by `syncedSettingFields`) is already built + tested; this only adds the per-setting UI entry.

**Tech Stack:** TypeScript, esbuild, Obsidian Plugin API (`setIcon`, `Setting.nameEl`), mocha+tsx tests, Biome.

## Global Constraints

- Biome style: 2-space indent, LF, 80-col, double quotes, semicolons, `es5` trailing commas. `any`/non-null assertions ACCEPTED.
- Test (single file): `npx mocha --import=tsx tests/syncSettings.test.ts`
- Typecheck: `npm run typecheck`; Full: `npm test`; Build: `npm run build`
- **Format: PATH-SCOPED `npx @biomejs/biome check --write <files>` ONLY** — never repo-wide `npm run format` (touches PolyForm).
- NEVER read/modify the 5 PolyForm files: `src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts`.
- Repo quirk: amending hook — real commit hash from `git log --oneline -1`, not `git commit` stdout.
- `src/misc.ts` must not depend on internal modules; `fs*.ts` must not import `sync.ts`.

## File Structure

- **Modify** `src/syncSettings.ts` — add pure `toggleFieldInList(list, field): string[]` (keeps array-manipulation out of UI, unit-testable).
- **Modify** `tests/syncSettings.test.ts` — add a test for `toggleFieldInList`.
- **Create** `src/syncToggle.ts` (Apache) — `addSyncToggle(setting, fieldName, plugin, t)` UI helper.
- **Modify** `src/settings.ts` — import `addSyncToggle`; wire it onto the 3 timing Settings.
- **Modify** `src/langs/en.json` + `zh_cn.json` + `zh_tw.json` — add `settings_synctoggle_on` + `settings_synctoggle_off`.
- **Modify** `styles.css` — tiny CSS for the icon (spacing/cursor/state color).

---

### Task 1: Pure `toggleFieldInList` helper + test

**Files:**
- Modify: `src/syncSettings.ts` (append export)
- Test: `tests/syncSettings.test.ts` (append a test)

**Interfaces:**
- Produces: `toggleFieldInList(list: string[], field: string): string[]` — returns a new array with `field` toggled (added if absent, removed if present); does not mutate input.

- [ ] **Step 1: Write the failing test**

Append to `tests/syncSettings.test.ts` — add to the import block at top:
```ts
import { toggleFieldInList } from "../src/syncSettings";
```
Append a new `it` inside the existing `describe("syncSettings projection", ...)`:
```ts
  it("toggleFieldInList adds when absent, removes when present, no mutation", () => {
    const list = ["a", "b"];
    assert.deepEqual(toggleFieldInList(list, "c"), ["a", "b", "c"]);
    assert.deepEqual(toggleFieldInList(list, "a"), ["b"]);
    assert.deepEqual(list, ["a", "b"]); // input not mutated
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --import=tsx tests/syncSettings.test.ts`
Expected: FAIL — `toggleFieldInList` is not exported (not a function).

- [ ] **Step 3: Write minimal implementation**

Append to `src/syncSettings.ts` (after `stripPasswordInPlace`):
```ts
/**
 * Toggle a field's membership in a list: add if absent, remove if present.
 * Returns a NEW array; does not mutate the input. Used by the per-setting
 * sync toggle UI to add/remove a field from syncedSettingFields.
 */
export function toggleFieldInList(
  list: string[],
  field: string
): string[] {
  const cur = new Set(list);
  if (cur.has(field)) {
    cur.delete(field);
  } else {
    cur.add(field);
  }
  return [...cur];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha --import=tsx tests/syncSettings.test.ts`
Expected: PASS (8 tests — the prior 7 + this one).

- [ ] **Step 5: Typecheck + format + commit**

Run: `npm run typecheck` → no errors.
Run: `npx @biomejs/biome check --write src/syncSettings.ts tests/syncSettings.test.ts`
```bash
git add src/syncSettings.ts tests/syncSettings.test.ts
git commit -m "feat: add toggleFieldInList pure helper for per-setting sync toggle"
```

---

### Task 2: `addSyncToggle` UI helper + i18n + wire 3 settings + CSS

**Files:**
- Create: `src/syncToggle.ts`
- Modify: `src/settings.ts` (import + 3 wiring points)
- Modify: `src/langs/en.json`, `src/langs/zh_cn.json`, `src/langs/zh_tw.json`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `toggleFieldInList` (Task 1); `plugin.settings.syncedSettingFields`; `plugin.saveSettings()`.
- Produces: `addSyncToggle(setting, fieldName, plugin, t)` — renders a cloud/cloud-off icon in `setting.nameEl`; click toggles `fieldName` in `syncedSettingFields`.

- [ ] **Step 1: Create `src/syncToggle.ts`**

```ts
// License: Apache-2.0. See LICENSE.
import { setIcon, type Setting } from "obsidian";
import type RemotelySavePlugin from "./main";
import type { TransItemType } from "./i18n";
import { toggleFieldInList } from "./syncSettings";

/**
 * Insert a cloud/cloud-off icon next to the setting's title that toggles
 * whether `fieldName` syncs across devices (membership in
 * syncedSettingFields). ON (in list) → lucide `cloud` (accent); OFF →
 * `cloud-off` (muted). Click toggles + saveSettings + re-renders.
 */
export function addSyncToggle(
  setting: Setting,
  fieldName: string,
  plugin: RemotelySavePlugin,
  t: (k: TransItemType, vars?: any) => string
): void {
  const labelFor = (on: boolean) =>
    on ? t("settings_synctoggle_on") : t("settings_synctoggle_off");

  const iconEl = setting.nameEl.createEl("span", {
    cls: "rs-sync-toggle-icon",
    attr: {
      role: "button",
      tabindex: "0",
      "aria-label": labelFor(
        (plugin.settings.syncedSettingFields ?? []).includes(fieldName)
      ),
      title: labelFor(
        (plugin.settings.syncedSettingFields ?? []).includes(fieldName)
      ),
    },
  });

  const render = () => {
    const on = (plugin.settings.syncedSettingFields ?? []).includes(
      fieldName
    );
    setIcon(iconEl, on ? "cloud" : "cloud-off");
    iconEl.toggleClass("is-on", on);
    iconEl.toggleClass("is-off", !on);
    iconEl.setAttr("aria-label", labelFor(on));
    iconEl.setAttr("title", labelFor(on));
  };

  const click = async () => {
    plugin.settings.syncedSettingFields = toggleFieldInList(
      plugin.settings.syncedSettingFields ?? [],
      fieldName
    );
    await plugin.saveSettings();
    render();
  };

  render();
  iconEl.addEventListener("click", (e) => {
    e.preventDefault();
    void click();
  });
  iconEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void click();
    }
  });
}
```

- [ ] **Step 2: Add i18n keys**

`src/langs/en.json` — find the last key (currently `"conflict_with_remotely_save": "..."`) and append after it (before the closing `}`):
```json
  "settings_synctoggle_on": "Syncing across devices — click to keep local",
  "settings_synctoggle_off": "Local only — click to sync across devices"
```
(Add a trailing comma after the `conflict_with_remotely_save` line.)

`src/langs/zh_cn.json` — append:
```json
  "settings_synctoggle_on": "跨设备同步中，点击改为仅本地",
  "settings_synctoggle_off": "仅本地，点击改为跨设备同步"
```

`src/langs/zh_tw.json` — append:
```json
  "settings_synctoggle_on": "跨裝置同步中，點擊改為僅本地",
  "settings_synctoggle_off": "僅本地，點擊改為跨裝置同步"
```

- [ ] **Step 3: Add CSS to `styles.css`**

Append:
```css
.rs-sync-toggle-icon {
  margin-left: 0.5em;
  cursor: pointer;
  vertical-align: middle;
  display: inline-flex;
}
.rs-sync-toggle-icon.is-on {
  color: var(--text-accent);
}
.rs-sync-toggle-icon.is-off {
  opacity: 0.5;
}
```

- [ ] **Step 4: Wire `addSyncToggle` into the 3 timing settings in `src/settings.ts`**

Add the import near the other `./` imports at the top:
```ts
import { addSyncToggle } from "./syncToggle";
```

For each of the 3 Settings, assign the `new Setting(...)` chain to a `const` and call `addSyncToggle` after. Three edits:

**(a) auto-run** — find `new Setting(containerEl)\n      .setName(t("settings_autorun"))` and change the leading `new Setting(containerEl)` to `const autoRunSetting = new Setting(containerEl)`; then after the `.addDropdown((dropdown) => { ... });` block closes, add:
```ts
    addSyncToggle(autoRunSetting, "autoRunEveryMilliseconds", this.plugin, t);
```

**(b) run-once** — same pattern: `const runOnceSetting = new Setting(containerEl)` for the block starting `.setName(t("settings_runoncestartup"))`; after its `.addDropdown(...)` closes, add:
```ts
    addSyncToggle(runOnceSetting, "initRunAfterMilliseconds", this.plugin, t);
```

**(c) sync-on-save** — `const syncOnSaveSetting = new Setting(containerEl)` for the block starting `.setName(t("settings_synconsave"))`; after its control (`.addText`/`.addDropdown`) closes, add:
```ts
    addSyncToggle(syncOnSaveSetting, "syncOnSaveAfterMilliseconds", this.plugin, t);
```

(If a "find" block doesn't match exactly, STOP and inspect — do not guess-edits. The 3 settings live at `settings.ts:975`, `:1013`, `:1039` per the spec; line numbers may have shifted, so match by the `.setName(t("settings_autorun"))` / `settings_runoncestartup` / `settings_synconsave` anchors.)

- [ ] **Step 5: Typecheck + tests + format**

Run: `npm run typecheck` → no errors.
Run: `npm test` → full suite green (no regression; 8 syncSettings tests pass).
Run: `npx @biomejs/biome check --write src/syncToggle.ts src/settings.ts src/langs/en.json src/langs/zh_cn.json src/langs/zh_tw.json styles.css`

- [ ] **Step 6: Commit**

```bash
git add src/syncToggle.ts src/settings.ts src/langs/en.json src/langs/zh_cn.json src/langs/zh_tw.json styles.css
git commit -m "feat: per-setting cloud/cloud-off sync toggle on 3 timing settings"
```

---

### Task 3: Final validation (build + deploy + manual visual)

**Files:** none (validation only).

- [ ] **Step 1: Full typecheck + tests**

Run: `npm run typecheck` → 0 errors.
Run: `npm test` → all green.

- [ ] **Step 2: Production build + deploy**

Run: `npm run build` → `main.js` produced + deployed to the vault (VAULT_PATH in `.env`, currently the Lab vault). Expected: BUILD=0.

- [ ] **Step 3: Manual visual check (in the deployed vault)**

Reload Obsidian (or toggle the plugin off→on). Open the plugin settings → the 3 timing settings (自动运行 / 启动后自动运行一次 / 保存后同步). Each should show a cloud icon next to its title (ON by default = accent color). Click it → swaps to cloud-off (muted) → that field is removed from `syncedSettingFields` (verify via the debug "Output settings to console" — `syncedSettingFields` no longer lists it). Click again → back to cloud. Verify tooltip on hover.

- [ ] **Step 4: Commit (if any build-artifact or version bump — skip otherwise)**

No code change in this task; nothing to commit unless version bumped.

## Self-Review (run after writing — done inline)

**1. Spec coverage:**
- §4 addSyncToggle helper → Task 2 Step 1 ✓
- §4 applied to 3 timing settings → Task 2 Step 4 ✓
- §5 data flow (toggle → saveSettings → writeSidecar re-project → icon re-render) → Task 1 toggleFieldInList + Task 2 addSyncToggle click handler ✓
- §6 i18n 2 keys × 3 langs → Task 2 Step 2 ✓
- §7 files (syncToggle.ts, settings.ts, 3 langs) → covered; + styles.css (CSS, implied by §4 icon styling) ✓
- §8 testing (toggleFieldInList pure test; UI glue not unit-tested, mechanism already covered) → Task 1 ✓
- §9 edge cases (default all-ON, per-device, no PolyForm) → Global Constraints + Task 2 ✓

**2. Placeholder scan:** no TBD/TODO; all code blocks real; i18n strings written (en/zh_cn/zh_tw); CSS real; wiring described with exact anchors + field names.

**3. Type consistency:** `toggleFieldInList(list: string[], field: string): string[]` (Task 1) matches the call in `addSyncToggle` (Task 2): `toggleFieldInList(plugin.settings.syncedSettingFields ?? [], fieldName)`. `addSyncToggle(setting, fieldName, plugin, t)` signature consistent between Task 2 Step 1 (def) + Step 4 (call sites). Field names `autoRunEveryMilliseconds` / `initRunAfterMilliseconds` / `syncOnSaveAfterMilliseconds` match baseTypes + SYNCABLE_FIELDS.
