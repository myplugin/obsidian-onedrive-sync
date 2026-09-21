// License: Apache-2.0 (see src/LICENSE)

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
  item: any,
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
 *                              caller runs in id-fallback mode it passes
 *                              fromDriveItemToEntityWithIdFallback bound
 *                              with the map via closure, so a path-missing
 *                              item (added/modified OR deleted) still yields
 *                              its key via id-lookup instead of being
 *                              skipped/phantom-surviving.
 * @param idToKeyMap            Optional prev-state `remoteId -> keyRaw` map
 *                              (see buildIdToKeyMap). Intentionally NOT
 *                              consumed in this body: the fallback is
 *                              performed by the CONVERTER (closure-bound by
 *                              the caller — see walk() in fsOnedrive.ts).
 *                              The param documents the caller's intent and
 *                              reserves the seam for future direct use.
 */
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
    // Graph uses both markers 鈥?see function doc. Checking only @removed
    // leaks stale entries 鈫?404 AggregateErrors during sync operations.
    const isDeleted = "@removed" in item || "deleted" in item;
    if (isDeleted) {
      // Deleted item 鈥?extract just the key (no mtime required)
      try {
        const entity = fromDriveItemToEntity(item, remoteBaseDir, false);
        if (entity.keyRaw !== "/" && entity.keyRaw !== "") {
          deletedKeys.add(entity.keyRaw);
        }
      } catch (e) {
        // If we can't parse the key, the deletion is lost and the file
        // survives as a phantom in prevRemoteEntities 鈫?404 on next
        // sync 鈫?self-heal recovers. Log so it's diagnosable.
        console.warn(
          "classifyDeltaItems: skipping deleted item (parse failed)",
          e instanceof Error ? e.message : e,
          JSON.stringify(item).slice(0, 200)
        );
      }
    } else {
      // Added or modified item
      try {
        const entity = fromDriveItemToEntity(item, remoteBaseDir);
        if (entity.key !== "/") {
          deltaEntities.push(entity);
        }
      } catch (e) {
        // If we can't parse the key, the addition would be lost 鈥?the file
        // wouldn't appear in the merged list and sync would never pull it.
        // Count it so walk() can self-heal by invalidating the deltaLink
        // (next sync does a full re-enumeration that re-fetches it cleanly).
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
