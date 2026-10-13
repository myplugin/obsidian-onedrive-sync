# .obsidian 目录细粒度同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `syncConfigDir` toggle with five independent toggles for fine-grained control over `.obsidian` directory sync.

**Architecture:** Modify the skip filter (`skipFilter.ts` + `sync.ts`) to route `.obsidian` files through five independent toggle checks instead of one blanket `syncConfigDir` switch. Modify `obsFolderLister.ts` to selectively enumerate only the relevant `.obsidian` subdirectories based on which toggles are on. Update `fsLocal.ts`, `settings.ts`, `main.ts`, `syncSettings.ts`, `settingsClearDupFiles.ts`, and i18n files accordingly.

**Tech Stack:** TypeScript, esbuild, mocha + tsx, Obsidian Plugin API

**Spec:** `docs/superpowers/specs/2026-09-16-obsidian-config-sync-design.md`

## Global Constraints

- Biome style: 2-space indent, LF, 80-col width, double quotes, semicolons, es5 trailing commas. `any` and non-null assertions accepted.
- `src/misc.ts` must not depend on any other internal module.
- Storage modules (`fs*.ts`) must not import `sync.ts`.
- Folders are always represented by strings ending with `/`.
- Versioning: keep `package.json`, `manifest.json`, `manifest-beta.json` versions in sync.
- Test runner: `npx mocha --import=tsx "tests/**/*.ts"`
- Typecheck: `npm run typecheck`

---

### Task 1: Add new settings fields and defaults

**Files:**
- Modify: `src/baseTypes.ts:67-71`
- Modify: `src/main.ts:83-87`
- Modify: `src/syncSettings.ts:16-19`

**Interfaces:**
- Produces: `syncObsidianConfig`, `syncThirdPartyPlugins`, `syncSelfPlugin` fields on `RemotelySavePluginSettings`

- [ ] **Step 1: Add fields to baseTypes.ts**

In `src/baseTypes.ts`, after the existing `syncConfigDir?: boolean;` line (line 67), add the three new fields:

```typescript
  syncObsidianConfig?: boolean;
  syncThirdPartyPlugins?: boolean;
  syncSelfPlugin?: boolean;
```

- [ ] **Step 2: Add defaults and migration in main.ts**

In `src/main.ts`, update the DEFAULT_SETTINGS object (around line 83). Add the three new fields with default `true`, and keep `syncConfigDir: false`:

```typescript
  syncConfigDir: false,
  syncObsidianConfig: true,
  syncThirdPartyPlugins: true,
  syncSelfPlugin: true,
  syncBookmarks: false,
  syncUnderscoreItems: false,
  syncDotItems: false,
```

In the `loadSettings()` method, add migration logic after loading settings (after the existing `?? false` fallbacks). Find the section where settings are loaded and merged with defaults, and add:

```typescript
    // Migrate old syncConfigDir to new toggles
    if (this.settings.syncConfigDir === true) {
      this.settings.syncObsidianConfig = true;
      this.settings.syncThirdPartyPlugins = true;
      this.settings.syncSelfPlugin = true;
      this.settings.syncConfigDir = false;
    }
    // Apply defaults for new fields if missing
    this.settings.syncObsidianConfig ??= true;
    this.settings.syncThirdPartyPlugins ??= true;
    this.settings.syncSelfPlugin ??= true;
```

- [ ] **Step 3: Update SYNCABLE_FIELDS in syncSettings.ts**

In `src/syncSettings.ts`, add the three new fields to `SYNCABLE_FIELDS` (after line 16 `"syncConfigDir",`):

```typescript
  "syncConfigDir",
  "syncObsidianConfig",
  "syncThirdPartyPlugins",
  "syncSelfPlugin",
```

Note: keep `syncConfigDir` in the list — it's still used for migration detection on other devices.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new optional fields don't break existing code)

- [ ] **Step 5: Commit**

```bash
git add src/baseTypes.ts src/main.ts src/syncSettings.ts
git commit -m "feat: add syncObsidianConfig, syncThirdPartyPlugins, syncSelfPlugin settings"
```

---

### Task 2: Update skipFilter.ts pure function and tests

**Files:**
- Modify: `src/skipFilter.ts` (entire file rewrite)
- Modify: `tests/sync.test.ts` (rewrite existing tests for new signature)
- Create: `tests/obsidianSyncFilter.test.ts` (new routing tests)

**Interfaces:**
- Consumes: `obsidianFolder: string` from caller
- Produces: `checkIsSkipItemOrNotByName` with new signature including `syncObsidianConfig`, `syncAppearance`, `syncBookmarks`, `syncThirdPartyPlugins`, `syncSelfPlugin` parameters

- [ ] **Step 1: Rewrite skipFilter.ts with new signature and routing logic**

Replace the entire `src/skipFilter.ts` content. The new function accepts five toggle booleans instead of using `obsidianFolder` to unconditionally skip:

```typescript
// License: Apache-2.0. See LICENSE.

/** Result of checking whether a sync item should be ignored. */
export interface SkipCheckResult {
  finalIsIgnored: boolean;
}

// Built-in blacklist: device-specific files always excluded from sync
// regardless of toggle state.
const OBSIDIAN_BLACKLIST = [
  "workspace.json",
  "workspace-mobile.json",
  "workspaces.json",
  "core-plugins-migration.json",
];

// Files always synced when syncSelfPlugin is on (everything else in the
// self-plugin dir is always skipped, e.g. data.json).
const SELF_PLUGIN_ALLOWED = [
  "main.js",
  "manifest.json",
  "styles.css",
  "synced_settings.json",
  ".gitignore",
];

// Decide whether a sync item should be ignored. Five independent toggles
// control what gets synced inside the Obsidian config folder (.obsidian/):
//   syncObsidianConfig  — core config files, snippets, themes, icons
//   syncAppearance      — appearance.json
//   syncBookmarks       — bookmarks.json
//   syncThirdPartyPlugins — other plugins' code and settings
//   syncSelfPlugin      — this plugin's own code files
//
// All toggles are independent — none controls another.
//
// Backslashes in the key are normalized to "/" for Windows/Unix parity.
// Double-backslashes in regex patterns are normalized to "/" but
// single-backslash escapes like \.png$ are left untouched.
export function checkIsSkipItemOrNotByName(
  key: string,
  isHidden: boolean,
  isFolder: boolean,
  isSymlink: boolean,
  obsidianFolder: string,
  ignorePaths: string[],
  onlyAllowPaths: string[],
  syncObsidianConfig: boolean,
  syncAppearance: boolean,
  syncBookmarks: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  selfPluginId: string
): SkipCheckResult {
  const normalizedKey = key.replace(/\\/g, "/");

  const normalizePattern = (p: string): string => p.replace(/\\\\/g, "/");

  const matchesList = (list: string[]): boolean => {
    for (const raw of list) {
      if (raw.trim() === "") {
        continue;
      }
      const pattern = normalizePattern(raw);
      if (new RegExp(pattern).test(normalizedKey)) {
        return true;
      }
    }
    return false;
  };

  const isDenied = matchesList(ignorePaths);

  const allowHasEntries = onlyAllowPaths.some((s) => s.trim() !== "");
  const isAllowed = !allowHasEntries || matchesList(onlyAllowPaths);

  const otherSkip = isHidden || isFolder || isSymlink;

  // Check if key is inside the obsidian config folder
  const inObsidianFolder =
    obsidianFolder !== "" &&
    (normalizedKey === obsidianFolder ||
      normalizedKey.startsWith(`${obsidianFolder}/`));

  // Determine if key is inside the self-plugin directory
  const selfPluginPrefix = `${obsidianFolder}/plugins/${selfPluginId}/`;
  const inSelfPlugin =
    normalizedKey.startsWith(selfPluginPrefix) ||
    normalizedKey === `${obsidianFolder}/plugins/${selfPluginId}`;

  // Check if key is inside other plugins (plugins/ but not self)
  const pluginsPrefix = `${obsidianFolder}/plugins/`;
  const inPlugins = normalizedKey.startsWith(pluginsPrefix);
  const inOtherPlugins = inPlugins && !inSelfPlugin;

  // Extract the basename (last path segment)
  const basename = normalizedKey.split("/").pop() ?? "";

  // Extract the relative path within .obsidian/
  let relPath = "";
  if (inObsidianFolder && normalizedKey !== obsidianFolder) {
    relPath = normalizedKey.slice(obsidianFolder.length + 1);
  }

  // Determine finalIsIgnored based on toggle routing
  let finalIsIgnored: boolean;

  if (!inObsidianFolder) {
    // Outside .obsidian/: standard logic
    finalIsIgnored = isDenied || !isAllowed || otherSkip;
  } else {
    // Inside .obsidian/
    // Check blacklist first (always excluded)
    if (OBSIDIAN_BLACKLIST.includes(basename)) {
      finalIsIgnored = true;
    } else if (basename === "appearance.json") {
      finalIsIgnored = !syncAppearance;
    } else if (basename === "bookmarks.json") {
      finalIsIgnored = !syncBookmarks;
    } else if (inSelfPlugin) {
      // Self plugin directory: only sync allowed files
      if (SELF_PLUGIN_ALLOWED.includes(basename)) {
        finalIsIgnored = !syncSelfPlugin;
      } else {
        finalIsIgnored = true; // e.g. data.json
      }
    } else if (inOtherPlugins) {
      finalIsIgnored = !syncThirdPartyPlugins;
    } else {
      // Root config files, snippets/, themes/, icons/
      finalIsIgnored = !syncObsidianConfig;
    }

    // Apply deny/allow lists on top (deny always wins)
    if (isDenied) {
      finalIsIgnored = true;
    }
    // Allow list: if allow mode is on and not allowed, skip
    if (allowHasEntries && !isAllowed) {
      finalIsIgnored = true;
    }
  }

  return { finalIsIgnored };
}
```

- [ ] **Step 2: Update existing tests in sync.test.ts**

Replace the import and all test calls in `tests/sync.test.ts` to use the new signature. The existing tests pass `false, false, false, false` for the first four booleans (isHidden, isFolder, isSymlink) and `.obsidian` for obsidianFolder. Now they also need the five toggle parameters and selfPluginId.

Replace the entire file content:

```typescript
import { strict as assert } from "assert";
import { checkIsSkipItemOrNotByName } from "../src/skipFilter";

// Helper: call with all .obsidian sync toggles OFF (matches old default
// behavior where nothing in .obsidian was synced)
function callSkip(
  key: string,
  opts: {
    isHidden?: boolean;
    isFolder?: boolean;
    isSymlink?: boolean;
    obsidianFolder?: string;
    ignorePaths?: string[];
    onlyAllowPaths?: string[];
    syncObsidianConfig?: boolean;
    syncAppearance?: boolean;
    syncBookmarks?: boolean;
    syncThirdPartyPlugins?: boolean;
    syncSelfPlugin?: boolean;
    selfPluginId?: string;
  } = {}
) {
  return checkIsSkipItemOrNotByName(
    key,
    opts.isHidden ?? false,
    opts.isFolder ?? false,
    opts.isSymlink ?? false,
    opts.obsidianFolder ?? ".obsidian",
    opts.ignorePaths ?? [],
    opts.onlyAllowPaths ?? [],
    opts.syncObsidianConfig ?? false,
    opts.syncAppearance ?? false,
    opts.syncBookmarks ?? false,
    opts.syncThirdPartyPlugins ?? false,
    opts.syncSelfPlugin ?? false,
    opts.selfPluginId ?? "remotely-save-onedrive"
  ).finalIsIgnored;
}

describe("Sync: checkIsSkipItemOrNotByName (standard paths)", () => {
  it("should be ok everywhere for empty config", async () => {
    let isSkip = callSkip("xxx.md");
    assert.ok(!isSkip);

    isSkip = callSkip("xxx.md", {
      ignorePaths: [""],
      onlyAllowPaths: ["", "\n"],
    });
    assert.ok(!isSkip);
  });

  it("should be ok for deny list", async () => {
    let isSkip = callSkip("xxx.md", { ignorePaths: ["xxx"] });
    assert.ok(isSkip);

    isSkip = callSkip("yyy.md", { ignorePaths: ["xxx"] });
    assert.ok(!isSkip);

    isSkip = callSkip("xxx.md", { ignorePaths: ["xxx$"] });
    assert.ok(!isSkip);
  });

  it("should be ok for allow list", async () => {
    let isSkip = callSkip("xxx.md", { onlyAllowPaths: ["xxx"] });
    assert.ok(!isSkip);

    isSkip = callSkip("yyy.md", { onlyAllowPaths: ["xxx"] });
    assert.ok(isSkip);

    isSkip = callSkip("xxx.md", { onlyAllowPaths: ["xxx$"] });
    assert.ok(isSkip);
  });

  it("should detect the name by two lists together", async () => {
    let isSkip = callSkip("xxx.md", {
      ignorePaths: ["xxx"],
      onlyAllowPaths: ["yyy"],
    });
    assert.ok(isSkip);

    isSkip = callSkip("xxx/yyy.md", {
      ignorePaths: ["xxx"],
      onlyAllowPaths: ["xxx/yyy.md"],
    });
    assert.ok(isSkip);
  });

  it("should normalize backslash in key path", async () => {
    const isSkip = callSkip("tmp\\foo.md", { ignorePaths: ["tmp/.*"] });
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in ignorePaths regex", async () => {
    const isSkip = callSkip("tmp/foo.md", { ignorePaths: ["tmp\\\\.*"] });
    assert.ok(isSkip);
  });

  it("should normalize backslash in key AND regex together", async () => {
    const isSkip = callSkip("tmp\\foo.md", { ignorePaths: ["tmp\\\\.*"] });
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in onlyAllowPaths regex", async () => {
    const isSkip = callSkip("tmp/foo.md", { onlyAllowPaths: ["tmp\\\\.*"] });
    assert.ok(!isSkip);
  });

  it("should NOT touch single-backslash escapes like \\.", async () => {
    let isSkip = callSkip("a.png", { ignorePaths: [String.raw`\.png$`] });
    assert.ok(isSkip);

    isSkip = callSkip("a_png", { ignorePaths: [String.raw`\.png$`] });
    assert.ok(!isSkip);
  });
});
```

- [ ] **Step 3: Create new routing tests**

Create `tests/obsidianSyncFilter.test.ts` with the 32 routing test cases from the spec:

```typescript
import { strict as assert } from "assert";
import { checkIsSkipItemOrNotByName } from "../src/skipFilter";

const CF = ".obsidian";
const PID = "remotely-save-onedrive";

function skip(
  key: string,
  syncObsidianConfig = false,
  syncAppearance = false,
  syncBookmarks = false,
  syncThirdPartyPlugins = false,
  syncSelfPlugin = false
): boolean {
  return checkIsSkipItemOrNotByName(
    key, false, false, false, CF, [], [],
    syncObsidianConfig, syncAppearance, syncBookmarks,
    syncThirdPartyPlugins, syncSelfPlugin, PID
  ).finalIsIgnored;
}

const ALL_ON = [true, true, true, true, true]; // syncObsidianConfig, syncAppearance, syncBookmarks, syncThirdPartyPlugins, syncSelfPlugin

describe("Obsidian sync: blacklist (always excluded)", () => {
  it("#1 workspace.json always skipped", () => {
    assert.ok(skip(`${CF}/workspace.json`, ...ALL_ON));
  });
  it("#2 workspace-mobile.json always skipped", () => {
    assert.ok(skip(`${CF}/workspace-mobile.json`, ...ALL_ON));
  });
  it("#3 workspaces.json always skipped", () => {
    assert.ok(skip(`${CF}/workspaces.json`, ...ALL_ON));
  });
  it("#4 core-plugins-migration.json always skipped", () => {
    assert.ok(skip(`${CF}/core-plugins-migration.json`, ...ALL_ON));
  });
});

describe("Obsidian sync: self plugin", () => {
  it("#5 self data.json always skipped", () => {
    assert.ok(skip(`${CF}/plugins/${PID}/data.json`, false, false, false, false, true));
  });
  it("#6 self main.js synced when syncSelfPlugin on", () => {
    assert.ok(!skip(`${CF}/plugins/${PID}/main.js`, false, false, false, false, true));
  });
  it("#7 self main.js skipped when syncSelfPlugin off", () => {
    assert.ok(skip(`${CF}/plugins/${PID}/main.js`, false, false, false, false, false));
  });
  it("#8 self styles.css synced", () => {
    assert.ok(!skip(`${CF}/plugins/${PID}/styles.css`, false, false, false, false, true));
  });
  it("#9 self synced_settings.json synced", () => {
    assert.ok(!skip(`${CF}/plugins/${PID}/synced_settings.json`, false, false, false, false, true));
  });
  it("#10 self .gitignore synced", () => {
    assert.ok(!skip(`${CF}/plugins/${PID}/.gitignore`, false, false, false, false, true));
  });
  it("#30 self unknown file skipped", () => {
    assert.ok(skip(`${CF}/plugins/${PID}/unknown.txt`, false, false, false, false, true));
  });
});

describe("Obsidian sync: third-party plugins", () => {
  it("#11 other plugin main.js synced", () => {
    assert.ok(!skip(`${CF}/plugins/dataview/main.js`, false, false, false, true, false));
  });
  it("#12 other plugin main.js skipped when off", () => {
    assert.ok(skip(`${CF}/plugins/dataview/main.js`, false, false, false, false, false));
  });
  it("#13 other plugin data.json synced", () => {
    assert.ok(!skip(`${CF}/plugins/copilot/data.json`, false, false, false, true, false));
  });
  it("#14 other plugin manifest.json synced", () => {
    assert.ok(!skip(`${CF}/plugins/dataview/manifest.json`, false, false, false, true, false));
  });
});

describe("Obsidian sync: core config", () => {
  it("#15 app.json synced when on", () => {
    assert.ok(!skip(`${CF}/app.json`, true, false, false, false, false));
  });
  it("#16 app.json skipped when off", () => {
    assert.ok(skip(`${CF}/app.json`, false, false, false, false, false));
  });
  it("#17 core-plugins.json synced", () => {
    assert.ok(!skip(`${CF}/core-plugins.json`, true, false, false, false, false));
  });
  it("#18 community-plugins.json synced", () => {
    assert.ok(!skip(`${CF}/community-plugins.json`, true, false, false, false, false));
  });
  it("#19 snippets synced", () => {
    assert.ok(!skip(`${CF}/snippets/h1.css`, true, false, false, false, false));
  });
  it("#20 snippets skipped when off", () => {
    assert.ok(skip(`${CF}/snippets/h1.css`, false, false, false, false, false));
  });
  it("#21 themes synced", () => {
    assert.ok(!skip(`${CF}/themes/PLN/theme.css`, true, false, false, false, false));
  });
  it("#22 icons synced", () => {
    assert.ok(!skip(`${CF}/icons/tabl-icons/CodeCircle.svg`, true, false, false, false, false));
  });
});

describe("Obsidian sync: independent sub-toggles", () => {
  it("#23 appearance.json skipped when syncAppearance off", () => {
    assert.ok(skip(`${CF}/appearance.json`, true, false, false, false, false));
  });
  it("#24 appearance.json synced when syncAppearance on (independent)", () => {
    assert.ok(!skip(`${CF}/appearance.json`, false, true, false, false, false));
  });
  it("#25 bookmarks.json skipped when syncBookmarks off", () => {
    assert.ok(skip(`${CF}/bookmarks.json`, true, false, false, false, false));
  });
  it("#26 bookmarks.json synced when syncBookmarks on (independent)", () => {
    assert.ok(!skip(`${CF}/bookmarks.json`, false, false, true, false, false));
  });
});

describe("Obsidian sync: directory and non-config files", () => {
  it("#27 .obsidian/ itself not skipped when any toggle on", () => {
    assert.ok(!skip(`${CF}/`, false, false, false, false, true));
  });
  it("#28 .obsidian/ itself skipped when all off", () => {
    assert.ok(skip(`${CF}/`, false, false, false, false, false));
  });
  it("#29 non-config file unaffected", () => {
    assert.ok(!skip("notes/test.md", false, false, false, false, false));
  });
});

describe("Obsidian sync: toggle independence", () => {
  it("#31 third-party off blocks other plugin even if self+config on", () => {
    assert.ok(skip(`${CF}/plugins/dataview/main.js`, true, false, false, false, true));
  });
  it("#32 config off blocks app.json even if self+thirdparty on", () => {
    assert.ok(skip(`${CF}/app.json`, false, false, false, true, true));
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha --import=tsx tests/sync.test.ts tests/obsidianSyncFilter.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/skipFilter.ts tests/sync.test.ts tests/obsidianSyncFilter.test.ts
git commit -m "feat: update skipFilter with five independent .obsidian sync toggles + tests"
```

---

### Task 3: Update sync.ts checkIsSkipItemOrNotByName

**Files:**
- Modify: `src/sync.ts:136-257` (function signature and routing logic)
- Modify: `src/sync.ts:348-359` (ensembleMixedEnties parameters)
- Modify: `src/sync.ts:384-389, 435-440, 473-478` (call sites)

**Interfaces:**
- Consumes: new toggle values from settings
- Produces: updated `checkIsSkipItemOrNotByName` and `ensembleMixedEnties` signatures for later tasks

- [ ] **Step 1: Update checkIsSkipItemOrNotByName signature and logic**

In `src/sync.ts`, replace the function signature (line 136) to use the three new parameters instead of `syncConfigDir`:

```typescript
export const checkIsSkipItemOrNotByName = (
  key: string,
  syncObsidianConfig: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  syncBookmarks: boolean,
  syncAppearance: boolean,
  syncUnderscoreItems: boolean,
  syncDotItems: boolean,
  configDir: string,
  ignorePaths: string[],
  onlyAllowPaths: string[],
  selfPluginId: string
): IsSkipResult => {
```

Replace the `.obsidian` routing logic (lines 195-226) with the new five-toggle routing:

```typescript
  // Built-in blacklist: always excluded
  const OBSIDIAN_BLACKLIST = [
    "workspace.json",
    "workspace-mobile.json",
    "workspaces.json",
    "core-plugins-migration.json",
  ];
  const SELF_PLUGIN_ALLOWED = [
    "main.js",
    "manifest.json",
    "styles.css",
    "synced_settings.json",
    ".gitignore",
  ];

  if (finalIsIgnored === undefined) {
    if (isInsideObsFolder(key, configDir)) {
      const basename = normalizedKey.split("/").pop() ?? "";
      const selfPluginPrefix = `${configDir}/plugins/${selfPluginId}/`;
      const inSelfPlugin = normalizedKey.startsWith(selfPluginPrefix) ||
        normalizedKey === `${configDir}/plugins/${selfPluginId}`;
      const pluginsPrefix = `${configDir}/plugins/`;
      const inOtherPlugins = normalizedKey.startsWith(pluginsPrefix) && !inSelfPlugin;

      if (OBSIDIAN_BLACKLIST.includes(basename)) {
        finalIsIgnored = true;
      } else if (basename === "appearance.json") {
        finalIsIgnored = !syncAppearance;
      } else if (basename === "bookmarks.json") {
        finalIsIgnored = !syncBookmarks;
      } else if (inSelfPlugin) {
        finalIsIgnored = SELF_PLUGIN_ALLOWED.includes(basename) ? !syncSelfPlugin : true;
      } else if (inOtherPlugins) {
        finalIsIgnored = !syncThirdPartyPlugins;
      } else {
        finalIsIgnored = !syncObsidianConfig;
      }
    } else {
      // not config files, do not judge now, do nothing
    }
  }
```

Also need to add `selfPluginId` to the `IsSkipResult` return or pass it through. Actually, `selfPluginId` is only used inside the function, so just add it as a parameter.

- [ ] **Step 2: Update ensembleMixedEnties signature**

In `src/sync.ts` line 348, update `ensembleMixedEnties` to accept the new parameters instead of `syncConfigDir`:

```typescript
const ensembleMixedEnties = async (
  localEntityList: Entity[],
  prevSyncEntityList: Entity[],
  remoteEntityList: Entity[],

  syncObsidianConfig: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  syncBookmarks: boolean,
  syncAppearance: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  syncDotItems: boolean,
  ignorePaths: string[],
  onlyAllowPaths: string[],
```

- [ ] **Step 3: Update call sites inside ensembleMixedEnties**

At lines 384, 435, 473 (the three calls to `checkIsSkipItemOrNotByName`), update the arguments:

```typescript
      syncObsidianConfig,
      syncThirdPartyPlugins,
      syncSelfPlugin,
      syncBookmarks,
      syncAppearance,
      syncUnderscoreItems,
      syncDotItems,
      configDir,
      ignorePaths,
      onlyAllowPaths,
      selfPluginId
```

- [ ] **Step 4: Update metadata recording (line 1216)**

Replace `syncConfigDir: settings.syncConfigDir,` with:

```typescript
      syncObsidianConfig: settings.syncObsidianConfig,
      syncThirdPartyPlugins: settings.syncThirdPartyPlugins,
      syncSelfPlugin: settings.syncSelfPlugin,
      syncBookmarks: settings.syncBookmarks,
```

- [ ] **Step 5: Update the ensembleMixedEnties call at line 2103**

Replace:
```typescript
      settings.syncConfigDir ?? false,
      settings.syncBookmarks ?? false,
      configDir,
```
With:
```typescript
      settings.syncObsidianConfig ?? true,
      settings.syncThirdPartyPlugins ?? true,
      settings.syncSelfPlugin ?? true,
      settings.syncBookmarks ?? false,
      settings.syncAppearance ?? false,
      configDir,
```

Also add `selfPluginId` to the call. Find where `selfPluginId` is available — it should be `this.manifest.id` or passed through. Check the function that calls `ensembleMixedEnties` and ensure `selfPluginId` is available.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `ensembleMixedEnties` callers and `FakeFsLocal` not yet updated. Fix only the type errors in `sync.ts` by adding `selfPluginId` parameter.

- [ ] **Step 7: Commit**

```bash
git add src/sync.ts
git commit -m "feat: update sync.ts checkIsSkipItemOrNotByName with five-toggle routing"
```

---

### Task 4: Update obsFolderLister.ts

**Files:**
- Modify: `src/obsFolderLister.ts` (entire file rewrite)
- Create: `tests/obsFolderLister.test.ts`

**Interfaces:**
- Consumes: five toggle booleans from caller
- Produces: `listFilesInObsFolder` with new signature

- [ ] **Step 1: Rewrite obsFolderLister.ts**

Replace the function signature and logic. The new function accepts five toggle booleans and only lists relevant directories:

```typescript
import type { ListedFiles, Vault } from "obsidian";
import type { Entity } from "./baseTypes";

import { Queue } from "@fyears/tsqueue";
import chunk from "lodash/chunk";
import flatten from "lodash/flatten";
import { isSpecialFolderNameToSkip, statFix } from "./misc";

const isPluginDirItself = (x: string, pluginId: string) => {
  return (
    x === pluginId ||
    x === `${pluginId}/` ||
    x.endsWith(`/${pluginId}`) ||
    x.endsWith(`/${pluginId}/`)
  );
};

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

export const listFilesInObsFolder = async (
  configDir: string,
  vault: Vault,
  pluginId: string,
  syncObsidianConfig: boolean,
  syncAppearance: boolean,
  syncBookmarks: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean
): Promise<Entity[]> => {
  const q = new Queue([configDir]);
  const CHUNK_SIZE = 10;
  let contents: Entity[] = [];

  // Names always skipped within the config dir (device-specific).
  const skipNames = [
    "workspace",
    "workspace.json",
    "workspace-mobile.json",
    "workspaces.json",
    "core-plugins-migration.json",
  ];
  if (!syncAppearance) {
    skipNames.push("appearance.json");
  }

  let iterRound = 0;

  while (q.length > 0) {
    const itemsToFetch: string[] = [];
    while (q.length > 0) {
      itemsToFetch.push(q.pop()!);
    }

    const itemsToFetchChunks = chunk(itemsToFetch, CHUNK_SIZE);
    for (const singleChunk of itemsToFetchChunks) {
      const r = singleChunk.map(async (x) => {
        const statRes = await statFix(vault, x);

        if (statRes === undefined || statRes === null) {
          throw Error("something goes wrong while listing hidden folder");
        }
        const isFolder = statRes.type === "folder";
        let children: ListedFiles | undefined = undefined;
        if (isFolder) {
          children = await vault.adapter.list(x);
        }

        if (
          !isFolder &&
          (statRes.mtime === undefined ||
            statRes.mtime === null ||
            statRes.mtime === 0)
        ) {
          throw Error(
            `File in Obsidian ${configDir} has last modified time 0: ${x}, don't know how to deal with it.`
          );
        }

        return {
          itself: {
            key: isFolder ? `${x}/` : x,
            keyRaw: isFolder ? `${x}/` : x,
            mtimeCli: statRes.mtime,
            mtimeSvr: statRes.mtime,
            size: statRes.size,
            sizeRaw: statRes.size,
          },
          children: children,
        };
      });
      const r2 = flatten(await Promise.all(r));

      for (const iter of r2) {
        // Determine if we should include this file
        const isInsideSelfPlugin = isPluginDirItself(iter.itself.key, pluginId);
        const basename = iter.itself.key.split("/").pop()?.replace(/\/$/, "") ?? "";
        const isPluginsDir = iter.itself.key === `${configDir}/plugins/` ||
          iter.itself.key.endsWith("/plugins/");
        const isInsidePlugins = iter.itself.key.startsWith(`${configDir}/plugins/`);
        const isInsideSelf = isInsidePlugins && isPluginDirItself(
          iter.itself.key.replace(`${configDir}/plugins/`, ""), pluginId
        );

        // For the plugins/ directory itself, only traverse if needed
        if (isPluginsDir && !syncThirdPartyPlugins && !syncSelfPlugin) {
          continue;
        }

        // For files, decide inclusion based on routing
        let shouldInclude = true;
        if (isInsideSelf) {
          // Self plugin dir: only include allowed files if syncSelfPlugin
          if (!isLikelyPluginSubFiles(basename)) {
            shouldInclude = false;
          }
          if (!syncSelfPlugin) {
            shouldInclude = false;
          }
        } else if (isInsidePlugins) {
          // Other plugins: include if syncThirdPartyPlugins
          if (!syncThirdPartyPlugins) {
            shouldInclude = false;
          }
        } else if (iter.itself.key !== `${configDir}/` &&
                   iter.itself.key !== configDir) {
          // Root config files, snippets, themes, icons
          if (basename === "bookmarks.json") {
            if (!syncBookmarks) shouldInclude = false;
          } else if (basename === "appearance.json") {
            // already in skipNames if !syncAppearance
          } else {
            if (!syncObsidianConfig) shouldInclude = false;
          }
        }

        if (shouldInclude) {
          contents.push(iter.itself);
        }

        if (iter.children !== undefined) {
          for (const iter2 of iter.children.folders) {
            if (isSpecialFolderNameToSkip(iter2, skipNames)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              continue;
            }
            // Don't traverse plugins/ dir if neither toggle is on
            const isPluginsSubdir = iter2 === `${configDir}/plugins` ||
              iter2.endsWith("/plugins");
            if (isPluginsSubdir && !syncThirdPartyPlugins && !syncSelfPlugin) {
              continue;
            }
            q.push(iter2);
          }
          for (const iter2 of iter.children.files) {
            if (isSpecialFolderNameToSkip(iter2, skipNames)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              continue;
            }
            q.push(iter2);
          }
        }
      }
    }

    iterRound += 1;
  }

  return contents;
};
```

- [ ] **Step 2: Write obsFolderLister tests**

Create `tests/obsFolderLister.test.ts`. Mock `Vault` by stubbing `statFix` and `vault.adapter.list`. Test cases #33-40 from the spec:

```typescript
import { strict as assert } from "assert";
import sinon from "sinon";
import { listFilesInObsFolder } from "../src/obsFolderLister";

// Mock Vault type — only stat() and adapter.list() are used
function mockVault(tree: Record<string, { type: "file" | "folder"; mtime?: number; size?: number; children?: string[] }>): any {
  return {
    adapter: {
      list: async (path: string) => {
        const node = tree[path] ?? tree[path.replace(/\/$/, "")];
        if (!node || node.type !== "folder") {
          return { files: [], folders: [] };
        }
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const files: string[] = [];
        const folders: string[] = [];
        for (const child of node.children ?? []) {
          const childPath = `${prefix}${child}`;
          const childNode = tree[childPath];
          if (childNode?.type === "folder") {
            folders.push(childPath);
          } else {
            files.push(childPath);
          }
        }
        return { files, folders };
      },
    },
  };
}

// Stub statFix to return mock data
function stubStatFix(tree: Record<string, any>) {
  return sinon.stub().callsFake(async (vault: any, path: string) => {
    const node = tree[path];
    if (!node) return undefined;
    return { type: node.type, mtime: node.mtime ?? 1234567890, size: node.size ?? 100 };
  });
}

const CF = ".obsidian";
const PID = "remotely-save-onedrive";

describe("obsFolderLister: selective listing", () => {
  let statStub: sinon.SinonStub;

  beforeEach(() => { statStub = sinon.stub(); });
  afterEach(() => { sinon.restore(); });

  it("#33 only self plugin synced", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["plugins"] },
      [`${CF}/plugins`]: { type: "folder", children: [PID] },
      [`${CF}/plugins/${PID}`]: { type: "folder", children: ["main.js", "manifest.json", "data.json"] },
      [`${CF}/plugins/${PID}/main.js`]: { type: "file", size: 1000 },
      [`${CF}/plugins/${PID}/manifest.json`]: { type: "file", size: 200 },
      [`${CF}/plugins/${PID}/data.json`]: { type: "file", size: 500 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, false, false, false, false, true);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/plugins/${PID}/main.js`));
    assert.ok(keys.includes(`${CF}/plugins/${PID}/manifest.json`));
    assert.ok(!keys.includes(`${CF}/plugins/${PID}/data.json`));
  });

  it("#34 only third-party plugins synced", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["plugins"] },
      [`${CF}/plugins`]: { type: "folder", children: ["dataview"] },
      [`${CF}/plugins/dataview`]: { type: "folder", children: ["main.js", "data.json"] },
      [`${CF}/plugins/dataview/main.js`]: { type: "file", size: 1000 },
      [`${CF}/plugins/dataview/data.json`]: { type: "file", size: 500 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, false, false, false, true, false);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/plugins/dataview/main.js`));
    assert.ok(keys.includes(`${CF}/plugins/dataview/data.json`));
  });

  it("#35 only core config synced (excludes workspace, appearance, bookmarks)", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["app.json", "workspace.json", "appearance.json", "bookmarks.json"] },
      [`${CF}/app.json`]: { type: "file", size: 242 },
      [`${CF}/workspace.json`]: { type: "file", size: 16000 },
      [`${CF}/appearance.json`]: { type: "file", size: 197 },
      [`${CF}/bookmarks.json`]: { type: "file", size: 306 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, true, false, false, false, false);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/app.json`));
    assert.ok(!keys.some((k) => k.includes("workspace")));
    assert.ok(!keys.includes(`${CF}/appearance.json`));
    assert.ok(!keys.includes(`${CF}/bookmarks.json`));
  });

  it("#36 core config + appearance", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["app.json", "appearance.json"] },
      [`${CF}/app.json`]: { type: "file", size: 242 },
      [`${CF}/appearance.json`]: { type: "file", size: 197 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, true, true, false, false, false);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/app.json`));
    assert.ok(keys.includes(`${CF}/appearance.json`));
  });

  it("#37 all toggles off → empty result", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["app.json"] },
      [`${CF}/app.json`]: { type: "file", size: 242 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, false, false, false, false, false);
    const keys = result.map((e) => e.key);
    assert.ok(!keys.includes(`${CF}/app.json`));
  });

  it("#38 blacklist excludes workspace-mobile and workspaces", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["app.json", "workspace-mobile.json", "workspaces.json"] },
      [`${CF}/app.json`]: { type: "file", size: 242 },
      [`${CF}/workspace-mobile.json`]: { type: "file", size: 7000 },
      [`${CF}/workspaces.json`]: { type: "file", size: 13000 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, true, false, false, false, false);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/app.json`));
    assert.ok(!keys.includes(`${CF}/workspace-mobile.json`));
    assert.ok(!keys.includes(`${CF}/workspaces.json`));
  });

  it("#39 snippets and themes synced", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["snippets", "themes"] },
      [`${CF}/snippets`]: { type: "folder", children: ["h1.css"] },
      [`${CF}/snippets/h1.css`]: { type: "file", size: 4106 },
      [`${CF}/themes`]: { type: "folder", children: ["PLN"] },
      [`${CF}/themes/PLN`]: { type: "folder", children: ["theme.css"] },
      [`${CF}/themes/PLN/theme.css`]: { type: "file", size: 83512 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, true, false, false, false, false);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/snippets/h1.css`));
    assert.ok(keys.includes(`${CF}/themes/PLN/theme.css`));
  });

  it("#40 self plugin filters unknown files", async () => {
    const tree = {
      [CF]: { type: "folder", children: ["plugins"] },
      [`${CF}/plugins`]: { type: "folder", children: [PID] },
      [`${CF}/plugins/${PID}`]: { type: "folder", children: ["main.js", "styles.css", "unknown.txt", "data.json"] },
      [`${CF}/plugins/${PID}/main.js`]: { type: "file", size: 1000 },
      [`${CF}/plugins/${PID}/styles.css`]: { type: "file", size: 500 },
      [`${CF}/plugins/${PID}/unknown.txt`]: { type: "file", size: 10 },
      [`${CF}/plugins/${PID}/data.json`]: { type: "file", size: 500 },
    };
    statStub = stubStatFix(tree);
    const vault = mockVault(tree);
    const result = await listFilesInObsFolder(CF, vault, PID, false, false, false, false, true);
    const keys = result.map((e) => e.key);
    assert.ok(keys.includes(`${CF}/plugins/${PID}/main.js`));
    assert.ok(keys.includes(`${CF}/plugins/${PID}/styles.css`));
    assert.ok(!keys.includes(`${CF}/plugins/${PID}/unknown.txt`));
    assert.ok(!keys.includes(`${CF}/plugins/${PID}/data.json`));
  });
});
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL — `fsLocal.ts` still passes old arguments. That's expected, will fix in Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/obsFolderLister.ts
git commit -m "feat: update obsFolderLister with five-toggle selective listing"
```

---

### Task 5: Update fsLocal.ts and all instantiation sites

**Files:**
- Modify: `src/fsLocal.ts:11-34, 105-119`
- Modify: `src/main.ts:193-201, 1527-1536`
- Modify: `src/sync.ts:1216-1219, 2107-2111` (if not already done in Task 3)
- Modify: `src/settingsClearDupFiles.ts:78-80`

**Interfaces:**
- Consumes: five toggle booleans from settings
- Produces: `FakeFsLocal` constructor with new parameters

- [ ] **Step 1: Update FakeFsLocal constructor**

In `src/fsLocal.ts`, update the constructor fields (lines 11-13) and constructor parameters (lines 21-23):

Replace:
```typescript
  syncConfigDir: boolean;
  syncBookmarks: boolean;
  syncAppearance: boolean;
```
With:
```typescript
  syncObsidianConfig: boolean;
  syncThirdPartyPlugins: boolean;
  syncSelfPlugin: boolean;
  syncBookmarks: boolean;
  syncAppearance: boolean;
```

Update the constructor assignments (lines 32-34):
```typescript
    this.syncObsidianConfig = syncObsidianConfig;
    this.syncThirdPartyPlugins = syncThirdPartyPlugins;
    this.syncSelfPlugin = syncSelfPlugin;
    this.syncBookmarks = syncBookmarks;
    this.syncAppearance = syncAppearance;
```

Update the walk method (lines 105-119):

Replace:
```typescript
    if (this.syncConfigDir || this.syncBookmarks) {
      this.profiler?.insert("into syncConfigDir or syncBookmarks");
      const bookmarksOnly = !this.syncConfigDir;
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        bookmarksOnly,
        this.syncAppearance
      );
```
With:
```typescript
    if (this.syncObsidianConfig || this.syncBookmarks || this.syncThirdPartyPlugins || this.syncSelfPlugin || this.syncAppearance) {
      this.profiler?.insert("into obsidian config sync");
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        this.syncObsidianConfig,
        this.syncAppearance,
        this.syncBookmarks,
        this.syncThirdPartyPlugins,
        this.syncSelfPlugin
      );
```

- [ ] **Step 2: Update FakeFsLocal instantiation in main.ts**

At `src/main.ts:193-201`, replace:
```typescript
    const fsLocal = new FakeFsLocal(
      this.app.vault,
      this.settings.syncConfigDir ?? false,
      this.settings.syncBookmarks ?? false,
      this.settings.syncAppearance ?? false,
      this.app.vault.configDir,
      this.manifest.id,
      profiler,
      this.settings.deleteToWhere ?? "system"
    );
```
With:
```typescript
    const fsLocal = new FakeFsLocal(
      this.app.vault,
      this.settings.syncObsidianConfig ?? true,
      this.settings.syncThirdPartyPlugins ?? true,
      this.settings.syncSelfPlugin ?? true,
      this.settings.syncBookmarks ?? false,
      this.settings.syncAppearance ?? false,
      this.app.vault.configDir,
      this.manifest.id,
      profiler,
      this.settings.deleteToWhere ?? "system"
    );
```

At `src/main.ts:1527-1536`, apply the same change.

- [ ] **Step 3: Update settingsClearDupFiles.ts**

In `src/settingsClearDupFiles.ts:78-80`, replace:
```typescript
          plugin.settings.syncConfigDir ?? false,
          plugin.settings.syncBookmarks ?? false,
```
With:
```typescript
          plugin.settings.syncObsidianConfig ?? true,
          plugin.settings.syncThirdPartyPlugins ?? true,
          plugin.settings.syncSelfPlugin ?? true,
          plugin.settings.syncBookmarks ?? false,
          plugin.settings.syncAppearance ?? false,
```

Also update the `checkIsSkipItemOrNotByName` call in this file to pass the new parameters.

- [ ] **Step 4: Update ensembleMixedEnties call in sync.ts**

Ensure the call at `sync.ts:2103` passes the new parameters and `selfPluginId`. The `selfPluginId` should be available from the plugin manifest. Check the function signature where `ensembleMixedEnties` is called and add `selfPluginId`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (all callers now pass correct arguments)

- [ ] **Step 6: Run existing tests**

Run: `npx mocha --import=tsx "tests/**/*.ts"`
Expected: ALL PASS (some tests may need updates if they reference `syncConfigDir`)

- [ ] **Step 7: Commit**

```bash
git add src/fsLocal.ts src/main.ts src/sync.ts src/settingsClearDupFiles.ts
git commit -m "feat: update fsLocal and all callers with new five-toggle parameters"
```

---

### Task 6: Update settings.ts UI

**Files:**
- Modify: `src/settings.ts:1082-1192` (replace sync scope section)
- Modify: `src/settings.ts:466` (remove SyncConfigDirModal usage)
- Modify: i18n files: `src/langs/en.json`, `src/langs/zh_cn.json`, `src/langs/zh_tw.json`

**Interfaces:**
- Consumes: new settings fields
- Produces: UI toggles for `syncObsidianConfig`, `syncThirdPartyPlugins`, `syncSelfPlugin`

- [ ] **Step 1: Add i18n keys**

In `src/langs/en.json`, add after `settings_section_sync_scope`:
```json
  "settings_section_obsidian_sync": "Obsidian Sync",
  "settings_obsidian_config": "Sync Obsidian Config",
  "settings_obsidian_config_desc": "Core settings, snippets, themes, and icons in {configDir}. Device-specific files (workspace, migration state) are always excluded.",
  "settings_third_party_plugins": "Sync Third-Party Plugins",
  "settings_third_party_plugins_desc": "Sync other plugins' code and settings in {configDir}/plugins/. Excludes this plugin. Use ignore paths to exclude specific plugins.",
  "settings_self_plugin": "Sync This Plugin",
  "settings_self_plugin_desc": "Sync this plugin's own code (main.js, manifest.json, styles.css) in {configDir}/plugins/{pluginId}/. Local sync state (data.json) is never synced.",
  "settings_blacklist_notice": "Always excluded: workspace.json, workspace-mobile.json, workspaces.json, core-plugins-migration.json, and this plugin's data.json (device-specific).",
```

In `src/langs/zh_cn.json`:
```json
  "settings_section_obsidian_sync": "Obsidian 同步",
  "settings_obsidian_config": "同步 Obsidian 配置",
  "settings_obsidian_config_desc": "同步 {configDir} 中的核心设置、snippets、主题和图标。设备特定文件（工作区、迁移状态）始终排除。",
  "settings_third_party_plugins": "同步三方插件",
  "settings_third_party_plugins_desc": "同步 {configDir}/plugins/ 中其他插件的代码和设置。排除本插件。可用忽略路径排除特定插件。",
  "settings_self_plugin": "同步本插件",
  "settings_self_plugin_desc": "同步本插件自身的代码（main.js、manifest.json、styles.css）在 {configDir}/plugins/{pluginId}/ 中。本机同步状态（data.json）不会被同步。",
  "settings_blacklist_notice": "始终排除：workspace.json、workspace-mobile.json、workspaces.json、core-plugins-migration.json、本插件的 data.json（设备特定）。",
```

In `src/langs/zh_tw.json`, add the Traditional Chinese equivalents.

- [ ] **Step 2: Replace the sync scope section in settings.ts**

In `src/settings.ts`, replace the section starting at line 1082 (`settings_section_sync_scope` heading) through the `syncBookmarks` setting (around line 1192). Replace the old `syncConfigDir` dropdown and `SyncConfigDirModal` with the new toggles:

```typescript
    containerEl.createEl("h3", {
      text: t("settings_section_obsidian_sync"),
      cls: "rs-subheading",
    });

    // Blacklist notice
    containerEl.createEl("p", {
      text: t("settings_blacklist_notice"),
      cls: "setting-item-description",
    });

    // syncObsidianConfig (default ON)
    new Setting(containerEl)
      .setName(t("settings_obsidian_config"))
      .setDesc(
        t("settings_obsidian_config_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncObsidianConfig ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncObsidianConfig = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncAppearance (keep existing)
    new Setting(containerEl)
      .setName(t("settings_appearance"))
      .setDesc(
        t("settings_appearance_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncAppearance ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncAppearance = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncBookmarks (keep existing)
    new Setting(containerEl)
      .setName(t("settings_bookmarks"))
      .setDesc(
        t("settings_bookmarks_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncBookmarks ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncBookmarks = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncThirdPartyPlugins (default ON)
    new Setting(containerEl)
      .setName(t("settings_third_party_plugins"))
      .setDesc(
        t("settings_third_party_plugins_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncThirdPartyPlugins ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncThirdPartyPlugins = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncSelfPlugin (default ON)
    new Setting(containerEl)
      .setName(t("settings_self_plugin"))
      .setDesc(
        t("settings_self_plugin_desc", {
          configDir: this.app.vault.configDir,
          pluginId: this.manifest.id,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncSelfPlugin ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncSelfPlugin = val === "enable";
            await this.plugin.saveSettings();
          });
      });
```

Keep `syncUnderscoreItems` and `syncDotItems` settings after this section.

- [ ] **Step 3: Remove SyncConfigDirModal**

Remove or comment out the `SyncConfigDirModal` class and its usage (line 466, and the class definition). The new UI no longer needs a confirmation modal since the toggles are independent and non-destructive.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS, deploys to vault

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts src/langs/en.json src/langs/zh_cn.json src/langs/zh_tw.json
git commit -m "feat: add Obsidian sync settings section with five independent toggles"
```

---

### Task 7: Migration tests and final verification

**Files:**
- Create: `tests/obsidianSyncMigration.test.ts`

- [ ] **Step 1: Write migration tests**

```typescript
import { strict as assert } from "assert";

// Simulate the migration logic from main.ts loadSettings()
function migrateSettings(settings: any): any {
  const result = { ...settings };
  if (result.syncConfigDir === true) {
    result.syncObsidianConfig = true;
    result.syncThirdPartyPlugins = true;
    result.syncSelfPlugin = true;
    result.syncConfigDir = false;
  }
  result.syncObsidianConfig ??= true;
  result.syncThirdPartyPlugins ??= true;
  result.syncSelfPlugin ??= true;
  return result;
}

describe("Obsidian sync: backward compat migration", () => {
  it("#41 old syncConfigDir=true migrates to all three on", () => {
    const result = migrateSettings({ syncConfigDir: true });
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
    assert.strictEqual(result.syncConfigDir, false);
  });

  it("#42 old syncConfigDir=false uses new defaults", () => {
    const result = migrateSettings({ syncConfigDir: false });
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
  });

  it("#43 existing new settings preserved", () => {
    const result = migrateSettings({
      syncObsidianConfig: false,
      syncThirdPartyPlugins: false,
      syncSelfPlugin: false,
    });
    assert.strictEqual(result.syncObsidianConfig, false);
    assert.strictEqual(result.syncThirdPartyPlugins, false);
    assert.strictEqual(result.syncSelfPlugin, false);
  });

  it("#44 missing settings get defaults", () => {
    const result = migrateSettings({});
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx mocha --import=tsx "tests/**/*.ts"`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Build and deploy**

Run: `npm run build`
Expected: PASS, deploys to vault

- [ ] **Step 5: Run coverage**

Run: `npx c8 --reporter=text mocha --import=tsx "tests/**/*.ts" 2>&1 | Select-Object -Last 20`
Expected: skipFilter.ts and obsFolderLister-related coverage improved

- [ ] **Step 6: Commit**

```bash
git add tests/obsidianSyncMigration.test.ts
git commit -m "test: add backward compat migration tests for obsidian sync"
```

- [ ] **Step 7: Clean up coverage artifacts**

```bash
Remove-Item -Recurse -Force coverage -ErrorAction SilentlyContinue
Remove-Item -Force coverage_output.txt -ErrorAction SilentlyContinue
```

- [ ] **Step 8: Bump version and push**

Update `package.json`, `manifest.json`, `manifest-beta.json` to `0.6.5`. Add `0.6.5` to `versions.json`. Commit, tag, push:

```bash
git add package.json manifest.json manifest-beta.json versions.json
git commit -m "feat: .obsidian fine-grained sync with five independent toggles (v0.6.5)"
git tag v0.6.5
git push origin master
git push origin v0.6.5
```
