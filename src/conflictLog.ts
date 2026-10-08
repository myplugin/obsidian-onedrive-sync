// License: Apache-2.0 (see src/LICENSE)

/**
 * Conflict log written at the vault root when a push was atomically rejected
 * by OneDrive (HTTP 412 via If-Match) and sync re-routed the file to the
 * smart-conflict path (mergeFile / tryDuplicateFile).
 *
 * "C4" post-sync notification design: the re-route ABSORBS the
 * REMOTE_ETAG_MISMATCH error (sync completes without it ever reaching
 * errNotifyFunc), so sync.ts collects ConflictLogEntry items while it runs
 * and main.ts, after the sync, fires the Notice and appends them here.
 *
 * This module is deliberately dependency-free (no obsidian import):
 * appendConflictLog receives a Vault.adapter-shaped object, keeping the pure
 * formatter unit-testable under plain Node.
 */

export const CONFLICT_LOG_FILENAME = ".onedrive-sync-conflicts.log";

export interface ConflictLogEntry {
  ts: Date;
  key: string;
  walkEtag?: string;
  writeEtag?: string;
  disposition: "merged" | "duplicated" | "kept_local" | "kept_remote";
  resultFile?: string;
}

/** Pure formatter: one entry -> one log line, trailing newline included. */
export function formatConflictLogLine(e: ConflictLogEntry): string {
  const parts = [
    e.ts.toISOString(),
    e.key,
    `walkEtag=${e.walkEtag ?? "?"}`,
    `writeEtag=${e.writeEtag ?? "?"}`,
    `disposition=${e.disposition}`,
    e.resultFile ? `result=${e.resultFile}` : "",
  ].filter(Boolean);
  return parts.join(" ") + "\n";
}

/**
 * Append one line to the vault-root conflict log via an Obsidian
 * Vault.adapter-shaped object (exists/read/write). Read-modify-write is
 * acceptable here: appends happen once per sync run from a single plugin
 * instance (concurrent syncs are already guarded by isSyncing).
 */
export async function appendConflictLog(
  adapter: any,
  line: string
): Promise<void> {
  const exists = await adapter.exists(CONFLICT_LOG_FILENAME).catch(() => false);
  const prev = exists
    ? await adapter.read(CONFLICT_LOG_FILENAME).catch(() => "")
    : "";
  await adapter.write(CONFLICT_LOG_FILENAME, prev + line);
}
