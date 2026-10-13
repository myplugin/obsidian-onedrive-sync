# OneDrive Full-Enumeration Fallback + `mkdir` Tracking + Out-of-Scope Drop

**Date:** 2026-09-23
**Status:** Design (pending implementation plan)
**Predecessors:**
- `docs/lessons/onedrive-delta-parentreference-path.md` (postmortem + 2 prior partial fixes)
- `docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md` (the incremental-branch id-fallback whose Non-goal #3 explicitly deferred the full-enum branch — this spec picks up that deferred item)

## 1. Background & Problem

This is the **third recurrence** of the OneDrive delta `parentReference.path`-missing warning. The two prior fixes (`134aac9` approot-root special-case; the 2026-09-21 id+parent-chain fallback) **only equipped the incremental branch** of `walk()`. The full-enumeration branch was left on the plain `fromDriveItemToEntity` converter, on the empirical assumption — stated as Non-goal #3 in the prior spec — that "full-walk empirically has path."

That assumption is **falsified by recurrence**: the warning now fires on **automatic periodic syncs** (not tied to any delete action), with the same stable parent folder id `<rootItemId>` recurring across independent sync events. After each `deltaLink` invalidation the next sync full-walks — and the same items are warn-skipped again, never entering `prevRemoteEntities`, so the incremental fallback (which depends on `prevRemoteEntities`) can never recover them. The cycle never breaks.

### Symptoms (across two independent sync events)

```
classifyDeltaItems: skipping added/modified item (parse failed)
  x.parentReference.path is undefinded or null
  {"id":"<folderId3>","size":0,"parentReference":{"driveType":"personal","driveId":"...","id":"<rootItemId>","si...
walk: 8 delta item(s) had no parentReference.path — retrying via stat-by-id
walk: 8 added/modified delta item(s) could not be parsed even after stat retry
  — invalidating deltaLink; next sync will do a full re-enumeration.
```

The 8 items form a parent chain `<rootItemId>` (grandparent, only referenced) → `<folderId4>` (parent) → 7 children. The chain-top `<rootItemId>` is **neither the `approotRootId`** (the baseline branch would resolve direct children) **nor in `prevRemoteEntities`** — confirmed because `approotRootId` is captured on every sync's first `_init()` (`vaultFolderExists` starts `false`, constructor line 554), and the rescan passes fail to bootstrap the chain.

## 2. Root Cause (systematic-debugging Phase 1)

Three structural defects, layered:

### Defect 1 (the unblocker) — full-enumeration branch uses the plain converter, no fallback

`src/fsOnedrive.ts:1096-1110`:
```ts
for (const x of driveItems) {
  try { const entity = fromDriveItemToEntity(x, this.remoteBaseDir); ... }
  catch (e) { console.warn("walk: skipping item in full enumeration (parse failed)", ...); }
}
```
The plain `fromDriveItemToEntity` throws on missing `parentReference.path` (and on paths that match no known prefix). Any path-missing item is **warn-skipped and never enters `prevRemoteEntities`**. The incremental id+parent-chain fallback (`fromDriveItemToEntityWithChainFallback`) can only resolve items whose own id or parent's id is in `prevRemoteEntities` — so it is **structurally dependent on the full-enum having captured the item**. When the full-enum skips the same items the incremental branch later needs, the fallback is circular and the cycle is unbreakable.

The Microsoft doc remark is unqualified about token vs no-token: *"When using delta you should always track items by id."* — the token-less `/delta` call is still "using delta," and path omission occurs for items involved in folder operations regardless of token. The prior spec's "full-walk empirically has path" was an empirical generalization that does not hold for these items.

### Defect 2 (latent gap, same class) — `mkdir`-created folders are not tracked in `uploadedEntities`

`src/fsOnedrive.ts:1252-1253` — only `writeFile` pushes to `uploadedEntities`:
```ts
if (!result.synthesizedFile) { this.uploadedEntities.push(result); }
```
`mkdir` → `_mkdirFromRoot` (1192-1224) returns `await this._statFromRoot(key)` (1222) but **never pushes**. `main.ts:616-623` merges only `uploadedEntities` into `prevRemoteEntities`. So folders created on OneDrive during a sync are absent from the next sync's `prevRemoteEntities` — the same hole, for a different population of items (newly-created folders vs. operation-affected existing folders).

### Defect 3 (contributing) — stat-retry requires mtime and can't distinguish out-of-scope

`src/fsOnedrive.ts:1051-1057` — stat-retry passes `requireMtime = undefined` → defaults to `true`; `extractDriveItemMetadata` throws "cannot parse mtime" on folders lacking `fileSystemInfo.lastModifiedDateTime` (possible for `mkdir`'d folders created without mtime, `_mkdirFromRoot:1209` only sets `lastModifiedDateTime` when `mtime !== undefined && !== 0`). And `deriveKeyFromPath`'s "no idea how to deal with it" throws (path matches no prefix → out-of-scope sibling) carry no `.code`, so the stat-retry catch swallows them as generic failures → counted as unresolved → `deltaLink` invalidated → thrash.

## 3. Goal & Non-Goals

**Goal:** Eliminate the structural asymmetry between the full-enum and incremental branches by unifying them on the same `classifyDeltaItems` + chain-fallback + stat-retry machinery. Close the `mkdir` tracking gap. Make stat-retry tolerate missing mtime and silently drop out-of-scope items instead of thrashing the `deltaLink`.

**Non-goals:**
- Replacing path-derivation with id-walk as the primary mechanism (path is still primary when present).
- Reworking the `deriveKeyFromPath` regex prefix tower (brittle, but in-scope; out-of-scope items are now detected and dropped, not crash-skipped). A future hardening.
- Switching full-enum from `/delta` to `/children` (rejected approach B — new API contract, loses deltaLink-from-full-enum).
- Changing the encryption wrapper (`FakeFsEncrypt`) — it delegates to `innerFs`; the tracking additions are on `FakeFsOnedrive`.

## 4. Design (Approach A — unify the branches)

### 4.1 Architecture

Extract the incremental branch's classify + stat-retry into a **shared private method** on `FakeFsOnedrive`:

```ts
private async _classifyAndStatRetry(
  driveItems: DriveItem[],
  lookupMap: Map<string, string>,
  invalidateOnUnresolved: boolean
): Promise<{ entities: Entity[]; deletedKeys: Set<string>; unresolvedCount: number }>
```
Both branches call it. The lookupMap is seeded differently:
- **Incremental:** `buildIdToKeyMap(this.prevRemoteEntities)` + `approotRootId→"/"` (as today).
- **Full-enum:** `new Map()` + `approotRootId→"/"` only (no prev — this IS the state being built). In-batch resolutions (classifyDeltaItems rescan + stat-retry) populate it during the call.

`classifyDeltaItems` (deltaMerge.ts) is reused unchanged — it already does the multi-pass rescan that unlocks in-batch parent→child chains. For full-enum every item is added/modified (`isDeleted=false`); `deletedKeys` is empty.

### 4.2 Components

**`src/fsOnedrive.ts` — `walk()` full-enum branch (replaces 1096-1115)**

Replace the plain-converter loop with:
```ts
const lookupMap = new Map<string, string>();
if (this.approotRootId !== undefined) lookupMap.set(this.approotRootId, "/");
const { entities } = await this._classifyAndStatRetry(
  driveItems, lookupMap, /* invalidateOnUnresolved */ false
);
this.lastWalkResult = entities;
this.lastWalkDeltaCount = undefined;
return entities;
```
Full-enum passes `invalidateOnUnresolved=false` — there is no useful `deltaLink` to invalidate (the full-enum just saved a fresh one representing "now"; invalidating would only force another identical full-enum next sync). Unresolved items are warn-logged and dropped.

**`src/fsOnedrive.ts` — `walk()` incremental branch (refactor 1008-1078)**

Replace the inline classify + stat-retry with the shared method:
```ts
const lookupMap = new Map(idToKeyMap); // fresh copy, as today
if (this.approotRootId !== undefined) lookupMap.set(this.approotRootId, "/");
const {
  entities: deltaEntities,
  deletedKeys,
  unresolvedCount,
} = await this._classifyAndStatRetry(
  driveItems, lookupMap, /* invalidateOnUnresolved */ true
);
if (unresolvedCount > 0) {
  this.onedriveConfig.deltaLink = "";
  await this.saveUpdatedConfigFunc();
}
const merged = mergeDeltaWithPrevState(
  this.prevRemoteEntities, deltaEntities, deletedKeys
);
this.lastWalkResult = merged;
this.lastWalkDeltaCount = driveItems.length;
return merged;
```
Behavior-preserving for the incremental branch except for the #3 fixes inside the shared stat-retry (the merge + return lines are the existing 1080-1087, unchanged).

**`src/fsOnedrive.ts` — `_classifyAndStatRetry` (new shared method)**

Body (extracted from current 1008-1078, with #3 fixes):
1. `classifyDeltaItems(driveItems, remoteBaseDir, chainFallbackClosure, lookupMap, approotRootId)` → `{ deltaEntities, deletedKeys, skippedAddedOrModified, skippedItems }`. The closure binds `lookupMap` + `approotRootId` (as today).
2. If `skippedItems.length > 0`: stat each by id (`/drive/items/{id}?$select=...`), convert with `fromDriveItemToEntityWithChainFallback(statResp, remoteBaseDir, lookupMap, approotRootId, /* requireMtime */ false)`:
   - success, `key !== "/"` → push to deltaEntities, decrement `unresolved`, `lookupMap.set(id, keyRaw)`.
   - throws `.code === "ONEDRIVE_PATH_OUT_OF_SCOPE"` → **silent drop** (debug log), NOT counted, NOT invalidated.
   - throws `ONEDRIVE_PATH_MISSING` / other → leave unresolved.
3. If `invalidateOnUnresolved && unresolved > 0` → the caller (incremental branch) invalidates `deltaLink`. Full-enum caller passes `false`, so no invalidation.
4. Return `{ entities: deltaEntities, deletedKeys, unresolvedCount: unresolved }`. Full-enum ignores `deletedKeys` (always empty there — every item is added/modified); incremental passes it to `mergeDeltaWithPrevState`.

**`src/fsOnedrive.ts` — `_mkdirFromRoot` (1192-1224): track in `uploadedEntities` (#2)**

After `const res = await this._statFromRoot(key);` (1222), before `return res`:
```ts
if (!res.synthesizedFile) {
  this.uploadedEntities.push(res);
}
```
`_statFromRoot` returns an Entity from `fromDriveItemToEntity` → `synthesizedFile: false` + `remoteId: x.id` (confirmed: line 1177 + driveItemConvert.ts:403,405). So the pushed entity is prev-eligible. Mirrors `writeFile:1252`.

**`src/driveItemConvert.ts` — coded out-of-scope error (#3)**

`deriveKeyFromPath`'s three "cannot deal" throws (lines 291, 303, 319) gain `.code = "ONEDRIVE_PATH_OUT_OF_SCOPE"` (mirroring `pathMissingError`'s `.code` pattern). This lets the shared stat-retry distinguish "stat path doesn't map to vault" (out-of-scope → drop) from "stat also lacks path" (`ONEDRIVE_PATH_MISSING` → unresolved). The `fromDriveItemToEntityWithChainFallback` catch (628) is unchanged — it only matches `ONEDRIVE_PATH_MISSING` and re-throws others (including the new OUT_OF_SCOPE), so the stat-retry catch sees it.

**`src/deltaMerge.ts` — `classifyDeltaItems`: no structural change.** It already accepts the chain-fallback closure + shared lookupMap + multi-pass rescan. Reused as-is by both branches.

### 4.3 Data Flow

**Full-enum (first sync of session, or after invalidation):**
```
/delta (no token) → driveItems → save deltaLink
→ lookupMap = { approotRootId → "/" }
→ classifyDeltaItems (chain-fallback closure) → deltaEntities + skippedItems
→ skippedItems → stat-by-id (requireMtime=false)
    • OUT_OF_SCOPE (path outside vault) → silent drop
    • in-scope → deltaEntities.push
→ unresolved>0 → warn only (no invalidate)
→ lastWalkResult = deltaEntities; return
```
Now path-missing in-scope items are resolved via chain-fallback (approotRootId anchor + in-batch) or stat-retry, and **enter `prevRemoteEntities`** — closing the circular dependency. Out-of-scope items are silently dropped instead of warn-skip-thrash.

**Incremental (prev available):**
```
/delta (with token) → driveItems → save deltaLink
→ lookupMap = buildIdToKeyMap(prev) + approotRootId → "/"
→ classifyDeltaItems → deltaEntities + deletedKeys + skippedItems
→ skippedItems → stat-by-id (requireMtime=false, OUT_OF_SCOPE→drop)
→ unresolved>0 → invalidate deltaLink (next sync full-walks — now with fallback)
→ mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys) → return
```

**mkdir during sync:** folder created on OneDrive → `_statFromRoot` → pushed to `uploadedEntities` → merged into `prevRemoteEntities` by `main.ts:616-623` → next sync's incremental `buildIdToKeyMap` has its `remoteId → keyRaw`.

### 4.4 Error Handling

| Case | Full-enum | Incremental |
|---|---|---|
| path present, matches prefix | sync | sync |
| path missing, own-id in map (modify) | (no prev, but in-batch if appeared earlier) | sync via fallback |
| path missing, parent-id in map/anchor (new child) | sync via chain-fallback | sync via chain-fallback |
| path missing, chain unreachable → stat → in-scope path | sync via stat-retry | sync via stat-retry |
| path missing → stat → OUT_OF_SCOPE path | **silent drop**, not counted | **silent drop**, not counted |
| path missing → stat 404 / stat also pathless | warn + unresolved (dropped) | warn + unresolved → invalidate deltaLink |
| stat path in-scope but no mtime (mkdir'd folder) | sync (requireMtime=false, mtimeSvr=undefined) | sync (same) |

Key invariant: **out-of-scope items never count toward `unresolved` and never invalidate `deltaLink`.** This is the thrash-stopper.

## 5. Testing

- **`tests/driveItemConvert.test.ts`:** `deriveKeyFromPath` throws `ONEDRIVE_PATH_OUT_OF_SCOPE` (assert `.code`) for: (a) no known prefix, (b) `/drive/items/` prefix but path not under `remoteBaseDir`, (c) no `name` on a `/drive/items/` item.
- **New full-enum fallback test:** empty `lookupMap` + `approotRootId` anchor → a direct child of vault root (parentRef.id === approotRootId, no path) resolves to `key = name`; a deeper child whose parent resolves in-batch resolves on rescan; an out-of-scope stat path → dropped (not in result, not counted).
- **`tests/deltaMerge.test.ts`:** the exact 8-item chain fixture from the user's log (`<rootItemId>` → `<folderId4>` → 7 children) — verify the full-enum+stat path either resolves in-scope children or correctly drops out-of-scope, with **zero `deltaLink` invalidation** in the full-enum case.
- **mkdir tracking test:** `_mkdirFromRoot` success → `uploadedEntities` contains the entity with `remoteId` set.

## 6. Documentation

- **`docs/lessons/onedrive-delta-parentreference-path.md`:** add a third follow-up section correcting the "全量 delta 必带 path" claim (falsified by recurrence on automatic sync), noting the full-enum branch now shares the fallback, and that out-of-scope items are silently dropped.
- **`AGENTS.md`** call-mode checklist already covers this pattern; no change needed.

## 7. Verification

- `npm run typecheck` (tsc -noEmit -skipLibCheck) green.
- `npm test` — all existing + new tests green.
- `npm run build` produces `main.js`.
- Manual: trigger an automatic sync; confirm the `classifyDeltaItems: skipping added/modified item` warning and the `invalidating deltaLink` message no longer recur for the stable `<rootItemId>` family.

## 8. References

- Microsoft Graph `driveItem: delta` remarks: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- Prior postmortem: `docs/lessons/onedrive-delta-parentreference-path.md`
- Prior spec (whose Non-goal #3 this picks up): `docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md`
- Root-cause session: systematic-debugging Phase 1 (this conversation)
