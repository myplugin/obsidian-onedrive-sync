# OneDrive Delta `id`-Fallback for Missing `parentReference.path`

**Date:** 2026-09-21
**Status:** Design (pending implementation plan)
**Predecessor:** `docs/lessons/onedrive-delta-parentreference-path.md` (the prior postmortem + partial fix in commit `134aac9`)

## 1. Background & Problem

Microsoft Graph's `driveItem: delta` endpoint **officially omits `parentReference.path`** from responses. The documented remark (unchanged since 2015):

> *"The `parentReference` property on items won't include a value for **path**. This occurs because renaming a folder doesn't result in any descendants of the folder being returned from delta. **When using delta you should always track items by id.**"*
> — https://learn.microsoft.com/en-us/graph/api/driveitem-delta

Our converter `fromDriveItemToEntity` (`src/driveItemConvert.ts`) derives each file's vault-relative `key` from `parentReference.path` + `name`, and **throws** `"x.parentReference.path is undefinded or null"` when `path` is absent (line 162). The throw propagates to `classifyDeltaItems` (`src/deltaMerge.ts:160-171`) which warns + skips the item + increments a self-heal counter that invalidates the `deltaLink` (next sync full-walks).

### What's already fixed
Commit `134aac9` added `isApprootRootDriveItem` to handle the **one empirically-observed** path-missing case: the approot root folder item (no path + `name === remoteBaseDir` + `folder` facet) → maps to `key: "/"` → filtered cleanly, no throw. That warning is gone.

### What remains (this spec's target)
The converter **still throws** for any *non-root* item missing `parentReference.path` — a shape the docs say is legitimate. This is a **contract violation** per the codebase's own "防范 checklist" (`docs/lessons/...:79`: *"若某字段无文档保证…标记为脆弱并配 fallback"*): `parentReference.path` has no doc guarantee, so it needs a fallback. The current behavior degrades to warn-skip-self-heal, which is **not data-losing** (next sync recovers), but is noisy and fights the documented contract.

## 2. Root Cause (systematic-debugging Phase 1)

- **Symptom:** `classifyDeltaItems: skipping added/modified item (parse failed) / x.parentReference.path is undefinded or null`
- **Why it fires:** the converter assumes `parentReference.path` is always present — an assumption valid only under full-enumeration mode (where path is empirically present), never documented, and broken by the incremental-delta contract.
- **Evidence:** lib-2 research confirmed path is documented-absent for all delta; no `itemReference` field has an always-present guarantee; Microsoft's own `vscode-onedrive-browser` walks `parentReference.id` instead of throwing.
- **No active data-losing bug:** self-heal (`deltaLink` invalidation) recovers skipped items next sync; a skipped item's etag is either OLD (still triggers 412 on concurrent push → If-Match protection holds) or ABSENT (new file = create, not an overwrite). The earlier "If-Match coverage gap" framing was an over-cautious hedge, not a confirmed defect.

## 3. Goal & Non-Goals

**Goal:** When `parentReference.path` is missing for a non-root delta item, reconstruct the vault-relative `key` by looking up the item's own Graph `id` in a prev-state `id→key` map — instead of throwing + skipping. This is **additive**: path-derivation is unchanged when `path` is present.

**Non-goals (explicitly deferred):**
- Replacing path-derivation entirely with id-walk (overkill — path works when present).
- Handling *new* path-missing items (no prev entry → id not in map → genuinely unparseable without path). These still self-heal. Rare in the approot-scoped delta empirically.
- Walking `parentReference.id` chains to reconstruct paths for new direct-children of approot (the full Microsoft approach). Future enhancement; not needed for the modify-case coverage.
- Touching the full-enumeration / `walkPartial` paths (they empirically have `path`; the full-walk has no `prev` to build an id-map from anyway — it's the first sync of the session that *populates* `remoteId`).

## 4. Design

### 4.1 Architecture

Add an **id-lookup fallback** at the delta seam (the incremental `classifyDeltaItems` path). Keep path-derivation as the primary mechanism. The fallback kicks in only when path-derivation throws.

```
delta item (path missing)
  → extractDriveItemMetadata (never throws on path)
  → deriveKeyFromPath throws
  → look up item.id in prev id→key map
     ├─ found → reuse known keyRaw (modify case — covered)
     └─ not found → re-throw → skip + self-heal (new item — deferred)
```

### 4.2 Components

**`src/baseTypes.ts` — `Entity` gains `remoteId?: string`**
The Graph `driveItem.id` (opaque, stable, survives renames). Optional + backward-compatible (Entity is "flat primitive, copyable" by design; old entities → `undefined`). This is how the prev-state id→key map is built and how `remoteId` propagates across syncs within a session.

**`src/driveItemConvert.ts` — split the converter (pure-function refactor, behavior-preserving)**
- `extractDriveItemMetadata(x, requireMtime=true)` → `{ mtimeSvr, mtimeCli, ctimeCli, size, sizeRaw, etag, remoteId, isFolder }`. Pure. Throws **only** on `remoteItem`/`package`/`bundle` and missing `fileSystemInfo.lastModifiedDateTime` (when `requireMtime`). **Does NOT throw on path-missing.** This is the path-independent metadata.
- `deriveKeyFromPath(x, remoteBaseDir)` → `string`. The existing regex prefix-stripping logic (current lines 107-329). Throws on path-missing (unchanged).
- `fromDriveItemToEntity(x, remoteBaseDir, requireMtime=true)` → assembles metadata + key. **Behavior identical to today** (path present → works; path missing → throws). **Always populates `remoteId: x.id`** — this is how `remoteId` enters prev state.
- `fromDriveItemToEntityWithIdFallback(x, remoteBaseDir, idToKeyMap, requireMtime=true)` → extract metadata; try `deriveKeyFromPath`; on path-missing, look up `x.id` in `idToKeyMap`: hit → reuse `keyRaw` (already carries folder suffix from prev); miss → re-throw (caller self-heals).

**`src/deltaMerge.ts` — `classifyDeltaItems` gains `idToKeyMap?: Map<string,string>`**
Both the added/modified branch (line 153-172) and the deleted branch (line 136-152): when `idToKeyMap` is provided, call `fromDriveItemToEntityWithIdFallback` (deleted branch with `requireMtime=false`); only when *that* throws too, count as skipped (self-heal signal unchanged). Deleted items benefit too: a deleted item missing path → id-lookup → known key → `deletedKeys` (instead of surviving as a phantom → 404 self-heal).

**`src/fsOnedrive.ts` — `walk()` incremental branch**
Build `idToKeyMap` from `this.prevRemoteEntities` (entries where `remoteId` is set → `remoteId → keyRaw`), pass to `classifyDeltaItems`. Full-enumeration + `walkPartial`: no `idToKeyMap` (no prev / sanity-check path) → current warn-and-skip retained (they populate `remoteId` via the non-fallback converter, and empirically have `path`).

**`src/syncOptimize.ts` — NO CHANGE.** `id` is already in `DELTA_SELECT` (`$select=id,name,size,fileSystemInfo,folder,file,parentReference,eTag`). The fallback's dependency on `x.id` is satisfied.

### 4.3 Data Flow

1. **Session start, first sync (prev `null`):** full-walk. Converter populates `remoteId: x.id` on every entity → saved as `prevRemoteEntities`.
2. **Subsequent syncs (prev available), incremental delta:** `walk()` builds `idToKeyMap` (`remoteId → keyRaw`) from prev. `classifyDeltaItems` uses the fallback variant. A modified item whose `path` is missing → `item.id` found in map → reuse `keyRaw` → entity enters `deltaEntities` (no skip, no warn, no self-heal trigger). A new path-missing item → id not in map → throw → skip → `deltaLink` invalidated → next sync full-walks (recovers it; if path is still missing on full-walk, warn-and-skip, but full-walk empirically has path).

### 4.4 Error Handling

| Case | Behavior |
|---|---|
| `path` present | `deriveKeyFromPath` succeeds (unchanged). |
| `path` missing + id in map (modify) | Fallback reuses `keyRaw`. No throw, no skip. |
| `path` missing + id NOT in map (new) | Re-throw → skip → `deltaLink` self-heal. |
| `remoteItem`/`package`/`bundle` | `extractDriveItemMetadata` throws → skip + self-heal (unchanged). |
| Missing mtime + `requireMtime=true` | throws → skip + self-heal (unchanged). |
| Deleted item, path missing, id in map | Fallback → known key → `deletedKeys` (no phantom). |
| Deleted item, path missing, id not in map | throw → not in `deletedKeys` → phantom survives → 404 self-heal (unchanged). |

## 5. Testing (TDD)

- **RED:** feed a non-root path-missing delta item (whose `id` is in a provided `idToKeyMap`) through `classifyDeltaItems` using the **real** `fromDriveItemToEntityWithIdFallback` → assert NO warn, entity IS in `deltaEntities`, `keyRaw` correct. (Fails today — current code warns + skips.)
- **GREEN:** implement the split + fallback → passes.
- Supplementary: deleted-item id-fallback; id-not-found still self-heals; metadata-extraction throw still skips; full-walk populates `remoteId`; `remoteId` persists into prev (round-trip).
- Regression: full existing suite (492) stays green; the 7 approot-root fixtures + skippedAddedOrModified tests unchanged.

## 6. Migration

**None.** `prevRemoteEntities` is cleared on every plugin load (`main.ts:712`) — session-scoped. The first full-walk of each session populates `remoteId` fresh. No long-lived persisted state to migrate; old persisted entities without `remoteId` → `undefined` → gracefully excluded from the id→key map (fallback no-ops that one sync, self-heals next).

## 7. Deferred / Open

- New path-missing items (no prev id): self-heal only. Future: walk `parentReference.id` chains or cache approot anchor id to resolve direct-children.
- Full-walk / `walkPartial` path-missing: retains warn-and-skip (empirically rare; no prev for id-map on full-walk).
- The pre-existing `parentReference.path` omission is documented for *all* delta; the approot-scoped endpoint (`/drive/special/approot:/{dir}:/delta`, undocumented form) empirically returns path for non-root items. This fallback hardens against the documented behavior regardless.

## 8. References

- Lesson: `docs/lessons/onedrive-delta-parentreference-path.md`
- Graph delta remark: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- `itemReference` resource: https://learn.microsoft.com/en-us/graph/api/resources/itemreference
- Microsoft's own id-walk: https://github.com/microsoft/vscode-onedrive-browser/blob/main/src/web/onedrive-types.ts
- AGENTS.md convention: "call-mode contract re-audit" + the 防范 checklist
