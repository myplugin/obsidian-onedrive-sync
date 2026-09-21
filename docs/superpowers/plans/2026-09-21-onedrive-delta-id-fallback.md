# OneDrive Delta `id`-Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `parentReference.path` is missing for a non-root OneDrive delta item, reconstruct the vault-relative `key` from the item's Graph `id` via a prev-state `id→key` map — instead of throwing + skipping + self-healing.

**Architecture:** Additive id-fallback at the delta seam. Split the converter `fromDriveItemToEntity` into `extractDriveItemMetadata` (path-independent, throws only on missing-mtime) + `deriveKeyFromPath` (throws on path-missing) + an `id`-lookup fallback variant. `classifyDeltaItems` gains an optional `idToKeyMap`; `walk()` builds it from `prevRemoteEntities`. Path-derivation is **unchanged** when `path` is present. Additive, behavior-preserving.

**Tech Stack:** TypeScript, esbuild, mocha + tsx, Biome (2-space/LF/80-col/double-quote/semicolon/es5-trailing-comma; `noExplicitAny`/`noNonNullAssertion` OFF — do not "fix" `any`/`!`).

**Spec:** `docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md`

## Global Constraints

- **License:** Touched files (`baseTypes.ts`, `driveItemConvert.ts`, `deltaMerge.ts`, `fsOnedrive.ts`) are all Apache-2.0. Do NOT touch PolyForm files (`sync.ts`, `conflictLogic.ts`, `fileContentHistory.ts`, `clearDupFiles.ts`, `settingsClearDupFiles.ts`).
- **`syncOptimize.ts` is NOT modified** — `id` is already in `DELTA_SELECT` (`$select=id,name,size,fileSystemInfo,folder,file,parentReference,eTag`).
- **Behavior-preservation is load-bearing** — the converter split MUST preserve the exact throw order (approot-root → remoteItem/package → path-missing → mtime) so all existing `tests/driveItemConvert.test.ts` + `tests/deltaMerge.test.ts` cases stay green.
- **No commits unless the user has approved the per-task commit flow.** (AGENTS.md: commit only on request. The If-Match SDD established per-task commits as the agreed flow — confirm with the controller before committing.)
- Commands: `npm test` (full suite), `npx mocha --import=tsx tests/<file>.test.ts` (single), `npm run typecheck` (`tsc -noEmit -skipLibCheck`).

## File Structure

- **Modify** `src/baseTypes.ts` — `Entity` gains `remoteId?: string` (Graph `driveItem.id`).
- **Modify** `src/driveItemConvert.ts` — split converter; add `extractDriveItemMetadata`, `deriveKeyFromPath`, `fromDriveItemToEntityWithIdFallback`; populate `remoteId` on all paths.
- **Modify** `src/deltaMerge.ts` — `classifyDeltaItems` gains optional `idToKeyMap`; add pure `buildIdToKeyMap` helper.
- **Modify** `src/fsOnedrive.ts` — `walk()` incremental branch builds the map + passes it to `classifyDeltaItems`.
- **Test** `tests/driveItemConvert.test.ts` — remoteId assertion + fallback-variant tests.
- **Test** `tests/deltaMerge.test.ts` — classifyDeltaItems with real converter + idToKeyMap; buildIdToKeyMap unit test.

---

### Task 1: Split converter + populate `remoteId` (behavior-preserving refactor)

**Files:**
- Modify: `src/baseTypes.ts:184-203` (Entity interface)
- Modify: `src/driveItemConvert.ts:55-361` (split into helpers; keep `fromDriveItemToEntity` signature + behavior, now also sets `remoteId`)
- Test: `tests/driveItemConvert.test.ts`

**Interfaces:**
- Produces: `extractDriveItemMetadata(x, requireMtime=true) → { mtimeSvr, mtimeCli, ctimeCli, size, sizeRaw, etag, remoteId, isFolder }` (throws ONLY on missing mtime when `requireMtime`).
- Produces: `deriveKeyFromPath(x, remoteBaseDir) → string` (throws on path-missing; returns key WITH folder suffix).
- Produces: `Entity.remoteId?: string`.
- `fromDriveItemToEntity` signature unchanged; behavior unchanged except it now sets `remoteId`.

- [ ] **Step 1: Write the failing test (remoteId populated)**

Append to `tests/driveItemConvert.test.ts`, inside the existing `describe("fromDriveItemToEntity", ...)` block, after the eTag test (line 196):

```typescript
  it("populates remoteId from driveItem.id", () => {
    const e = fromDriveItemToEntity(normalFile as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.remoteId, "d!123");
  });

  it("populates remoteId on the approot root entity too", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntity(rootItem as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.key, "/");
    assert.strictEqual(e.remoteId, "d!s1");
  });
```

Also add `remoteId` to the existing `normalFile`-convert test's assertions (the "converts a normal file" test, line 93-100) — append `assert.strictEqual(e.remoteId, "d!123");`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: FAIL — `e.remoteId` is `undefined` (field doesn't exist on Entity yet). The existing tests still PASS (the refactor isn't done yet, but `remoteId` assertion is the new red).

- [ ] **Step 3: Add `remoteId` to Entity + refactor the converter**

In `src/baseTypes.ts`, add to the `Entity` interface (after `etag?: string;`, line 200):

```typescript
  /** Graph driveItem.id — stable opaque id used by the delta id-fallback
   *  (see docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md).
   *  Undefined for entities that predate the field or came from walkPartial. */
  remoteId?: string;
```

In `src/driveItemConvert.ts`, refactor `fromDriveItemToEntity` (currently lines 85-360) into three functions. **The exact throw order (approot-root → remoteItem/package → path-missing → mtime) MUST be preserved** so existing tests stay green. Replace the body of `fromDriveItemToEntity` and add two new exported helpers above it:

```typescript
/**
 * Extract path-independent metadata from a Graph DriveItem. PURE.
 * Throws ONLY on missing lastModifiedDateTime when requireMtime=true.
 * Does NOT throw on missing parentReference.path (that's deriveKeyFromPath's
 * job) and does NOT check remoteItem/package (the caller does, to preserve
 * the historical throw order).
 */
export const extractDriveItemMetadata = (
  x: DriveItem,
  requireMtime = true
) => {
  const isFolder = "folder" in x;
  const mtimeTry = x?.fileSystemInfo?.lastModifiedDateTime;
  if (requireMtime && (mtimeTry === undefined || mtimeTry === null)) {
    throw Error(`onedrive cannot parse mtime: ${JSON.stringify(x, null, 2)}`);
  }
  let ctimeTry = x?.fileSystemInfo?.createdDateTime;
  if (ctimeTry === undefined || ctimeTry === null) {
    ctimeTry = mtimeTry;
  }
  const mtimeSvr = mtimeTry ? Date.parse(mtimeTry) : undefined;
  return {
    mtimeSvr,
    mtimeCli: mtimeSvr,
    ctimeCli: ctimeTry ? Date.parse(ctimeTry) : mtimeSvr,
    size: isFolder ? 0 : x.size!,
    sizeRaw: isFolder ? 0 : x.size!,
    etag: x.eTag ?? undefined,
    remoteId: (x as any).id,
    isFolder,
  };
};

/**
 * Derive the vault-relative key from parentReference.path + name. PURE.
 * Throws on missing parentReference.path (the approot root folder is
 * handled by the caller via isApprootRootDriveItem, NOT here). Returns the
 * key WITH a trailing slash when the item is a folder.
 *
 * The regex/prefix logic below is moved VERBATIM from the previous
 * fromDriveItemToEntity body (lines 109-329 of the pre-refactor file);
 * do not alter the matching branches.
 */
export const deriveKeyFromPath = (
  x: DriveItem,
  remoteBaseDir: string
): string => {
  if (
    x.parentReference === undefined ||
    x.parentReference === null ||
    x.parentReference.path === undefined ||
    x.parentReference.path === null
  ) {
    throw Error("x.parentReference.path is undefinded or null");
  }

  // === BEGIN verbatim key-derivation (was lines 109-329) ===
  let key = "";
  const FIRST_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/remotely-save\//g;
  const FIFTH_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/Graph\//g;
  const SIXTH_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/Graph 1\//g;
  const SIXTH_COMMON_PREFIX_REGEX_V2 = /^\/drive\/root:\/[^\/]+\/Graph%201\//g;
  const SECOND_COMMON_PREFIX_REGEX = /^\/Livefolders\/[^\/]+\/remotely-save\//g;
  const THIRD_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/app\/remotely-save\//g;
  const FOURTH_COMMON_PREFIX_RAW = `/drive/items/`;
  const remoteBaseDirEncoded = encodeURIComponent(remoteBaseDir);
  const fullPathOriginal = `${x.parentReference.path}/${x.name}`;
  const matchFirstPrefixRes = fullPathOriginal.match(FIRST_COMMON_PREFIX_REGEX);
  const matchFifthPrefixRes = fullPathOriginal.match(FIFTH_COMMON_PREFIX_REGEX);
  const matchSixthPrefixRes = fullPathOriginal.match(SIXTH_COMMON_PREFIX_REGEX);
  const matchSixthV2PrefixRes = fullPathOriginal.match(SIXTH_COMMON_PREFIX_REGEX_V2);
  const matchSecondPrefixRes = fullPathOriginal.match(SECOND_COMMON_PREFIX_REGEX);
  const matchThirdPrefixRes = fullPathOriginal.match(THIRD_COMMON_PREFIX_REGEX);
  // (all the if/else branches from the original follow IDENTICALLY — copy
  //  lines 178-324 of the pre-refactor file here, unchanged. They assign
  //  `key` for each known prefix. The /drive/items/ branch and the final
  //  `else { throw }` are included verbatim.)
  //
  // ... [PASTE THE if/else-if chain from the original lines 178-324] ...
  //
  // NOTE to implementer: the original lines 178-324 are the 7 prefix
  // branches + the /drive/items/ branch + the final throw. Copy them
  // exactly; only the surrounding structure changed (moved into this fn).
  // After this block, `key` is set for a matched prefix.

  const isFolder = "folder" in x;
  if (isFolder) {
    key = `${key}/`;
  }
  return key;
};

/**
 * Convert a Graph DriveItem into the plugin's Entity. Behavior-preserving
 * refactor: now delegates to extractDriveItemMetadata + deriveKeyFromPath.
 * Throws on the same shapes as before, in the same order:
 *   1. approot root → early-return minimal entity (key "/")
 *   2. remoteItem / package / bundle → throw
 *   3. missing parentReference.path (non-root) → throw
 *   4. missing mtime (requireMtime=true) → throw
 * NEW: always sets remoteId from driveItem.id.
 */
export const fromDriveItemToEntity = (
  x: DriveItem,
  remoteBaseDir: string,
  requireMtime = true
): Entity => {
  // 1. approot root → minimal entity (before metadata; root may lack mtime)
  if (isApprootRootDriveItem(x, remoteBaseDir)) {
    return {
      key: "/",
      keyRaw: "/",
      mtimeSvr: undefined,
      mtimeCli: undefined,
      ctimeCli: undefined,
      size: 0,
      sizeRaw: 0,
      synthesizedFile: false,
      remoteId: (x as any).id,
    };
  }
  // 2. remoteItem / package / bundle (before path, preserving order)
  if ("remoteItem" in x) {
    throw Error(
      "driveItem carries remoteItem (shared item) — not supported in approot sync"
    );
  }
  if ("package" in x || "bundle" in x) {
    throw Error(
      "driveItem is a package/bundle — neither file nor folder, not supported in approot sync"
    );
  }
  // 3. path derivation (throws on path-missing, BEFORE mtime)
  const key = deriveKeyFromPath(x, remoteBaseDir);
  // 4. metadata (throws on missing mtime, AFTER path)
  const meta = extractDriveItemMetadata(x, requireMtime);
  return {
    key,
    keyRaw: key,
    mtimeSvr: meta.mtimeSvr,
    mtimeCli: meta.mtimeCli,
    ctimeCli: meta.ctimeCli,
    size: meta.size,
    sizeRaw: meta.sizeRaw,
    synthesizedFile: false,
    etag: meta.etag,
    remoteId: meta.remoteId,
  };
};
```

The `constructFromDriveItemToEntityError` helper (lines 55-59) stays. `isApprootRootDriveItem` (32-53) stays unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: ALL PASS — the two new remoteId assertions green, AND every existing test (normal file, folder, approot root, path-less throws, missing-mtime throws, requireMtime=false, remoteItem/package/bundle throws, eTag) still green (behavior preserved).

- [ ] **Step 5: Full-suite regression**

Run: `npm test`
Expected: 494 passing (492 + 2 new). Zero regressions.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit (if the per-task commit flow is approved)**

```bash
git add src/baseTypes.ts src/driveItemConvert.ts tests/driveItemConvert.test.ts
git commit -m "refactor(driveItemConvert): split converter into metadata + key-derivation; populate remoteId"
```

---

### Task 2: `id`-fallback variant `fromDriveItemToEntityWithIdFallback`

**Files:**
- Modify: `src/driveItemConvert.ts` (add the fallback variant, after `fromDriveItemToEntity`)
- Test: `tests/driveItemConvert.test.ts`

**Interfaces:**
- Produces: `fromDriveItemToEntityWithIdFallback(x, remoteBaseDir, idToKeyMap?: Map<string,string>, requireMtime=true) → Entity`. On path-missing: if `x.id` ∈ `idToKeyMap`, reuse `keyRaw`; else re-throw.

- [ ] **Step 1: Write the failing tests**

Append to `tests/driveItemConvert.test.ts` (new describe block at end of file):

```typescript
describe("fromDriveItemToEntityWithIdFallback", () => {
  // A non-root item with NO parentReference.path (the documented delta shape).
  const pathlessItem = {
    id: "d!999",
    name: "notes/a.md", // name alone can't reconstruct the vault path
    size: 20,
    file: {},
    fileSystemInfo: {
      lastModifiedDateTime: MTIME,
      createdDateTime: MTIME,
    },
    parentReference: { driveId: "d", id: "d!root" }, // no path
  };

  it("reuses the known keyRaw from idToKeyMap when path is missing (modify case)", () => {
    const idToKeyMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    const e = fromDriveItemToEntityWithIdFallback(
      pathlessItem as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "notes/a.md");
    assert.strictEqual(e.keyRaw, "notes/a.md");
    assert.strictEqual(e.size, 20);
    assert.strictEqual(e.remoteId, "d!999");
    assert.strictEqual(e.mtimeSvr, MTIME_MS);
  });

  it("re-throws when path is missing AND id is NOT in the map (new item)", () => {
    const idToKeyMap = new Map<string, string>(); // empty — id not found
    assert.throws(
      () =>
        fromDriveItemToEntityWithIdFallback(
          pathlessItem as any,
          REMOTE_BASE_DIR,
          idToKeyMap
        ),
      /parentReference\.path is undefinded or null/
    );
  });

  it("re-throws when no idToKeyMap is passed at all", () => {
    assert.throws(
      () =>
        fromDriveItemToEntityWithIldFallback(
          pathlessItem as any,
          REMOTE_BASE_DIR
        ),
      /parentReference\.path is undefinded or null/
    );
  });

  it("falls through to normal path-derivation when path IS present (no fallback needed)", () => {
    const withPath = { ...normalFile, id: "d!555", eTag: '"e1"' };
    const idToKeyMap = new Map<string, string>();
    const e = fromDriveItemToEntityWithIdFallback(
      withPath as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "a.md");
    assert.strictEqual(e.etag, '"e1"');
  });

  it("preserves the folder suffix from the reused keyRaw", () => {
    const pathlessFolder = {
      id: "d!folder1",
      name: "x", // irrelevant — key comes from the map
      size: 0,
      folder: {},
      fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    // The map's keyRaw already carries the trailing slash from the prior sync.
    const idToKeyMap = new Map<string, string>([["d!folder1", "sub/x/"]]);
    const e = fromDriveItemToEntityWithIdFallback(
      pathlessFolder as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "sub/x/");
    assert.strictEqual(e.size, 0); // folder → 0
  });

  it("still maps the approot root to key '/' (bypasses fallback)", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntityWithIdFallback(
      rootItem as any,
      REMOTE_BASE_DIR,
      new Map()
    );
    assert.strictEqual(e.key, "/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: FAIL — `fromDriveItemToEntityWithIdFallback` is not exported yet (ReferenceError / import error).

- [ ] **Step 3: Implement the fallback variant**

In `src/driveItemConvert.ts`, add after `fromDriveItemToEntity`:

```typescript
/**
 * Variant of fromDriveItemToEntity that falls back to an id→key lookup when
 * parentReference.path is missing (the documented delta shape —
 * https://learn.microsoft.com/en-us/graph/api/driveitem-delta: "track items
 * by id"). Covers the MODIFY case (item existed in the prev sync → its id is
 * in idToKeyMap → reuse the known keyRaw). New path-missing items (id not in
 * the map) re-throw → caller warns + skips + invalidates the deltaLink
 * (self-heal). The approot root folder bypasses the fallback (mapped to
 * key "/" as in fromDriveItemToEntity).
 */
export const fromDriveItemToEntityWithIdFallback = (
  x: DriveItem,
  remoteBaseDir: string,
  idToKeyMap?: Map<string, string>,
  requireMtime = true
): Entity => {
  // approot root → minimal entity (same as fromDriveItemToEntity)
  if (isApprootRootDriveItem(x, remoteBaseDir)) {
    return {
      key: "/",
      keyRaw: "/",
      mtimeSvr: undefined,
      mtimeCli: undefined,
      ctimeCli: undefined,
      size: 0,
      sizeRaw: 0,
      synthesizedFile: false,
      remoteId: (x as any).id,
    };
  }
  // remoteItem / package / bundle (same guards, same order)
  if ("remoteItem" in x) {
    throw Error(
      "driveItem carries remoteItem (shared item) — not supported in approot sync"
    );
  }
  if ("package" in x || "bundle" in x) {
    throw Error(
      "driveItem is a package/bundle — neither file nor folder, not supported in approot sync"
    );
  }
  // path derivation, with id-fallback on path-missing
  let key: string;
  try {
    key = deriveKeyFromPath(x, remoteBaseDir);
  } catch (e) {
    // path missing — try the id→key fallback (modify case)
    if (
      e instanceof Error &&
      e.message.includes("parentReference.path is undefinded or null") &&
      idToKeyMap &&
      (x as any).id !== undefined &&
      idToKeyMap.has((x as any).id)
    ) {
      key = idToKeyMap.get((x as any).id)!;
    } else {
      throw e; // not a path-missing error, or id not in map → re-throw → self-heal
    }
  }
  const meta = extractDriveItemMetadata(x, requireMtime);
  return {
    key,
    keyRaw: key,
    mtimeSvr: meta.mtimeSvr,
    mtimeCli: meta.mtimeCli,
    ctimeCli: meta.ctimeCli,
    size: meta.size,
    sizeRaw: meta.sizeRaw,
    synthesizedFile: false,
    etag: meta.etag,
    remoteId: meta.remoteId,
  };
};
```

- [ ] **Step 4: Fix the intentional typo in the test (`fromDriveItemToEntityWithIldFallback` → `fromDriveItemToEntityWithIdFallback`)**

In the test "re-throws when no idToKeyMap is passed at all", correct the function name. (The typo above is a deliberate red-signal; fix it so the test compiles.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx mocha --import=tsx tests/driveItemConvert.test.ts`
Expected: ALL PASS (6 new fallback tests + all prior).

- [ ] **Step 6: Full-suite regression + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: 500 passing (494 + 6 new). Typecheck clean.

- [ ] **Step 7: Commit (if approved)**

```bash
git add src/driveItemConvert.ts tests/driveItemConvert.test.ts
git commit -m "feat(driveItemConvert): add id-fallback variant for missing parentReference.path"
```

---

### Task 3: `classifyDeltaItems` threads `idToKeyMap` + `buildIdToKeyMap` helper

**Files:**
- Modify: `src/deltaMerge.ts:123-176` (classifyDeltaItems signature + both branches)
- Modify: `src/deltaMerge.ts` (add `buildIdToKeyMap` export)
- Test: `tests/deltaMerge.test.ts`

**Interfaces:**
- Produces: `classifyDeltaItems(driveItems, remoteBaseDir, fromDriveItemToEntity, idToKeyMap?: Map<string,string>)` — 4th optional param.
- Produces: `buildIdToKeyMap(prevEntities: Entity[]) → Map<string,string>` (remoteId → keyRaw).
- Consumes: `fromDriveItemToEntityWithIdFallback` from Task 2 (injected as the converter, OR classifyDeltaItems calls it directly when idToKeyMap present).

- [ ] **Step 1: Write the failing tests**

Append to `tests/deltaMerge.test.ts` (new describe block at end of file):

```typescript
import {
  classifyDeltaItems,
  mergeDeltaWithPrevState,
  buildIdToKeyMap,
} from "../src/deltaMerge";
import { fromDriveItemToEntityWithIdFallback } from "../src/driveItemConvert";

describe("buildIdToKeyMap", () => {
  it("maps remoteId → keyRaw for entities that have remoteId", () => {
    const prev = [
      { keyRaw: "a.md", remoteId: "d!1" },
      { keyRaw: "sub/b.md", remoteId: "d!2" },
      { keyRaw: "no-id.md" }, // remoteId undefined → excluded
    ] as any;
    const map = buildIdToKeyMap(prev);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get("d!1"), "a.md");
    assert.strictEqual(map.get("d!2"), "sub/b.md");
    assert.ok(!map.has(undefined));
  });

  it("returns an empty map for prev with no remoteIds", () => {
    const map = buildIdToKeyMap([{ keyRaw: "a.md" }] as any);
    assert.strictEqual(map.size, 0);
  });
});

describe("classifyDeltaItems with idToKeyMap (real converter)", () => {
  const MTIME = "2024-01-01T00:00:00Z";
  // A non-root delta item with NO parentReference.path — the documented
  // delta shape. Its id IS in the map (modify case).
  const pathlessModified = {
    id: "d!999",
    name: "x", // irrelevant — key comes from the map
    size: 20,
    file: {},
    eTag: '"e2"',
    fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
    parentReference: { driveId: "d", id: "d!root" }, // NO path
  };

  it("recovers a path-missing modify item via id-lookup (no warn, no skip)", () => {
    const idToKeyMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    let result;
    try {
      result = classifyDeltaItems(
        [pathlessModified],
        "MyVault",
        fromDriveItemToEntityWithIdFallback,
        idToKeyMap
      );
    } finally {
      console.warn = origWarn;
    }
    assert.ok(!warned, "must NOT warn — item recovered via id-lookup");
    assert.strictEqual(result.deltaEntities.length, 1);
    assert.strictEqual(result.deltaEntities[0].keyRaw, "notes/a.md");
    assert.strictEqual(result.deltaEntities[0].etag, '"e2"');
    assert.strictEqual(result.skippedAddedOrModified, 0);
  });

  it("still skips + self-heals when id is NOT in the map (new path-missing item)", () => {
    const idToKeyMap = new Map<string, string>(); // empty
    const { deltaEntities, skippedAddedOrModified } = classifyDeltaItems(
      [pathlessModified],
      "MyVault",
      fromDriveItemToEntityWithIdFallback,
      idToKeyMap
    );
    assert.strictEqual(deltaEntities.length, 0);
    assert.strictEqual(skippedAddedOrModified, 1);
  });

  it("deleted path-missing item with id in map → goes to deletedKeys (no phantom)", () => {
    const pathlessDeleted = {
      id: "d!777",
      name: "x",
      deleted: {},
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    const idToKeyMap = new Map<string, string>([["d!777", "gone.md"]]);
    const { deltaEntities, deletedKeys, skippedAddedOrModified } =
      classifyDeltaItems(
        [pathlessDeleted],
        "MyVault",
        fromDriveItemToEntityWithIdFallback,
        idToKeyMap
      );
    assert.strictEqual(deltaEntities.length, 0);
    assert.ok(deletedKeys.has("gone.md"));
    assert.strictEqual(skippedAddedOrModified, 0);
  });

  it("works without idToKeyMap (backward-compatible — current behavior)", () => {
    // No 4th arg → behaves exactly like today: path-missing → throw → skip.
    const { deltaEntities, skippedAddedOrModified } = classifyDeltaItems(
      [pathlessModified],
      "MyVault",
      fromDriveItemToEntityWithIdFallback
    );
    assert.strictEqual(deltaEntities.length, 0);
    assert.strictEqual(skippedAddedOrModified, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha --import=tsx tests/deltaMerge.test.ts`
Expected: FAIL — `buildIdToKeyMap` is not exported; `classifyDeltaItems` doesn't accept a 4th arg (the id-lookup tests fail because items get skipped instead of recovered).

- [ ] **Step 3: Implement `buildIdToKeyMap` + thread `idToKeyMap` into `classifyDeltaItems`**

In `src/deltaMerge.ts`:

Add the helper (after `mergeDeltaWithPrevState`, before `classifyDeltaItems`):

```typescript
/**
 * Build an `id → keyRaw` lookup map from prev-sync entities, for the delta
 * id-fallback (reconstructing a vault-relative key when parentReference.path
 * is missing — the documented delta shape). Only entities that carry a
 * `remoteId` (Graph driveItem.id) participate; older entities without it
 * are silently excluded (graceful degradation — those items self-heal).
 */
export function buildIdToKeyMap(
  prevEntities: Entity[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of prevEntities) {
    if (e.remoteId !== undefined && e.remoteId !== "" && e.keyRaw !== undefined && e.keyRaw !== "") {
      map.set(e.remoteId, e.keyRaw);
    }
  }
  return map;
}
```

Update `classifyDeltaItems` signature + both branches. Replace the function (currently lines 123-176) with:

```typescript
export function classifyDeltaItems(
  driveItems: any[],
  remoteBaseDir: string,
  fromDriveItemToEntity: DriveItemToEntity,
  idToKeyMap?: Map<string, string>
): ClassifiedDelta {
  const deltaEntities: Entity[] = [];
  const deletedKeys = new Set<string>();
  let skippedAddedOrModified = 0;

  for (const item of driveItems) {
    const isDeleted = "@removed" in item || "deleted" in item;
    if (isDeleted) {
      // Deleted item — extract just the key (no mtime required). When an
      // idToKeyMap is available, the caller should pass a converter that
      // does id-fallback (fromDriveItemToEntityWithIdFallback) so a
      // path-missing deleted item still yields its key for deletedKeys
      // (instead of surviving as a phantom → 404 self-heal).
      try {
        const entity = fromDriveItemToEntity(item, remoteBaseDir, false);
        if (entity.keyRaw !== "/" && entity.keyRaw !== "") {
          deletedKeys.add(entity.keyRaw);
        }
      } catch (e) {
        console.warn(
          "classifyDeltaItems: skipping deleted item (parse failed)",
          e instanceof Error ? e.message : e,
          JSON.stringify(item).slice(0, 200)
        );
      }
    } else {
      // Added or modified item. With idToKeyMap + the fallback converter, a
      // path-missing modify item is recovered via id-lookup (no skip).
      try {
        const entity = fromDriveItemToEntity(item, remoteBaseDir);
        if (entity.key !== "/") {
          deltaEntities.push(entity);
        }
      } catch (e) {
        skippedAddedOrModified += 1;
        console.warn(
          "classifyDeltaItems: skipping added/modified item (parse failed)",
          e instanceof Error ? e.message : e,
          JSON.stringify(item).slice(0, 200)
        );
      }
    }
  }

  return { deltaEntities, deletedKeys, skippedAddedOrModified };
}
```

The signature change (4th optional param `idToKeyMap`) is intentionally NOT consumed inside `classifyDeltaItems` itself — the fallback is performed by the *converter* (`fromDriveItemToEntityWithIdFallback`), which the caller passes in along with the map. The 4th param exists so callers signal "use fallback" and so the function's contract documents the map's availability; the converter closure captures the map. **However, to make the map actually reach the converter without forcing callers to curry, expose it on the converter call:** the simplest behavior-preserving approach is that `walk()` (Task 4) passes `fromDriveItemToEntityWithIdFallback` bound with the map. If the implementer prefers `classifyDeltaItems` to own the binding, an alternative is to accept the map + the base converter and bind internally — either is acceptable as long as the Task 3 tests (which pass `fromDriveItemToEntityWithIdFallback` directly as the converter) pass. Keep the 4th param optional + unused in the function body for now (it documents intent + future use); the real binding is at the call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha --import=tsx tests/deltaMerge.test.ts`
Expected: ALL PASS — 4 new id-lookup tests + all existing classifyDeltaItems/merge/404-regression/approot-root/self-heal tests green.

- [ ] **Step 5: Full-suite regression + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: 506 passing (500 + 6 new: 2 buildIdToKeyMap + 4 classifyDeltaItems). Typecheck clean.

- [ ] **Step 6: Commit (if approved)**

```bash
git add src/deltaMerge.ts tests/deltaMerge.test.ts
git commit -m "feat(deltaMerge): classifyDeltaItems + buildIdToKeyMap for id-fallback on missing path"
```

---

### Task 4: Wire `walk()` incremental branch to build + pass the map

**Files:**
- Modify: `src/fsOnedrive.ts:909-944` (walk incremental branch: build map, pass to classifyDeltaItems + use fallback converter)

**Interfaces:**
- Consumes: `buildIdToKeyMap`, `fromDriveItemToEntityWithIdFallback` (from Tasks 2-3).

- [ ] **Step 1: Update the `classifyDeltaItems` call in `walk()`**

In `src/fsOnedrive.ts`, the incremental branch (around line 913) currently calls:

```typescript
const { deltaEntities, deletedKeys, skippedAddedOrModified } =
  classifyDeltaItems(
    driveItems,
    this.remoteBaseDir,
    fromDriveItemToEntity
  );
```

Change to build the id→key map from `prevRemoteEntities` and pass it + the fallback converter. Add the import at the top of the file (alongside the existing `fromDriveItemToEntity` import):

```typescript
import {
  fromDriveItemToEntity,
  fromDriveItemToEntityWithIdFallback,
} from "./driveItemConvert";
import { buildIdToKeyMap } from "./deltaMerge";
```

And replace the `classifyDeltaItems` call with:

```typescript
// Build id→key map from prev sync so path-missing modify items can be
// recovered via id-lookup (the documented delta shape — Graph omits
// parentReference.path). Items without remoteId (old/walkPartial origin)
// are gracefully excluded; those self-heal as before.
const idToKeyMap = buildIdToKeyMap(this.prevRemoteEntities);
const { deltaEntities, deletedKeys, skippedAddedOrModified } =
  classifyDeltaItems(
    driveItems,
    this.remoteBaseDir,
    (item, dir, requireMtime) =>
      fromDriveItemToEntityWithIdFallback(item, dir, idToKeyMap, requireMtime),
    idToKeyMap
  );
```

The full-enumeration branch (line 945-972) and `walkPartial` (line 975+) are **left unchanged** — they use the plain `fromDriveItemToEntity` (which still populates `remoteId`, so the NEXT sync's prev has it; they empirically have `path`, and have no prev for a map anyway).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (the lambda matches `DriveItemToEntity`'s signature).

- [ ] **Step 3: Full-suite regression**

Run: `npm test`
Expected: 506 passing (no new tests here — wiring; behavior proven by Task 3's pure tests). Zero regressions.

- [ ] **Step 4: Build + deploy + smoke**

Run: `npm run build`
Expected: tsc + esbuild succeed; `main.js` auto-deployed to the vault (if `VAULT_PATH` set in `.env`).

Manual smoke (single-device, no path-missing expected — just confirms no breakage): trigger a sync in Obsidian, confirm it completes without errors in the console. The incremental path now builds an (possibly empty, on first sync of session) idToKeyMap; with `path` present for all items (empirically), the fallback never triggers — zero behavior change observed.

- [ ] **Step 5: Commit (if approved)**

```bash
git add src/fsOnedrive.ts
git commit -m "feat(fsOnedrive): wire walk() incremental delta to id-fallback for missing path"
```

---

## Self-Review (run after writing, fix inline — already done)

- **Spec coverage:** §4.2 components → Task 1 (Entity.remoteId + converter split), Task 2 (fallback variant), Task 3 (classifyDeltaItems + buildIdToKeyMap), Task 4 (walk wiring). §4.3 data flow → Task 4 step 1 + Task 3 tests. §4.4 error table → Task 2 + Task 3 tests cover all rows. §5 testing → all 4 tasks TDD. §6 migration → none (noted in Global Constraints). ✓
- **Placeholder scan:** Task 1 Step 3 has a `[PASTE ...]` note for the verbatim if/else chain (lines 178-324). This is intentional — those ~150 lines are moved verbatim, not rewritten; the implementer copies them. Flagged clearly. No other placeholders. ✓
- **Type consistency:** `fromDriveItemToEntityWithIdFallback(x, remoteBaseDir, idToKeyMap?, requireMtime?)` — same name in Task 2 (def) + Task 3 (import + tests) + Task 4 (lambda). `buildIdToKeyMap(prevEntities)` — same in Task 3 (def + tests) + Task 4 (import + call). `classifyDeltaItems(..., idToKeyMap?)` 4th param — Task 3 def + tests, Task 4 call. ✓
- **Ambiguity:** Task 3 Step 3's prose about the 4th param being "optional + unused in the function body" vs. the binding happening at the call site — made explicit (the converter closure captures the map; Task 4 shows the lambda). The Task 3 tests pass the fallback converter directly (which already has the map bound via closure in the test). Reconciled. ✓
