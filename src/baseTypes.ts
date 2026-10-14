/**
 * Only type defs here.
 * To avoid circular dependency.
 */

import { Platform, requireApiVersion } from "obsidian";
import type { LangTypeAndAuto } from "./i18n";

declare global {
  var DEFAULT_ONEDRIVE_CLIENT_ID: string;
  var DEFAULT_ONEDRIVE_AUTHORITY: string;
}

// IMPORTANT: must read `global.DEFAULT_*`, NOT `window.DEFAULT_*`.
// esbuild's `define` (esbuild.config.mjs) replaces the literal token
// `global.DEFAULT_ONEDRIVE_CLIENT_ID` with the client-id string at build time.
// It does NOT define a property on the runtime `window` object — a `window.*`
// access here compiles to an undefined property read, which silently breaks
// OneDrive auth (empty auth modal: clientID resolves to "" → invalid auth URL).
// esbuild's define replaces `window.DEFAULT_ONEDRIVE_CLIENT_ID` with the
// baked-in value at build time; the `declare global` below makes TS aware of it.
declare global {
  interface Window {
    DEFAULT_ONEDRIVE_CLIENT_ID: string;
    DEFAULT_ONEDRIVE_AUTHORITY: string;
  }
}
export const ONEDRIVE_CLIENT_ID = window.DEFAULT_ONEDRIVE_CLIENT_ID;
export const ONEDRIVE_AUTHORITY = window.DEFAULT_ONEDRIVE_AUTHORITY;

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export type SUPPORTED_SERVICES_TYPE = "onedrive" | "local" | "mock";

export type SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR =
  SUPPORTED_SERVICES_TYPE;

export interface OnedriveConfig {
  accessToken: string;
  clientID: string;
  authority: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
  emptyFile: "skip" | "error";
  kind: "onedrive";
}

export type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_only"
  | "incremental_push_only"
  | "incremental_pull_and_delete_only"
  | "incremental_push_and_delete_only";

export type CipherMethodType = "rclone-base64" | "openssl-base64" | "unknown";

export interface ProfilerConfig {
  enable?: boolean;
  enablePrinting?: boolean;
  recordSize?: boolean;
}

/** Sync-on-save trigger mode. See RemotelySavePluginSettings.syncOnSaveMode. */
export type SyncOnSaveMode = "off" | "throttle" | "rateLimit";

export interface RemotelySavePluginSettings {
  onedrive: OnedriveConfig;

  password: string;
  serviceType: SUPPORTED_SERVICES_TYPE;
  currLogLevel?: string;
  autoRunEveryMilliseconds?: number;
  initRunAfterMilliseconds?: number;
  syncOnSaveAfterMilliseconds?: number;
  /**
   * Sync-on-save mode: "off" (disabled), "throttle" (the classic 3s-trailing
   * throttle that syncs if the active file changed since the last sync), or
   * "rateLimit" (sync immediately on a vault change unless a sync happened
   * within the last SYNC_ON_SAVE_RATE_LIMIT_MS, in which case drop — periodic
   * auto-sync catches up; requires autoRunEveryMilliseconds > 0).
   */
  syncOnSaveMode?: SyncOnSaveMode;

  /** Idle threshold in ms (no typing) before a deferred sync proceeds.
   *  0 = defer disabled. UI offers 0/3000/5000/10000/30000. Default 5000. */
  deferSyncIdleMs?: number;

  concurrency?: number;
  syncConfigDir?: boolean;
  syncObsidianConfig?: boolean;
  syncThirdPartyPlugins?: boolean;
  syncSelfPlugin?: boolean;
  syncBookmarks?: boolean;
  syncAppearance?: boolean;
  syncUnderscoreItems?: boolean;
  syncDotItems?: boolean;
  lang?: LangTypeAndAuto;
  agreeToUseSyncV3?: boolean;
  skipSizeLargerThan?: number;
  ignorePaths?: string[];
  onlyAllowPaths?: string[];
  enableStatusBarInfo?: boolean;
  disclaimerAcknowledged?: boolean;
  deleteToWhere?: "system" | "obsidian";
  conflictAction?: ConflictActionType;

  protectModifyPercentage?: number;
  syncDirection?: SyncDirectionType;

  obfuscateSettingFile?: boolean;

  /** Which settings fields sync across devices via synced_settings.json.
   *  Per-device (not itself synced). Undefined → DEFAULT_SYNCED_FIELDS. */
  syncedSettingFields?: string[];

  enableMobileStatusBar?: boolean;
  /** Rename tracking: detect moved files by content hash and rename on
   *  the remote instead of delete+re-upload. Default off. Disabled under
   *  encryption (ciphertext hash ≠ plaintext hash). */
  trackRenames?: boolean;

  encryptionMethod?: CipherMethodType;

  profiler?: ProfilerConfig;

  /**
   * @deprecated
   */
  agreeToUploadExtraMetadata?: boolean;

  vaultRandomID?: string;

  logToDB?: boolean;

  howToCleanEmptyFolder?: EmptyFolderCleanType;
}

export const COMMAND_URI = "onedrive-sync";
export const COMMAND_CALLBACK = "onedrive-sync-cb";
export const COMMAND_CALLBACK_ONEDRIVE = "obsidian-onedrive-sync";

/**
 * Settings/config transfer schema version, INDEPENDENT of the plugin release
 * version. Starts at 1; bump +1 ONLY on an incompatible change to the exported
 * settings shape (renamed/removed/redefined field, narrowed type). Compatible
 * changes (adding an optional field, changing a default, adding an enum value)
 * do NOT bump it — the importer fills defaults for missing fields and ignores
 * unknown ones. Import rejects when exporter and importer schema versions
 * differ. Carried in the export URI as `sv=<n>`.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export interface UriParams {
  func?: string;
  vault?: string;
  ver?: string;
  /** Settings transfer schema version (CONFIG_SCHEMA_VERSION). */
  sv?: string;
  data?: string;
}

// 80 days
export const OAUTH2_FORCE_EXPIRE_MILLISECONDS = 1000 * 60 * 60 * 24 * 80;

export type EmptyFolderCleanType = "skip" | "clean_both";

export type ConflictActionType =
  | "keep_newer"
  | "keep_larger"
  | "smart_conflict";

export type DecisionTypeForMixedEntity =
  | "only_history"
  | "equal"
  | "local_is_modified_then_push"
  | "remote_is_modified_then_pull"
  | "local_is_created_then_push"
  | "remote_is_created_then_pull"
  | "local_is_created_too_large_then_do_nothing"
  | "remote_is_created_too_large_then_do_nothing"
  | "local_is_deleted_thus_also_delete_remote"
  | "remote_is_deleted_thus_also_delete_local"
  | "conflict_created_then_keep_local"
  | "conflict_created_then_keep_remote"
  | "conflict_created_then_smart_conflict"
  | "conflict_created_then_do_nothing"
  | "conflict_modified_then_keep_local"
  | "conflict_modified_then_keep_remote"
  | "conflict_modified_then_smart_conflict"
  | "folder_existed_both_then_do_nothing"
  | "folder_existed_local_then_also_create_remote"
  | "folder_existed_remote_then_also_create_local"
  | "folder_to_be_created"
  | "folder_to_skip"
  | "folder_to_be_deleted_on_both"
  | "folder_to_be_deleted_on_remote"
  | "folder_to_be_deleted_on_local"
  | "local_moved_then_rename_remote"
  | "moved_away"
  | "folder_moved_then_rename_remote"
  | "folder_moved_away"
  | "moved_with_parent";

/**
 * uniform representation
 * everything should be flat and primitive, so that we can copy.
 */
export interface Entity {
  key?: string;
  keyEnc?: string;
  keyRaw: string;
  mtimeCli?: number;
  mtimeCliFmt?: string;
  ctimeCli?: number;
  ctimeCliFmt?: string;
  mtimeSvr?: number;
  mtimeSvrFmt?: string;
  prevSyncTime?: number;
  prevSyncTimeFmt?: string;
  size?: number; // might be unknown or to be filled
  sizeEnc?: number;
  sizeRaw: number;
  hash?: string;
  etag?: string;
  /** Graph driveItem.id — stable opaque id used by the delta id-fallback
   *  (see docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md).
   *  Undefined for entities that predate the field or came from walkPartial. */
  remoteId?: string;
  synthesizedFolder?: boolean;
  synthesizedFile?: boolean;
}

export interface UploadedType {
  entity: Entity;
  mtimeCli?: number;
}

/**
 * A replacement of FileOrFolderMixedState
 */
export interface MixedEntity {
  key: string;
  local?: Entity;
  prevSync?: Entity;
  remote?: Entity;

  decisionBranch?: number;
  decision?: DecisionTypeForMixedEntity;
  conflictAction?: ConflictActionType;

  change?: boolean;

  sideNotes?: Record<string, unknown>;
  /** The old-path key that a "local_moved_then_rename_remote" decision
   *  was matched against. Set by matchMoves; read by dispatch to call
   *  fsEncrypt.rename(movedFromKey, key). */
  movedFromKey?: string;
  /** The Graph item id (remoteId) of the source file, carried from the
   *  source's remote/prevSync entity through matchMoves to the move
   *  dispatch. Saved to the new path's prevSync record so the NEXT sync
   *  can detect ghost entries (old-path remotes left by delta merge
   *  after a move) by matching remoteId. */
  movedFromRemoteId?: string;
}

/** Optional metadata for rename operations to avoid redundant API calls.
 *  `sourceRemoteId`: the Graph item id of the file being renamed/moved,
 *    available from delta/matchMoves — skips a stat call.
 *  `targetParentRemoteId`: the Graph item id of the destination parent
 *    folder — skips a stat call. (Phase 3: plumbed from entity map.) */
export interface RenameOpts {
  sourceRemoteId?: string;
  targetParentRemoteId?: string;
}

/** A single rename/move operation for batch processing.
 *  `key1` is the old key, `key2` is the new key (both in the fs layer's
 *  native path space — encrypted for FakeFsEncrypt, plain for FakeFsLocal). */
export interface BatchRenameOp {
  key1: string;
  key2: string;
  sourceRemoteId?: string;
  targetParentRemoteId?: string;
}

/** Result of a single operation in a batch rename. */
export interface BatchRenameResult {
  ok: boolean;
  status: number;
  error?: Error;
}

/**
 * @deprecated
 */
export interface FileOrFolderMixedState {
  key: string;
  existLocal?: boolean;
  existRemote?: boolean;
  mtimeLocal?: number;
  mtimeRemote?: number;
  deltimeLocal?: number;
  deltimeRemote?: number;
  sizeLocal?: number;
  sizeLocalEnc?: number;
  sizeRemote?: number;
  sizeRemoteEnc?: number;
  changeRemoteMtimeUsingMapping?: boolean;
  changeLocalMtimeUsingMapping?: boolean;
  decision?: string; // old DecisionType is deleted, fallback to string
  decisionBranch?: number;
  syncDone?: "done";
  remoteEncryptedKey?: string;

  mtimeLocalFmt?: string;
  mtimeRemoteFmt?: string;
  deltimeLocalFmt?: string;
  deltimeRemoteFmt?: string;
}

export const DEFAULT_DEBUG_FOLDER = "_onedrive_sync_debug/";
/** Legacy debug folder name from the upstream "remotely-save" project. Still
 * excluded from sync so an old folder doesn't suddenly start syncing. */
export const LEGACY_DEBUG_FOLDER = "_debug_remotely_save/";
/** True when a vault-relative path lives under the debug export folder
 * (current or legacy name). Pure helper shared by fsLocal.walk and
 * syncDiagnose so both use the exact same rule. */
export const isDebugFolderPath = (key: string): boolean =>
  key.startsWith(DEFAULT_DEBUG_FOLDER) || key.startsWith(LEGACY_DEBUG_FOLDER);
export const DEFAULT_SYNC_DECISIONS_FILE_PREFIX =
  "sync_decisions_exported_on_";
export const DEFAULT_LOG_HISTORY_FILE_PREFIX = "log_hist_exported_on_";
export const DEFAULT_PROFILER_RESULT_FILE_PREFIX =
  "profiler_results_exported_on_";

export type SyncTriggerSourceType =
  | "manual"
  | "dry"
  | "auto"
  | "auto_once_init"
  | "auto_sync_on_save";

export const REMOTELY_SAVE_VERSION_2022 = "0.3.25";
export const REMOTELY_SAVE_VERSION_2024PREPARE = "0.3.32";

export const API_VER_STAT_FOLDER = "0.13.27";
export const API_VER_REQURL = "0.13.26"; // desktop ver 0.13.26, iOS ver 1.1.1
export const API_VER_REQURL_ANDROID = "0.14.6"; // Android ver 1.2.1
export const API_VER_ENSURE_REQURL_OK = "1.0.0"; // always bypass CORS here

export const VALID_REQURL =
  (!Platform.isAndroidApp && requireApiVersion(API_VER_REQURL)) ||
  (Platform.isAndroidApp && requireApiVersion(API_VER_REQURL_ANDROID));
