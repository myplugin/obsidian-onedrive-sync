// Headless CLI `sync` command (Phase C Milestone C1b).
//
// Constructs the Node adapters (NodeFs / NodeDb) + the OneDrive remote
// (FakeFsOnedrive) + the encryption wrapper (FakeFsEncrypt, UNENCRYPTED —
// the CLI config defaults password="") and wires them into `syncer`
// (src/sync.ts:2738), the SAME entry point the plugin calls (main.ts:670).
//
// The 21 positional args mirror main.ts:670-696 field-for-field; the
// Obsidian-coupled values (UI hooks, configDir, selfPluginId) are replaced
// with CLI-sane no-ops / paths. syncObsidian* flags are FORCED false — the
// CLI syncs vault CONTENT only (spec §3.3), so the .obsidian config/plugin
// machinery the plugin walks is out of scope.

// MUST be first — sets window.moment before any src module load. (syncer →
// localdb / misc → unixTimeToStr → window.moment at runtime.) Guarded
// against double-install, so re-importing here when index.ts already
// imported it is a no-op.
import "./polyfills";

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type {
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from "../src/baseTypes";
import { FakeFsOnedrive } from "../src/fsOnedrive";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { syncer } from "../src/sync";
import { getPrevRemoteEntities } from "../src/localdb";
import { NodeFs } from "./fsLocalNode";
import { NodeDb } from "./dbNode";
import { loadConfig, saveConfig } from "./config";

export interface SyncOpts {
  vaultPath: string;
}

// Per-user, XDG-consistent state dir. NOT in the vault — keeps the vault
// clean (the plugin stores its DB in Obsidian's IndexedDB, which lives
// outside the synced vault tree; this mirrors that separation). PINNED.
function defaultDbDir(): string {
  return path.join(homedir(), ".config", "ods", "db");
}

// A STABLE per-vault id = sha1(resolved vaultPath). Stable across runs (same
// absolute path → same id), requires no storage, and is per-vault. This
// mirrors the plugin's vaultRandomID (a uuid the plugin persists in its DB)
// — the CLI derives it deterministically so a fresh `sync` needs no prior
// state. PINNED.
export function deriveVaultRandomID(vaultPath: string): string {
  return crypto.createHash("sha1").update(path.resolve(vaultPath)).digest("hex");
}

// Mirror main.ts:1906 getCurrProfileID(): `${serviceType}-default-1`.
// The plugin uses a fixed profile id per service; mirror it exactly so the
// DB table keys (keyed by vaultRandomID + profileID) match the plugin's
// scheme.
function deriveProfileID(settings: RemotelySavePluginSettings): string {
  return `${settings.serviceType}-default-1`;
}

// CLI syncs vault CONTENT only (spec §3.3). FORCE every syncObsidian* flag
// false regardless of what the config file says, so a config copied from
// the plugin (which may have these true) does NOT drag .obsidian into the
// sync tree. The plugin reads these in FakeFsLocal's constructor
// (main.ts:307-311); NodeFs has no such machinery, so the flags are
// effectively inert here — setting them false is belt-and-suspenders +
// documents intent.
function forceContentOnly(settings: RemotelySavePluginSettings): void {
  settings.syncConfigDir = false;
  settings.syncObsidianConfig = false;
  settings.syncThirdPartyPlugins = false;
  settings.syncSelfPlugin = false;
  settings.syncBookmarks = false;
  settings.syncAppearance = false;
}

// The full syncer wiring. Exported so the sync-wiring-smoke can build the
// IDENTICAL 21-arg set and assert completeness + the innerFs===fsRemote
// invariant WITHOUT calling syncer (a fake token would hit the network).
export interface SyncerArgs {
  fsLocal: NodeFs;
  fsRemote: FakeFsOnedrive;
  fsEncrypt: FakeFsEncrypt;
  profiler: undefined;
  db: NodeDb;
  triggerSource: "manual";
  profileID: string;
  vaultRandomID: string;
  configDir: string;
  selfPluginId: string;
  settings: RemotelySavePluginSettings;
  pluginVersion: string;
  configSaver: () => Promise<void>;
  getProtectModifyPercentageErrorStrFunc: (
    percentage: number,
    modified: number,
    total: number,
  ) => string;
  markIsSyncingFunc: (isSyncing: boolean) => void;
  notifyFunc: (s: SyncTriggerSourceType, step: number) => Promise<void>;
  errNotifyFunc: (s: SyncTriggerSourceType, error: Error) => Promise<void>;
  ribboonFunc: undefined;
  statusBarFunc: undefined;
  callbackSyncProcess: (
    s: SyncTriggerSourceType,
    counter: number,
    total: number,
    key: string,
    decision: string | undefined,
  ) => Promise<void>;
  isFileDirtyOpen: (filePath: string) => boolean;
}

// Build the full 21-arg set as a tuple. Shared by syncCommand (which then
// calls syncer) and the sync-wiring-smoke (which asserts but does NOT
// call). Returns a tuple typed so a missing/extra arg is a compile error.
export async function buildSyncerArgs(
  configPath: string,
  opts: SyncOpts,
): Promise<{ args: SyncerArgs; db: NodeDb; settings: RemotelySavePluginSettings }> {
  const { vaultPath } = opts;

  // --- load config + force content-only ---
  const settings = await loadConfig(configPath);
  forceContentOnly(settings);

  // --- vault identity ---
  const vaultRandomID = deriveVaultRandomID(vaultPath);
  const profileID = deriveProfileID(settings);
  const vaultName = path.basename(path.resolve(vaultPath));
  const configDir = path.join(vaultPath, ".obsidian");
  const selfPluginId = "onedrive-vault-sync";
  const pluginVersion = "0.6.33-cli";

  // --- adapters ---
  const fsLocal = new NodeFs(vaultPath);

  const dbDir = defaultDbDir();
  await fs.mkdir(dbDir, { recursive: true });
  const db = new NodeDb(dbDir);

  // prevRemoteEntities enables incremental delta enumeration (only fetch
  // changed items). main.ts:320-322 loads it before constructing the
  // remote; mirror that. getPrevRemoteEntities normalizes null→undefined
  // (localdb.ts:712), so a fresh DB yields undefined (full enumeration).
  const prevRemoteEntities = await getPrevRemoteEntities(db, vaultRandomID);

  // configSaver persists token-refresh mutations back to the CLI config
  // file. main.ts:658-667's saver persists to the DB (NOT data.json, to
  // avoid mtime ping-pong); the CLI has no data.json, so saving the whole
  // config file is the equivalent (token refresh mutates settings.onedrive
  // in place, then configSaver flushes it to disk).
  const configSaver = async () => {
    await saveConfig(configPath, settings);
  };

  // FakeFsOnedrive constructor (fsOnedrive.ts:742):
  //   (onedriveConfig, vaultName, saveUpdatedConfigFunc, prevRemoteEntities?)
  // _init is lazy — constructing does NOT touch the network.
  const fsRemote = new FakeFsOnedrive(
    settings.onedrive,
    vaultName,
    configSaver,
    prevRemoteEntities,
  );

  // FAKEFSENCRYPT — UNENCRYPTED passthrough. Mirrors main.ts:329-333
  // EXACTLY:
  //   new FakeFsEncrypt(fsRemote, settings.password ?? "",
  //                     settings.encryptionMethod ?? "rclone-base64")
  // The CLI config defaults password="" (config.ts:65) → isPasswordEmpty()
  // returns true → every encrypt/decrypt branch returns content UNCHANGED
  // (fsEncrypt.ts:191-198 _dealWithWalk, :324-332 writeFile, :367-368
  // readFile, :592-594 _encryptName). isPasswordOk() returns {ok:true} on
  // an empty or likely-unencrypted remote (fsEncrypt.ts:131-144). The
  // sync.ts:2813 invariant `fsEncrypt.innerFs !== fsRemote` is satisfied
  // because the constructor (fsEncrypt.ts:89) assigns this.innerFs=innerFs.
  const fsEncrypt = new FakeFsEncrypt(
    fsRemote,
    settings.password ?? "",
    settings.encryptionMethod ?? "rclone-base64",
  );

  // --- UI hooks: CLI no-ops (spec §4.6) ---
  const getProtectModifyPercentageErrorStrFunc = (
    _percentage: number,
    _modified: number,
    _total: number,
  ): string => {
    // No protect-modify guard in CLI (no user to prompt). Empty string →
    // the check in syncer passes (no error → proceed).
    return "";
  };
  const markIsSyncingFunc = (_isSyncing: boolean): void => {
    // No UI flag to flip in the CLI. No-op.
  };
  const notifyFunc = async (_s: SyncTriggerSourceType, step: number): Promise<void> => {
    console.log(`[sync] step ${step}`);
  };
  const errNotifyFunc = async (
    _s: SyncTriggerSourceType,
    error: Error,
  ): Promise<void> => {
    console.error(`[sync error] ${error.message}`);
  };
  const callbackSyncProcess = async (
    _s: SyncTriggerSourceType,
    counter: number,
    total: number,
    key: string,
    _decision: string | undefined,
  ): Promise<void> => {
    if (counter % 50 === 0 || counter === total) {
      console.log(`  ${counter}/${total} ${key}`);
    }
  };
  const isFileDirtyOpen = (_filePath: string): boolean => {
    // No editor in the CLI → no dirty buffers. The dirty-buffer guard
    // (sync.ts writeDupCopyForDirtyOpen) never triggers.
    return false;
  };

  const args: SyncerArgs = {
    fsLocal,
    fsRemote,
    fsEncrypt,
    profiler: undefined,
    db,
    triggerSource: "manual",
    profileID,
    vaultRandomID,
    configDir,
    selfPluginId,
    settings,
    pluginVersion,
    configSaver,
    getProtectModifyPercentageErrorStrFunc,
    markIsSyncingFunc,
    notifyFunc,
    errNotifyFunc,
    ribboonFunc: undefined,
    statusBarFunc: undefined,
    callbackSyncProcess,
    isFileDirtyOpen,
  };

  return { args, db, settings };
}

export async function syncCommand(
  configPath: string,
  opts: SyncOpts,
): Promise<void> {
  const { args, db } = await buildSyncerArgs(configPath, opts);

  // 21 positional args — matches sync.ts:2738-2778 signature + main.ts:670
  // call site field-for-field. ribboonFunc/statusBarFunc are undefined
  // (syncer treats them as optional no-ops via ?.).
  try {
    const result = await syncer(
      args.fsLocal,
      args.fsRemote,
      args.fsEncrypt,
      args.profiler,
      args.db,
      args.triggerSource,
      args.profileID,
      args.vaultRandomID,
      args.configDir,
      args.selfPluginId,
      args.settings,
      args.pluginVersion,
      args.configSaver,
      args.getProtectModifyPercentageErrorStrFunc,
      args.markIsSyncingFunc,
      args.notifyFunc,
      args.errNotifyFunc,
      args.ribboonFunc,
      args.statusBarFunc,
      args.callbackSyncProcess,
      args.isFileDirtyOpen,
    );

    // syncer returns { conflictsEncountered: ConflictLogEntry[] }
    // (sync.ts:2993). Surface a one-line summary.
    const conflicts = result?.conflictsEncountered ?? [];
    if (conflicts.length > 0) {
      console.log(
        `sync complete with ${conflicts.length} conflict(s):`,
        conflicts.map((c) => c.key).slice(0, 5).join(", "),
      );
    } else {
      console.log("sync complete, no conflicts");
    }
  } finally {
    // Clean shutdown: flush any pending DB writes (NodeDb debounces
    // setItem bursts; without flush, the last <80ms of writes would be
    // lost on process exit). Also fsEncrypt.closeResources() — the plugin
    // does this in its finally (main.ts:737); mirror it for the rclone
    // cipher case (no-op when unencrypted).
    try {
      await args.fsEncrypt.closeResources();
    } catch {
      // Best-effort — a close failure must not mask the sync result.
    }
    await db.flushAll();
  }
}
