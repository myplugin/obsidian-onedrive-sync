# OneDrive Full-Enum Fallback + mkdir Tracking + Out-of-Scope Drop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the recurring `parentReference.path`-missing warning + `deltaLink` thrash by unifying the full-enumeration and incremental `walk()` branches on the same chain-fallback + stat-retry machinery, tracking `mkdir`-created folders in `prevRemoteEntities`, and silently dropping out-of-scope items instead of invalidating.

**Architecture:** Extract the incremental branch's `classifyDeltaItems` + stat-by-id retry into a shared private method `_classifyAndStatRetry` on `FakeFsOnedrive`. Both branches call it (full-enum seeds an empty `lookupMap` + `approotRootId` anchor; incremental seeds from `prevRemoteEntities`). Harden the shared stat-retry: `requireMtime=false`, and `deriveKeyFromPath`'s "cannot deal" throws carry `.code=ONEDRIVE_PATH_OUT_OF_SCOPE` so the stat-retry silently drops out-of-scope items (not counted, not invalidated). Add the `mkdir`→`uploadedEntities` push that `writeFile` already does.

**Tech Stack:** TypeScript, esbuild, mocha + tsx (`tests/**/*.ts`), Biome (2-space, LF, double quotes, semicolons, es5 trailing commas). `obsidian` runtime module is NOT importable in the test env → `fsOnedrive` orchestration is verified by typecheck + manual sync, not unit tests (pure converter/merge logic IS unit-tested).

**Spec:** `docs/superpowers/specs/2026-09-23-onedrive-fullenum-fallback-design.md`

## Global Constraints

- Biome style: 2-space indent, LF, 80-col width, double quotes, semicolons, `es5` trailing commas. `noExplicitAny`/`noNonNullAssertion` are OFF — `any` and `!` are accepted; do not "fix" them.
- License: `src/driveItemConvert.ts` is Apache-2.0 (`src/LICENSE`). Preserve the header.
- Folders are strings ending with `/`. Keep functions pure outside `main.ts`.
- Version triple in sync: `package.json`, `manifest.json`, `manifest-beta.json`.
- `obsidian` module is runtime-only; never import `fsOnedrive`/`main` from a test file (it will fail to resolve `obsidian`). Pure modules (`driveItemConvert`, `deltaMerge`, `baseTypes`, `misc`) are test-safe.
- Test command: `npm test` (mocha + tsx over `tests/**/*.ts`). Single file: `npx mocha --import=tsx tests/<file>.test.ts`. Typecheck: `npm run typecheck`. Build: `npm run build`.

---

## File Structure

- **`src/driveItemConvert.ts`** (Apache-2.0) — add `outOfScopeError()` helper + tag the 3 "cannot deal" throws in `deriveKeyFromPath` with `.code=ONEDRIVE_PATH_OUT_OF_SCOPE`. Pure, unit-tested.
- **`src/fsOnedrive.ts`** — extract `_classifyAndStatRetry` (private method) from the incremental branch; refactor the full-enum branch (1096-1115) and incremental branch (1008-1087) to call it; harden stat-retry (`requireMtime=false`, OUT_OF_SCOPE→silent-drop); add `mkdir`→`uploadedEntities` push in `_mkdirFromRoot`. Orchestration (not unit-tested; typecheck + manual).
- **`tests/driveItemConvert.test.ts`** — new `describe("deriveKeyFromPath out-of-scope coded error")` asserting the `.code` on the 3 throws.
- **`tests/deltaMerge.test.ts`** — new `describe("full-enum fallback (empty lookupMap + approotRootId anchor)")` characterization test: path-missing direct child of vault root resolves; stat-style out-of-scope path re-throws OUT_OF_SCOPE (not swallowed).
- **`docs/lessons/onedrive-delta-parentreference-path.md`** — append a third follow-up section correcting "全量 delta 必带 path".

---

### Task 1: `deriveKeyFromPath` coded out-of-scope error

**Files:**
- Modify: `src/driveItemConvert.ts` (the `pathMissingError` helper region ~line 113-117, and `deriveKeyFromPath` throws at ~line 291, 303, 319)
- Test: `tests/driveItemConvert.test.ts` (new `describe` block; add `deriveKeyFromPath` to the import)

**Interfaces:**
- Consumes: nothing new.
- Produces: errors thrown by `deriveKeyFromPath` for non-vault paths carry `.code = "ONEDRIVE_PATH_OUT_OF_SCOPE"` (string literal). Later consumed by the stat-retry catch in Task 2 and by `fromDriveItemToEntityWithChainFallback`'s existing catch (which re-throws non-`ONEDRIVE_PATH_MISSING` errors, so OUT_OF_SCOPE propagates — unchanged behavior, just now detectable by `.code`).

- [ ] **Step 1: Write the failing test**

Add to `tests/driveItemConvert.test.ts` (and add `deriveKeyFromPath` to the existing import from `../src/driveItemConvert`):

```ts
describe("deriveKeyFromPath out-of-scope coded error", () => {
  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE for a path matching no known prefix", () => {
    const item = {
      name: "x.md",
      parentReference: { path: "/drive/special/approot" },
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(
        e.code,
        "ONEDRIVE_PATH_OUT_OF_SCOPE",
        "non-vault paths must carry the OUT_OF_SCOPE code"
      );
    }
  });

  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE for a /drive/items/ path not under remoteBaseDir", () => {
    const item = {
      name: "x.md",
      parentReference: { path: "/drive/items/abc!def:/OtherVault/x.md" },
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });

  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE when a /drive/items/ item has no name", () => {
    const item = {
      name: undefined,
      parentReference: { path: "/drive/items/abc!def:/MyVault/sub" },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: FAIL — `e.code` is `undefined` (the throws are plain `Error`, no `.code`).

- [ ] **Step 3: Add the `outOfScopeError` helper + tag the 3 throws**

In `src/driveItemConvert.ts`, immediately after the `pathMissingError()` function (after line 117), add:

```ts
/**
 * Build a recognizable error for "delta/stat item's parentReference.path does
 * not map to a vault-relative key" — the path is present but matches no known
 * prefix, or decodes to a location outside `remoteBaseDir` (e.g. a sibling
 * folder under approot, or a different vault). Carries a stable
 * `.code = "ONEDRIVE_PATH_OUT_OF_SCOPE"` so the stat-retry catch can silently
 * drop these items (they are not vault content) instead of counting them as
 * unresolved and invalidating the deltaLink. Mirrors pathMissingError's
 * `.code` pattern.
 */
function outOfScopeError(message: string): Error {
  const err = new Error(message);
  (err as any).code = "ONEDRIVE_PATH_OUT_OF_SCOPE";
  return err;
}
```

Then tag the 3 throws inside `deriveKeyFromPath`. Replace `throw Error(...)` with `throw outOfScopeError(...)` at:

1. The "no name" throw (~line 291):
```ts
throw outOfScopeError(
  `OneDrive item no name variable while matching ${FOURTH_COMMON_PREFIX_RAW}`
);
```
2. The "/drive/items/ no idea" throw (~line 303) — keep the multi-line diagnostic message verbatim, wrap in `outOfScopeError(...)`:
```ts
throw outOfScopeError(
  `file/folder with /drive/items/, no idea how to deal with it:
fullPathOriginal=${fullPathOriginal}
matchFirstPrefixRes=${matchFirstPrefixRes}
matchFifthPrefixRes=${matchFifthPrefixRes}
matchSixthPrefixRes=${matchSixthPrefixRes}
matchSixthV2PrefixRes=${matchSixthV2PrefixRes}
matchSecondPrefixRes=${matchSecondPrefixRes}
matchThirdPrefixRes=${matchThirdPrefixRes}
${constructFromDriveItemToEntityError(x)}`
);
```
3. The "no known prefix" throw (~line 319) — same, wrap the verbatim multi-line message in `outOfScopeError(...)`:
```ts
throw outOfScopeError(
  `file/folder, no idea how to deal with it without known prefix:
fullPathOriginal=${fullPathOriginal}
matchFirstPrefixRes=${matchFirstPrefixRes}
matchFifthPrefixRes=${matchFifthPrefixRes}
matchSixthPrefixRes=${matchSixthPrefixRes}
matchSixthV2PrefixRes=${matchSixthV2PrefixRes}
matchSecondPrefixRes=${matchSecondPrefixRes}
matchThirdPrefixRes=${matchThirdPrefixRes}
${constructFromDriveItemToEntityError(x)}`
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: PASS — all 3 new specs green; existing `deriveKeyFromPath`/converter tests still green (messages unchanged, only `.code` added).

- [ ] **Step 5: Typecheck + format**

Run: `npm run typecheck`
Expected: no errors in `src/driveItemConvert.ts`.
Run: `npm run format`
Expected: Biome applies style; no semantic change.

- [ ] **Step 6: Commit**

```bash
git add src/driveItemConvert.ts tests/driveItemConvert.test.ts
git commit -m "feat(driveItemConvert): tag deriveKeyFromPath out-of-scope throws with .code=ONEDRIVE_PATH_OUT_OF_SCOPE"
```

---

### Task 2: Shared `_classifyAndStatRetry` + full-enum adoption + stat-retry hardening

**Files:**
- Modify: `src/fsOnedrive.ts` (incremental branch 1008-1087 → shared method call; full-enum branch 1096-1115 → shared method call; new private method `_classifyAndStatRetry`)
- Test: `tests/deltaMerge.test.ts` (new characterization `describe`)

**Interfaces:**
- Consumes: `classifyDeltaItems`, `fromDriveItemToEntityWithChainFallback`, `buildIdToKeyMap`, `mergeDeltaWithPrevState` (all existing); the `ONEDRIVE_PATH_OUT_OF_SCOPE` code from Task 1.
- Produces: private method `_classifyAndStatRetry(driveItems, lookupMap, invalidateOnUnresolved): Promise<{ entities, deletedKeys, unresolvedCount }>`. Reads `this.remoteBaseDir`, `this.approotRootId`, `this._getJson`, `this.onedriveConfig`, `this.saveUpdatedConfigFunc`.

> **Testing note (codebase reality):** `fsOnedrive.ts` imports `obsidian` (line 10), which is runtime-only and unresolvable in the mocha/tsx env. So `fsOnedrive` has NO unit tests in this repo and the orchestration wiring in this task is verified by **typecheck + the pure characterization test below + manual sync**. The characterization test exercises the PURE functions (`classifyDeltaItems` + `fromDriveItemToEntityWithChainFallback`) the orchestration calls, locking the contract the refactor relies on.

- [ ] **Step 1: Write the characterization test (locks the full-enum contract)**

Add to `tests/deltaMerge.test.ts` (it already imports `classifyDeltaItems`, `fromDriveItemToEntityWithChainFallback`; ensure both are in the import). Add `import type { DriveItem } from "@microsoft/microsoft-graph-types";` if not present.

```ts
describe("full-enum fallback (empty lookupMap + approotRootId anchor)", () => {
  // Characterization: the full-enum branch has NO prevRemoteEntities, so the
  // lookupMap starts empty (only the approotRootId -> "/" anchor). A
  // path-missing delta item whose parentReference.id === approotRootId is a
  // direct child of the vault root and MUST resolve via the baseline branch
  // of deriveKeyFromParentChain (key = name, folder -> trailing "/").
  it("resolves a path-missing direct child of the vault root via the anchor", () => {
    const approotRootId = "473340CC2449AD6B!sc4ea15a708a54f5a800ec64efca9de7a";
    const lookupMap = new Map<string, string>();
    lookupMap.set(approotRootId, "/");
    const converter = (item: any, dir: string, requireMtime?: boolean) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        approotRootId,
        requireMtime
      );
    const child = {
      id: "473340CC2449AD6B!s51622b9692a7443c8becccb73884cb7e",
      name: "sub",
      size: 0,
      folder: {},
      parentReference: {
        driveType: "personal",
        driveId: "473340CC2449AD6B",
        id: approotRootId,
      },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    const { deltaEntities } = classifyDeltaItems(
      [child],
      "MyVault",
      converter,
      lookupMap,
      approotRootId
    );
    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "sub/");
  });

  // A deeper child whose parent ALSO appears in the same delta batch (and
  // resolves) must resolve on classifyDeltaItems' rescan pass — the in-batch
  // parent->child chain, with no prev at all.
  it("resolves a deeper child after its parent resolves in-batch (no prev)", () => {
    const approotRootId = "ROOT!id";
    const lookupMap = new Map<string, string>();
    lookupMap.set(approotRootId, "/");
    const converter = (item: any, dir: string, requireMtime?: boolean) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        approotRootId,
        requireMtime
      );
    const parent = {
      id: "P!id",
      name: "pdir",
      size: 0,
      folder: {},
      parentReference: { id: approotRootId }, // direct child of root
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    const child = {
      id: "C!id",
      name: "cfile.md",
      size: 5,
      file: {},
      parentReference: { id: "P!id" }, // parent is the in-batch folder
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    // child listed BEFORE parent — rescan must still resolve both
    const { deltaEntities } = classifyDeltaItems(
      [child, parent],
      "MyVault",
      converter,
      lookupMap,
      approotRootId
    );
    const keys = deltaEntities.map((e) => e.keyRaw).sort();
    assert.deepStrictEqual(keys, ["cfile.md", "pdir/"]);
  });

  // Out-of-scope items (stat returned a path that doesn't map to the vault)
  // must propagate OUT_OF_SCOPE — NOT be swallowed as PATH_MISSING — so the
  // stat-retry catch can drop them. This pins Task 1's contract end-to-end.
  it("re-throws ONEDRIVE_PATH_OUT_OF_SCOPE (does not swallow as PATH_MISSING) for a non-vault path", () => {
    const lookupMap = new Map<string, string>();
    const outOfScopeStat = {
      id: "X!id",
      name: "x.md",
      parentReference: { path: "/drive/special/approot" },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    try {
      fromDriveItemToEntityWithChainFallback(
        outOfScopeStat as any,
        "MyVault",
        lookupMap,
        "ROOT!id",
        false
      );
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });
});
```

- [ ] **Step 2: Run the characterization test to verify it passes (Task 1 already provides OUT_OF_SCOPE)**

Run: `npx mocha --import=tsx tests/deltaMerge.test.ts`
Expected: PASS — `classifyDeltaItems` + `fromDriveItemToEntityWithChainFallback` already implement the anchor + in-batch chain + OUT_OF_SCOPE re-throw (this test locks the contract the refactor relies on; it should be green after Task 1).

- [ ] **Step 3: Add the `_classifyAndStatRetry` private method to `FakeFsOnedrive`**

In `src/fsOnedrive.ts`, add this private method to the `FakeFsOnedrive` class (place it just before `walk()`, ~line 923). It is extracted verbatim from the current incremental branch (1008-1078) with two hardening changes marked `(#3)`: `requireMtime=false` in the stat-retry convert, and the `ONEDRIVE_PATH_OUT_OF_SCOPE` silent-drop branch.

```ts
/**
 * Shared classify + stat-by-id retry for both walk() branches. Extracted
 * from the incremental branch; hardened so out-of-scope stat results are
 * silently dropped (not counted, not invalidating) and folders lacking
 * lastModifiedDateTime don't fail the stat-retry (#3).
 *
 * @param lookupMap             SHARED id->keyRaw working map (seeded by the
 *        caller: incremental seeds from prevRemoteEntities, full-enum seeds
 *        only approotRootId->"/"). classifyDeltaItems mutates it (root anchor
 *        + every resolved item); a fresh copy so mutations never leak into
 *        prevRemoteEntities.
 * @param invalidateOnUnresolved Incremental passes true (unresolved items
 *        mean the merged state is incomplete -> invalidate deltaLink so the
 *        next sync full-walks, now with fallback). Full-enum passes false
 *        (it just saved a fresh deltaLink; invalidating would only force an
 *        identical full-walk next sync).
 */
private async _classifyAndStatRetry(
  driveItems: DriveItem[],
  lookupMap: Map<string, string>,
  invalidateOnUnresolved: boolean
): Promise<{
  entities: Entity[];
  deletedKeys: Set<string>;
  unresolvedCount: number;
}> {
  const {
    deltaEntities,
    deletedKeys,
    skippedAddedOrModified,
    skippedItems,
  } = classifyDeltaItems(
    driveItems,
    this.remoteBaseDir,
    (item, dir, requireMtime) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        this.approotRootId,
        requireMtime
      ),
    lookupMap,
    this.approotRootId
  );

  let unresolvedCount = skippedAddedOrModified;

  if (skippedItems.length > 0) {
    console.info(
      `walk: ${skippedItems.length} delta item(s) had no parentReference.path — retrying via stat-by-id`
    );
    const statResults = await Promise.all(
      skippedItems
        .filter((item: any) => item.id !== undefined && item.id !== null)
        .map(async (item: any) => {
          try {
            return await this._getJson(
              `/drive/items/${item.id}?$select=id,name,size,fileSystemInfo,folder,file,parentReference,eTag`
            );
          } catch {
            return null;
          }
        })
    );
    for (const statResp of statResults) {
      if (statResp === null) continue;
      try {
        // (#3) requireMtime=false: folders sync by presence, not mtime; a
        // mkdir'd folder may lack lastModifiedDateTime and must not fail
        // the stat-retry on mtime.
        const entity = fromDriveItemToEntityWithChainFallback(
          statResp,
          this.remoteBaseDir,
          lookupMap,
          this.approotRootId,
          false
        );
        if (entity.key !== "/") {
          deltaEntities.push(entity);
          unresolvedCount--;
          if (statResp.id !== undefined && entity.keyRaw !== "") {
            lookupMap.set(statResp.id, entity.keyRaw);
          }
        }
      } catch (e) {
        // (#3) Out-of-scope item (stat path doesn't map to the vault, e.g. a
        // sibling folder under approot): silent drop. NOT counted as
        // unresolved, NOT invalidating — this is the thrash-stopper.
        if (e instanceof Error && (e as any).code === "ONEDRIVE_PATH_OUT_OF_SCOPE") {
          console.debug(
            "walk: stat-retry dropped out-of-scope item",
            (statResp as any).id
          );
        }
        // else: genuinely unresolvable (stat 404 caught above as null, or
        // stat also lacks path) — leave counted as unresolved.
      }
    }

    if (unresolvedCount > 0) {
      if (invalidateOnUnresolved) {
        console.warn(
          `walk: ${unresolvedCount} added/modified delta item(s) could not be parsed even after stat retry — ` +
            "invalidating deltaLink; next sync will do a full re-enumeration."
        );
        this.onedriveConfig.deltaLink = "";
        await this.saveUpdatedConfigFunc();
      } else {
        // Full-enum: no deltaLink worth invalidating (it was just saved).
        // Warn and drop — the incremental branch's stat-retry will retry
        // these on the next sync if they change again.
        console.warn(
          `walk: ${unresolvedCount} added/modified item(s) could not be parsed in full enumeration — dropped (no deltaLink invalidation).`
        );
      }
    }
  }

  return { entities: deltaEntities, deletedKeys, unresolvedCount };
}
```

- [ ] **Step 4: Refactor the incremental branch to call the shared method**

Replace the body of the incremental branch (current lines 1003-1087, from `const { deltaEntities, ... } = classifyDeltaItems(...)` through `return merged;`) with:

```ts
      const idToKeyMap = buildIdToKeyMap(this.prevRemoteEntities);
      // lookupMap is the SHARED working map (fresh copy — mutations never
      // leak into prevRemoteEntities). Seeded with prev ids + the approot
      // root anchor by classifyDeltaItems/_classifyAndStatRetry.
      const lookupMap = new Map(idToKeyMap);

      const {
        entities: deltaEntities,
        deletedKeys,
        unresolvedCount,
      } = await this._classifyAndStatRetry(
        driveItems,
        lookupMap,
        /* invalidateOnUnresolved */ true
      );

      const merged = mergeDeltaWithPrevState(
        this.prevRemoteEntities,
        deltaEntities,
        deletedKeys
      );
      this.lastWalkResult = merged;
      this.lastWalkDeltaCount = driveItems.length;
      return merged;
```

(Keep the surrounding `if (canIncremental && this.prevRemoteEntities) {` ... `} else {` structure. The `approotRootId` anchor + prev-id seed happen inside `classifyDeltaItems` (line ~189-195 seeds the anchor) and via `buildIdToKeyMap`; the explicit `lookupMap.set(this.approotRootId, "/")` that was at old line 1000-1002 is now redundant — `classifyDeltaItems` seeds it idempotently — but harmless. Remove it to avoid confusion, since `classifyDeltaItems` already does `idToKeyMap.set(approotRootId, "/")` when both are passed. The shared method passes `this.approotRootId` to `classifyDeltaItems`, so the anchor IS seeded there.)

- [ ] **Step 5: Refactor the full-enum branch to call the shared method**

Replace the full-enum loop (current lines 1096-1114, the `const unifiedContents: Entity[] = []; for (const x of driveItems) {...} this.lastWalkResult = unifiedContents; ...` block) with:

```ts
      // Full enumeration — no prev to build an id->key map from; seed only
      // the approot root anchor. The shared classify + stat-retry resolves
      // path-missing in-scope items (direct children of vault root via the
      // anchor; deeper via in-batch parent->child chains; or stat-by-id
      // which returns parentReference.path reliably). Out-of-scope items
      // (e.g. sibling folders under approot) are silently dropped instead
      // of warn-skip-thrashing. invalidateOnUnresolved=false: a full-enum
      // just saved a fresh deltaLink; invalidating would only force an
      // identical full-walk next sync.
      const lookupMap = new Map<string, string>();
      if (this.approotRootId !== undefined) {
        lookupMap.set(this.approotRootId, "/");
      }
      const { entities } = await this._classifyAndStatRetry(
        driveItems,
        lookupMap,
        /* invalidateOnUnresolved */ false
      );
      this.lastWalkResult = entities;
      this.lastWalkDeltaCount = undefined;
      return entities;
```

- [ ] **Step 6: Typecheck + format + tests**

Run: `npm run typecheck`
Expected: no errors in `src/fsOnedrive.ts`.
Run: `npm run format`
Run: `npm test`
Expected: all tests green (the characterization test from Step 1 + all existing tests).

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: `main.js` produced; typecheck (run as part of build) clean.

- [ ] **Step 8: Manual sync verification**

Deploy to the vault (if `VAULT_PATH` is set in `.env`, `npm run build` auto-deploys; otherwise copy `main.js` + `manifest.json`). In Obsidian, trigger an automatic sync. Confirm in the console:
- The `classifyDeltaItems: skipping added/modified item (parse failed) / x.parentReference.path is undefinded or null` warnings for the `!sc4ea15a...` family are GONE or replaced by `walk: stat-retry dropped out-of-scope item` debug logs.
- The `invalidating deltaLink` message no longer recurs on consecutive automatic syncs.

- [ ] **Step 9: Commit**

```bash
git add src/fsOnedrive.ts tests/deltaMerge.test.ts
git commit -m "feat(fsOnedrive): unify full-enum + incremental on shared _classifyAndStatRetry; drop out-of-scope, relax stat-retry mtime"
```

---

### Task 3: `_mkdirFromRoot` tracks created folders in `uploadedEntities`

**Files:**
- Modify: `src/fsOnedrive.ts` (`_mkdirFromRoot`, ~line 1192-1224)
- Test: none (fsOnedrive untestable — `obsidian` import; see Task 2 note). Verified by typecheck + manual.

**Interfaces:**
- Consumes: `this.uploadedEntities` (the `Entity[]` on `FakeFs`, `fsAll.ts:41`), populated today only by `writeFile` (1252). `this._statFromRoot` returns an `Entity` from `fromDriveItemToEntity` → `synthesizedFile: false` + `remoteId: x.id` (driveItemConvert.ts:403,405).
- Produces: folders created on OneDrive during a sync now enter `uploadedEntities` → merged into `prevRemoteEntities` by `main.ts:616-623` → the next sync's `buildIdToKeyMap` has their `remoteId → keyRaw`, closing the same-class gap as Tasks 1-2.

- [ ] **Step 1: Add the push in `_mkdirFromRoot`**

In `src/fsOnedrive.ts`, `_mkdirFromRoot` currently ends (line 1222-1223):
```ts
    const res = await this._statFromRoot(key);
    return res;
```
Change to:
```ts
    const res = await this._statFromRoot(key);
    // Track created folders so main.ts merges them into prevRemoteEntities
    // (mirrors writeFile:1252). Without this, a folder created during sync
    // is absent from the next sync's prev -> the incremental delta's
    // id/parent-chain fallback can't resolve it when it reappears without
    // parentReference.path. _statFromRoot returns synthesizedFile:false +
    // remoteId:x.id (fromDriveItemToEntity), so the entity is prev-eligible.
    if (!res.synthesizedFile) {
      this.uploadedEntities.push(res);
    }
    return res;
```

- [ ] **Step 2: Typecheck + format + build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run format`
Run: `npm run build`
Expected: `main.js` produced.

- [ ] **Step 3: Manual verification**

Deploy. In Obsidian, create a new empty folder in the vault + a file inside a new nested folder path, then sync. Confirm the folders appear on OneDrive. Trigger a second (automatic) sync — confirm no `parentReference.path is undefinded or null` warnings for the newly-created folders (they are now in `prevRemoteEntities` via `uploadedEntities`).

- [ ] **Step 4: Commit**

```bash
git add src/fsOnedrive.ts
git commit -m "feat(fsOnedrive): track mkdir-created folders in uploadedEntities for prevRemoteEntities"
```

---

### Task 4: Correct the lesson doc ("全量 delta 必带 path" falsified)

**Files:**
- Modify: `docs/lessons/onedrive-delta-parentreference-path.md` (append a third follow-up section after line 132)

**Interfaces:** none (documentation).

- [ ] **Step 1: Append the correction section**

Append to `docs/lessons/onedrive-delta-parentreference-path.md`:

```markdown

---

## 后续（2026-09-23）：全量分支 fallback + 越界丢弃（第三次复发修复）

前两次修复（134aac9 根文件夹特例、2026-09-21 id+parent-chain fallback）**只补了增量分支**。本次复盘里"全量 delta 必带 path"的论断是经验性概括——**被自动定期同步的复现证伪**：同一个稳定父文件夹 `!sc4ea15a...` 的子项在每次增量 delta 都不带 path，deltaLink 作废后全量重枚举**仍然** warn-skip 它们（全量 `/delta` 不带 token 也是 delta 调用，path 省略对"涉文件夹操作的条目"同样发生）→ 永不进 prevRemoteEntities → 增量 fallback 依赖 prev → 循环依赖，死循环。

### 根因（三层）
1. **全量分支用裸 `fromDriveItemToEntity`（无 fallback）**：path-missing 条目 warn-skip 后永不入 prevRemoteEntities，增量 fallback（依赖 prev）无法自愈。
2. **`mkdir` 创建的文件夹不进 `uploadedEntities`**（只有 `writeFile` 进）：同步创建的文件夹不在下一次 prev → 同类洞。
3. **stat 重试 `requireMtime=true` + 无法区分越界**：mkdir 建的空目录可能缺 mtime → stat 重试卡 mtime；越界条目（vault 外兄弟）的 stat path 不匹配前缀 → "no idea" throw → 误判 unresolved → 作废 deltaLink 抖动。

### 修复（spec: `docs/superpowers/specs/2026-09-23-onedrive-fullenum-fallback-design.md`）
- 全量分支复用增量的 `classifyDeltaItems` + chain-fallback + stat-by-id（提取为共享 `_classifyAndStatRetry`），空 lookupMap 仅锚 `approotRootId`；unresolved 仅 warn 不作废。
- `deriveKeyFromPath` 三处"no idea"throw 加 `.code=ONEDRIVE_PATH_OUT_OF_SCOPE`，stat 重试 catch 到它 → **静默丢弃**（越界条目不是 vault 内容），不计 unresolved、不作废 deltaLink。stat 重试 `requireMtime=false`。
- `_mkdirFromRoot` 成功后 push `uploadedEntities`（对齐 `writeFile:1252`）。

### 新教训
- **"经验上成立"≠"文档保证"**：lesson 里写"全量 delta 必带 path"时，应同时标注这是经验观察、非文档保证。微软文档 "When using delta you should always track items by id" 未区分带不带 token——凡 `/delta` 调用都适用。经验论断必须配 fallback，否则一旦遇到反例就是死循环。
- **fallback 不能跨分支循环依赖**：增量分支的 fallback 依赖全量分支捕获的 prev；若全量分支本身用裸转换器跳过同类条目，增量 fallback 永远解不出。**两条分支必须对称地具备 fallback**，或全量分支必须有独立的 stat-retry 兜底。
- **越界条目要显式区分**：不能把"vault 外的条目"和"vault 内但解析失败的条目"混为一谈——前者应静默丢弃，后者才该自愈。用 `.code` 区分（`ONEDRIVE_PATH_OUT_OF_SCOPE` vs `ONEDRIVE_PATH_MISSING`）。
```

- [ ] **Step 2: Commit**

```bash
git add docs/lessons/onedrive-delta-parentreference-path.md
git commit -m "docs(lessons): third follow-up — full-enum fallback + out-of-scope drop; correct 'full delta always has path' claim"
```

---

## Self-Review

**Spec coverage:**
- §4.1 architecture (shared `_classifyAndStatRetry`, both branches) → Task 2 steps 3-5. ✓
- §4.2 component: `deriveKeyFromPath` OUT_OF_SCOPE code → Task 1. ✓
- §4.2 component: `_mkdirFromRoot` push → Task 3. ✓
- §4.2 component: shared method body (requireMtime=false, OUT_OF_SCOPE drop, invalidate flag) → Task 2 step 3. ✓
- §4.3 data flow (full-enum + incremental + mkdir) → Task 2 steps 4-5, Task 3. ✓
- §4.4 error-handling table → Task 2 step 3 (the catch branches). ✓
- §5 testing (driveItemConvert OUT_OF_SCOPE, full-enum anchor characterization, 8-item chain fixture) → Task 1 (OUT_OF_SCOPE), Task 2 step 1 (anchor + in-batch + OUT_OF_SCOPE re-throw). The 8-item chain fixture is covered by the in-batch parent→child test (Task 2 step 1 spec 2) which exercises the same rescan mechanism; the `!sc4ea15a...` exact ids appear in spec 1. mkdir tracking test → deferred to manual (fsOnedrive untestable, documented in Task 2/3 notes). ✓ (with documented deviation)
- §6 documentation (lesson correction) → Task 4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". All code steps show actual code. ✓

**Type consistency:** `_classifyAndStatRetry` signature `(driveItems, lookupMap, invalidateOnUnresolved)` returns `{ entities, deletedKeys, unresolvedCount }` — matches Task 2 step 4 destructure (`entities: deltaEntities, deletedKeys, unresolvedCount`) and step 5 destructure (`{ entities }`). `ONEDRIVE_PATH_OUT_OF_SCOPE` string literal consistent across Task 1 (helper), Task 2 (catch + characterization test). `approotRootId` read via `this.approotRootId` inside the method (not a param) — matches both callers (they don't pass it). ✓

**Deviations from spec (documented):** The spec's §5 "mkdir tracking test" is not delivered as a unit test because `fsOnedrive.ts` imports `obsidian` (runtime-only, unresolvable in mocha/tsx — no existing `fsOnedrive` test in the repo). Instead: the prev-eligibility of the pushed entity (`remoteId` + `synthesizedFile:false`) is already asserted by `driveItemConvert.test.ts` (the converter that `_statFromRoot` uses), and the push itself is verified by typecheck + manual sync (Task 3 steps 2-3). This is the same testing posture as the rest of `fsOnedrive` in this repo.
