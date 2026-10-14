// License: Apache-2.0 (see src/LICENSE)

import type { DriveItem } from "@microsoft/microsoft-graph-types";
import type { Entity } from "./baseTypes";

/**
 * Merge incremental OneDrive delta-API results with the previous full
 * remote state to reconstruct the current full remote file list.
 *
 * ## Why this exists
 *
 * `FakeFsOnedrive.walk()` used to call the Graph `/delta` endpoint from
 * scratch every sync 鈥?enumerating ALL remote files even when nothing
 * changed. The OneDrive delta API returns a `deltaLink` that, when queried
 * on the next sync, returns ONLY items that were added, modified, or
 * deleted since the last call. This function applies those incremental
 * changes to the last-known full state, producing the same result as a
 * full walk but with far fewer API calls (potentially 1 call returning
 * 0 items for a "no changes" sync).
 *
 * @param prevEntities    Full remote entity list from the previous sync
 *                        (raw walk() output at the FakeFsOnedrive level,
 *                         before encryption-layer processing).
 * @param deltaEntities   New/modified entities extracted from the delta
 *                        API response (already converted via
 *                        `fromDriveItemToEntity`).
 * @param deletedKeys     Set of `keyRaw` values for items the delta API
 *                        marked as `@removed`.
 * @returns               The merged full entity list representing the
 *                        current remote state.
 */
export function mergeDeltaWithPrevState(
  prevEntities: Entity[],
  deltaEntities: Entity[],
  deletedKeys: Set<string>
): Entity[] {
  // Build a map of prev entities by keyRaw for O(1) lookup / update.
  const entityMap = new Map<string, Entity>();
  for (const e of prevEntities) {
    if (e.keyRaw !== undefined && e.keyRaw !== "") {
      entityMap.set(e.keyRaw, e);
    }
  }

  // Apply additions and modifications from the delta.
  // Track which keys were added/modified so deletions can be
  // deconflicted 鈥?if a key appears as both live (restored) and
  // @removed (deleted) in the same delta window, the live entry
  // represents the net state and must survive.
  const liveKeys = new Set<string>();
  for (const e of deltaEntities) {
    if (e.keyRaw !== undefined && e.keyRaw !== "" && e.keyRaw !== "/") {
      entityMap.set(e.keyRaw, e);
      liveKeys.add(e.keyRaw);
    }
  }

  // Apply deletions 鈥?skip keys that also have a live entry
  // (delete-then-restore within one delta window: last state wins).
  for (const key of deletedKeys) {
    if (!liveKeys.has(key)) {
      entityMap.delete(key);
    }
  }

  return Array.from(entityMap.values());
}

/**
 * Build an `id → keyRaw` lookup map from prev-sync entities, for the delta
 * id-fallback (reconstructing a vault-relative key when parentReference.path
 * is missing — the documented delta shape). Only entities that carry a
 * `remoteId` (Graph driveItem.id) participate; older entities without it
 * are silently excluded (graceful degradation — those items self-heal).
 */
export function buildIdToKeyMap(prevEntities: Entity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of prevEntities) {
    if (
      e.remoteId !== undefined &&
      e.remoteId !== "" &&
      e.keyRaw !== undefined &&
      e.keyRaw !== ""
    ) {
      map.set(e.remoteId, e.keyRaw);
    }
  }
  return map;
}

/**
 * Callback shape for converting a Graph DriveItem into an Entity.
 * Injected so this pure function can be unit-tested without importing
 * the heavy fsOnedrive module (which pulls in @azure/msal-node etc.).
 */
export type DriveItemToEntity = (
  item: DriveItem,
  remoteBaseDir: string,
  requireMtime?: boolean
) => Entity;

/**
 * Result of classifying a page of Graph delta-API DriveItems into
 * additions/modifications vs. deletions.
 */
export interface ClassifiedDelta {
  deltaEntities: Entity[];
  deletedKeys: Set<string>;
  /**
   * Count of added/modified items whose conversion threw (parse failed).
   * Unlike deleted-item skips (which self-heal via the 404 path in main.ts),
   * these silently drop from the merged list with no error signal 鈥?so sync
   * would never pull them. walk() reads this to invalidate the deltaLink so
   * the NEXT sync does a full re-enumeration that re-fetches them cleanly.
   */
  skippedAddedOrModified: number;
  /** Terminal-failure items (added/modified only, not deleted) whose
   *  conversion threw after all fallback passes. Each carries the raw
   *  delta DriveItem so the caller can stat-by-id to retry with full
   *  metadata (the non-delta GET endpoint returns parentReference.path
   *  reliably, unlike the delta endpoint which often omits it). */
  skippedItems: unknown[];
}

/**
 * Classify Graph delta-API DriveItems into "added/modified" entities and
 * "deleted" keys.
 *
 * ## Why both @removed and the `deleted` facet
 *
 * The Microsoft Graph driveItem delta API signals a deletion via EITHER:
 *  - the `@removed` annotation (e.g. `{"@removed": {"reason": "deleted"}}`), OR
 *  - the `deleted` facet on the DriveItem (e.g. `{"id": "...", "deleted": {}}`).
 *
 * Different tenants/scenarios return one or the other, and the official docs
 * show the `deleted` facet in their example responses. Checking ONLY
 * `@removed` (as this codebase previously did) misses deletions on tenants
 * that use the `deleted` facet, which causes stale entries to survive in the
 * merged remote entity list 鈥?sync then tries to download/stat files that
 * no longer exist on OneDrive, surfacing as HTTP 404 AggregateErrors during
 * `dispatchOperationToActualV3` (copyFile 鈫?stat 鈫?_getJson).
 *
 * Items whose key cannot be parsed by `fromDriveItemToEntity` are silently
 * skipped (same tolerance as the previous inline implementation).
 *
 * @param driveItems            Raw DriveItem[] from the delta response
 *                              (already flattened across @odata.nextLink pages).
 * @param remoteBaseDir         The vault's remote base directory.
 * @param fromDriveItemToEntity Converter (injected from fsOnedrive to keep
 *                              this function pure and testable). When the
 *                              caller runs in chain-fallback mode it passes
 *                              fromDriveItemToEntityWithChainFallback bound
 *                              with the SHARED lookup map via closure, so a
 *                              path-missing item (added/modified OR deleted)
 *                              still yields its key via own-id lookup or the
 *                              parentReference.id chain instead of being
 *                              skipped/phantom-surviving.
 * @param idToKeyMap            Optional lookup map (seed: prev-state
 *                              `remoteId -> keyRaw`, see buildIdToKeyMap).
 *                              MUST be the SAME instance the injected
 *                              converter is closure-bound to: this body
 *                              mutates it (root anchor + each resolved
 *                              item's id -> keyRaw) so in-batch parent ->
 *                              child chains resolve on the rescan passes.
 *                              Callers pass a fresh copy (strings only), so
 *                              mutations never leak into prevRemoteEntities.
 * @param approotRootId         Optional Graph driveItem.id of the vault's
 *                              remote root folder (captured by _init() in
 *                              fsOnedrive.ts). Seeded into idToKeyMap as
 *                              the "/" anchor and consumed by the closure-
 *                              bound chain converter (baseline: direct
 *                              children of the vault root). Documents the
 *                              caller's intent, same pattern as idToKeyMap.
 */
export function classifyDeltaItems<T extends { id?: string }>(
  driveItems: T[],
  remoteBaseDir: string,
  fromDriveItemToEntity: (
    item: T,
    remoteBaseDir: string,
    requireMtime?: boolean
  ) => Entity,
  idToKeyMap?: Map<string, string>,
  approotRootId?: string
): ClassifiedDelta {
  const deltaEntities: Entity[] = [];
  const deletedKeys = new Set<string>();
  let skippedAddedOrModified = 0;

  // Seed the approot-root anchor into the SHARED lookup map so the closure-
  // bound chain converter can resolve direct children of the vault root even
  // when the caller did not pre-seed it. Idempotent (the plan's call sites
  // pre-seed the same entry); a no-op when no map was passed.
  if (
    idToKeyMap !== undefined &&
    approotRootId !== undefined &&
    approotRootId !== ""
  ) {
    idToKeyMap.set(approotRootId, "/");
  }

  // Items whose conversion threw on the latest pass. A failure can be
  // TRANSIENT within the batch: the item's parent folder may appear LATER
  // in the same delta page (in-batch parent -> child chain), so a rescan
  // after the parent resolved (its id -> keyRaw landed in idToKeyMap, the
  // very instance the closure-bound converter reads) can still succeed -
  // regardless of the order Graph returned the items in.
  const pending: { item: T; isDeleted: boolean; error: unknown }[] = [];

  const consumeResolved = (item: T, entity: Entity, isDeleted: boolean) => {
    if (isDeleted) {
      if (entity.keyRaw !== "/" && entity.keyRaw !== "") {
        deletedKeys.add(entity.keyRaw);
      }
    } else {
      if (entity.key !== "/") {
        deltaEntities.push(entity);
      }
    }
    // Publish this item's id -> keyRaw into the shared lookup map so later
    // items (and rescan passes) can resolve parent-id chains against it.
    if (
      idToKeyMap !== undefined &&
      item.id !== undefined &&
      item.id !== null &&
      entity.keyRaw !== ""
    ) {
      idToKeyMap.set(item.id, entity.keyRaw);
    }
  };

  // Pass 1: sequential, in delta order. Deleted items are converted with
  // requireMtime=false (they often lack fileSystemInfo); added/modified
  // items keep the converter default (undefined -> true).
  for (const item of driveItems) {
    // Graph uses both markers - see function doc. Checking only @removed
    // leaks stale entries -> 404 AggregateErrors during sync operations.
    const isDeleted = "@removed" in item || "deleted" in item;
    try {
      const entity = fromDriveItemToEntity(
        item,
        remoteBaseDir,
        isDeleted ? false : undefined
      );
      consumeResolved(item, entity, isDeleted);
    } catch (e) {
      pending.push({ item, isDeleted, error: e });
    }
  }

  // Rescan passes: retry the pending items until a pass resolves none.
  // Each resolution can unlock further items down the parent chain; every
  // pass with progress shrinks `pending`, so the loop terminates.
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { item, isDeleted } = pending[i];
      try {
        const entity = fromDriveItemToEntity(
          item,
          remoteBaseDir,
          isDeleted ? false : undefined
        );
        consumeResolved(item, entity, isDeleted);
        pending.splice(i, 1);
        progressed = true;
      } catch (e) {
        pending[i].error = e; // keep the LAST error for the terminal warn
      }
    }
  }

  // Terminal failures: contractually unresolvable (e.g. the parent chain
  // leads nowhere - the parent is neither the root, nor in prev, nor in
  // this batch). Deleted items are warn-skipped only: they self-heal via
  // the 404 path in main.ts and are NOT counted (historical behavior).
  // Added/modified items ARE counted so walk() can self-heal by
  // invalidating the deltaLink (next sync does a full re-enumeration that
  // re-fetches them cleanly).
  const skippedItems: unknown[] = [];
  for (const { item, isDeleted, error } of pending) {
    if (isDeleted) {
      console.warn(
        "classifyDeltaItems: skipping deleted item (parse failed)",
        error instanceof Error ? error.message : error,
        JSON.stringify(item).slice(0, 200)
      );
    } else {
      skippedAddedOrModified += 1;
      skippedItems.push(item);
      console.warn(
        "classifyDeltaItems: skipping added/modified item (parse failed)",
        error instanceof Error ? error.message : error,
        JSON.stringify(item).slice(0, 200)
      );
    }
  }

  return {
    deltaEntities,
    deletedKeys,
    skippedAddedOrModified,
    skippedItems,
  };
}
