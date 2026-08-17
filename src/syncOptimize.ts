// License: Apache-2.0 (see src/LICENSE)

import type { Entity, MixedEntity } from "./baseTypes";

/**
 * The $select parameter value for delta queries. Requests only the fields
 * that fromDriveItemToEntity actually reads, reducing the JSON payload by
 * ~60% for large vaults (drops cTag, eTag, etc.).
 */
export const DELTA_SELECT =
  "$select=id,name,size,fileSystemInfo,folder,file,parentReference";

/**
 * Build the start URL for a delta query.
 *
 * When doing an incremental query (canIncremental=true), the deltaLink MUST
 * be used as-is. The Graph API generates the deltaLink to include whatever
 * query parameters were in the original request (including $select). If we
 * append $select again, the URL has a duplicate parameter and the Graph API
 * returns HTTP 400 Bad Request.
 *
 * When doing a full enumeration (canIncremental=false), $select is safe to
 * include because it's the first (and only) time $select appears in the URL.
 */
export function buildDeltaStartUrl(
  canIncremental: boolean,
  deltaLink: string,
  remoteBaseDir: string
): string {
  if (canIncremental) {
    // Use the deltaLink AS-IS. Do NOT append any query parameters.
    // The deltaLink already includes whatever the server thinks is needed.
    return deltaLink;
  }
  // Full enumeration — $select is safe here (first occurrence in the URL).
  return `/drive/special/approot:/${remoteBaseDir}:/delta?${DELTA_SELECT}`;
}

/**
 * Determine whether a sync can be safely skipped because nothing changed
 * on either side.
 *
 * This is the "early exit" optimization for the sync algorithm. After the
 * remote walk (which may use the OneDrive delta API) and the local walk,
 * if the delta returned 0 items (remote unchanged) AND every local file's
 * mtime+size matches the previous sync record (local unchanged), there is
 * nothing to sync — the sync plan would be entirely "do nothing".
 *
 * Skipping the sync plan building + PQueue execution + DB writes saves
 * O(N) work for the common "no changes" case, reducing sync time from
 * seconds to <1s.
 *
 * @param remoteDeltaCount  Number of items returned by the delta API.
 *                          0 = incremental query returned no changes.
 *                          undefined = full enumeration (first sync or
 *                          deltaLink expired) — cannot skip.
 * @param localEntityList   Current local file list from fsLocal.walk().
 * @param prevSyncEntityList Previous sync records from the DB.
 * @returns true if the sync can be safely skipped (no changes on either side).
 */
export function shouldSkipSync(
  remoteDeltaCount: number | undefined,
  localEntityList: Entity[],
  prevSyncEntityList: Entity[]
): boolean {
  // Only skip for incremental queries with 0 remote changes.
  // undefined = full enumeration (first sync or deltaLink expired).
  if (remoteDeltaCount !== 0) {
    return false;
  }

  // Quick count check: if counts differ, there are additions or deletions.
  if (localEntityList.length !== prevSyncEntityList.length) {
    return false;
  }

  // Build a map of prevSync entities by key for O(1) lookup.
  const prevSyncMap = new Map<string, Entity>();
  for (const e of prevSyncEntityList) {
    if (e.key !== undefined) {
      prevSyncMap.set(e.key, e);
    }
  }

  // Check each local entity against prevSync.
  for (const localEntity of localEntityList) {
    const key = localEntity.key;
    if (key === undefined) {
      // Can't compare without a key — don't skip.
      return false;
    }

    const prevEntity = prevSyncMap.get(key);
    if (prevEntity === undefined) {
      // Key not in prevSync — new file, don't skip.
      return false;
    }

    // For files (not folders), compare mtime and size.
    // Folders don't have meaningful mtime/size in Obsidian.
    if (!key.endsWith("/")) {
      if (localEntity.mtimeCli !== prevEntity.mtimeCli) {
        return false;
      }
      if (localEntity.size !== prevEntity.size) {
        return false;
      }
    }
  }

  // All checks passed — safe to skip sync.
  return true;
}

const UPLOAD_DECISIONS = new Set([
  "local_is_modified_then_push",
  "local_is_created_then_push",
  "conflict_created_then_keep_local",
  "conflict_modified_then_keep_local",
  // Smart conflicts do both upload+download internally via mergeFile;
  // put in uploads queue to avoid deadlock with download queue.
  "conflict_created_then_smart_conflict",
  "conflict_modified_then_smart_conflict",
]);

const DOWNLOAD_DECISIONS = new Set([
  "remote_is_modified_then_pull",
  "remote_is_created_then_pull",
  "conflict_created_then_keep_remote",
  "conflict_modified_then_keep_remote",
]);

/**
 * Split a mixed list of upload/download operations into two separate lists
 * for dual-queue parallel execution. Uploads and downloads use different
 * network resources (upload vs download bandwidth), so running them in
 * parallel effectively doubles throughput when both are present.
 *
 * Smart conflicts go to the uploads queue because they internally trigger
 * downloads (via mergeFile/tryDuplicateFile); putting them in the download
 * queue could cause ordering issues.
 *
 * Unknown/undefined decisions default to uploads as a safe fallback.
 */
export function splitUploadDownloadOps(
  ops: MixedEntity[]
): { uploads: MixedEntity[]; downloads: MixedEntity[] } {
  const uploads: MixedEntity[] = [];
  const downloads: MixedEntity[] = [];
  for (const op of ops) {
    const decision = op.decision ?? "";
    if (DOWNLOAD_DECISIONS.has(decision)) {
      downloads.push(op);
    } else {
      // UPLOAD_DECISIONS or unknown — fallback to uploads
      uploads.push(op);
    }
  }
  return { uploads, downloads };
}
