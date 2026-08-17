// License: Apache-2.0 (see src/LICENSE)

import type { Entity } from "./baseTypes";

/**
 * Merge incremental OneDrive delta-API results with the previous full
 * remote state to reconstruct the current full remote file list.
 *
 * ## Why this exists
 *
 * `FakeFsOnedrive.walk()` used to call the Graph `/delta` endpoint from
 * scratch every sync — enumerating ALL remote files even when nothing
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
  for (const e of deltaEntities) {
    if (e.keyRaw !== undefined && e.keyRaw !== "" && e.keyRaw !== "/") {
      entityMap.set(e.keyRaw, e);
    }
  }

  // Apply deletions.
  for (const key of deletedKeys) {
    entityMap.delete(key);
  }

  return Array.from(entityMap.values());
}
