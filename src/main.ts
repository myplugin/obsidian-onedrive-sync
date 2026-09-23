// biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
import AggregateError from "aggregate-error";
import cloneDeep from "lodash/cloneDeep";
import throttle from "lodash/throttle";
import { FileText, RefreshCcw, RotateCcw, createElement } from "lucide";
import {
  Events,
  FileSystemAdapter,
  type Modal,
  Notice,
  Platform,
  Plugin,
  type Setting,
  TFolder,
  addIcon,
  requireApiVersion,
  setIcon,
} from "obsidian";
import type {
  OnedriveConfig,
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_ONEDRIVE,
  COMMAND_URI,
} from "./baseTypes";
import { API_VER_ENSURE_REQURL_OK } from "./baseTypes";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { appendConflictLog, formatConflictLogLine } from "./conflictLog";
import { exportVaultSyncPlansToFiles } from "./debugMode";
import { FakeFsEncrypt } from "./fsEncrypt";
import { getClient } from "./fsGetter";
import { FakeFsLocal } from "./fsLocal";
import {
  type AccessCodeResponseSuccessfulType as AccessCodeResponseSuccessfulTypeOnedrive,
  DEFAULT_ONEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqOnedrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedrive,
} from "./fsOnedrive";
import { I18n } from "./i18n";
import type { LangTypeAndAuto, TransItemType } from "./i18n";
import { importQrCodeUri } from "./importExport";
import {
  type InternalDBs,
  type OnedriveAuthFields,
  clearAllLoggerOutputRecords,
  clearExpiredSyncPlanRecords,
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  getOnedriveAuthByVault,
  getPrevRemoteEntities,
  prepareDBs,
  savePrevRemoteEntities,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
  upsertOnedriveAuthByVault,
  upsertPluginVersionByVault,
} from "./localdb";
import { changeMobileStatusBar } from "./misc";
import { DEFAULT_PROFILER_CONFIG, Profiler } from "./profiler";
import { RemotelySaveSettingTab } from "./settings";
import { syncer } from "./sync";
import { SyncAlgoV3Modal } from "./syncAlgoV3Notice";
import {
  SYNC_ON_SAVE_RATE_LIMIT_MS,
  deriveSyncOnSaveMode,
  shouldRateLimitSync,
} from "./syncOptimize";
import {
  DEFAULT_SYNCED_FIELDS,
  applySyncedFields,
  projectSyncableFields,
  stripPasswordInPlace,
} from "./syncSettings";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  onedrive: DEFAULT_ONEDRIVE_CONFIG,
  password: "",
  serviceType: "onedrive",
  currLogLevel: "info",
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  // NOTE: syncOnSaveMode is intentionally NOT defaulted here. loadSettings
  // merges DEFAULT_SETTINGS into loaded data via Object.assign, so a default
  // here would make the back-compat migration (deriveSyncOnSaveMode) never
  // run — silently disabling sync-on-save for upgraders. The migration
  // derives "off" for new users from the default syncOnSaveAfterMilliseconds=-1.
  agreeToUploadExtraMetadata: true, // as of 20240106, it's safe to assume every new user agrees with this
  concurrency: 5,
  syncConfigDir: false,
  syncObsidianConfig: true,
  syncThirdPartyPlugins: true,
  syncSelfPlugin: true,
  syncBookmarks: false,
  syncAppearance: false,
  syncUnderscoreItems: false,
  syncDotItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  ignorePaths: [],
  onlyAllowPaths: [],
  enableStatusBarInfo: true,
  disclaimerAcknowledged: false,
  deleteToWhere: "system",
  agreeToUseSyncV3: false,
  conflictAction: "keep_newer",
  howToCleanEmptyFolder: "clean_both",
  protectModifyPercentage: 50,
  syncDirection: "bidirectional",
  obfuscateSettingFile: true,
  syncedSettingFields: [...DEFAULT_SYNCED_FIELDS],
  enableMobileStatusBar: false,
  trackRenames: false,
  encryptionMethod: "unknown",
  profiler: DEFAULT_PROFILER_CONFIG,
};

interface OAuth2Info {
  verifier?: string;
  helperModal?: Modal;
  authDiv?: HTMLElement;
  revokeDiv?: HTMLElement;
  revokeAuthSetting?: Setting;
}

const iconNameSyncWait = `remotely-save-sync-wait`;
const iconNameSyncRunning = `remotely-save-sync-running`;
const iconNameLogs = `remotely-save-logs`;

const getIconSvg = () => {
  const iconSvgSyncWait = createElement(RotateCcw);
  iconSvgSyncWait.setAttribute("width", "100");
  iconSvgSyncWait.setAttribute("height", "100");
  const iconSvgSyncRunning = createElement(RefreshCcw);
  iconSvgSyncRunning.setAttribute("width", "100");
  iconSvgSyncRunning.setAttribute("height", "100");
  const iconSvgLogs = createElement(FileText);
  iconSvgLogs.setAttribute("width", "100");
  iconSvgLogs.setAttribute("height", "100");
  const res = {
    iconSvgSyncWait: iconSvgSyncWait.outerHTML,
    iconSvgSyncRunning: iconSvgSyncRunning.outerHTML,
    iconSvgLogs: iconSvgLogs.outerHTML,
  };

  iconSvgSyncWait.empty();
  iconSvgSyncRunning.empty();
  iconSvgLogs.empty();
  return res;
};

const getStatusBarShortMsgFromSyncSource = (
  t: (x: TransItemType, vars?: any) => string,
  s: SyncTriggerSourceType | undefined
) => {
  if (s === undefined) {
    return "";
  }
  switch (s) {
    case "manual":
      return t("statusbar_sync_source_manual");
    case "dry":
      return t("statusbar_sync_source_dry");
    case "auto":
      return t("statusbar_sync_source_auto");
    case "auto_once_init":
      return t("statusbar_sync_source_auto_once_init");
    case "auto_sync_on_save":
      return t("statusbar_sync_source_auto_sync_on_save");
    default:
      throw Error(`no translate for ${s}`);
  }
};

export default class RemotelySavePlugin extends Plugin {
  settings!: RemotelySavePluginSettings;
  db!: InternalDBs;
  isSyncing!: boolean;
  hasPendingSyncOnSave!: boolean;
  lastModifiedFile: any = null;
  // In-memory cache of the last successful sync time (ms) for the rate-limit
  // sync-on-save handler — avoids an IndexedDB read on every vault event.
  // undefined = not yet loaded this session (lazy DB read on first use);
  // null = loaded and never synced; number = the time. Updated synchronously
  // on sync completion in statusBarFunc step 8.
  lastSuccessSyncMs?: number | null;
  // Coalesces bursts (bulk rename / find-replace fire N events): while one
  // rate-limit check/sync is running, drop the rest — prevents N duplicate
  // syncRun setup passes before syncRun's own isSyncing guard dedupes them.
  rateLimitTriggerInFlight = false;
  statusBarElement!: HTMLSpanElement;
  oauth2Info!: OAuth2Info;
  currLogLevel!: string;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  syncOnSaveIntervalID?: number;
  i18n!: I18n;
  vaultRandomID!: string;
  debugServerTemp?: string;
  syncEvent?: Events;
  appContainerObserver?: MutationObserver;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    let profiler: Profiler | undefined = undefined;
    if (this.settings.profiler?.enable ?? false) {
      profiler = new Profiler(
        undefined,
        this.settings.profiler?.enablePrinting ?? false,
        this.settings.profiler?.recordSize ?? false
      );
    }
    const fsLocal = new FakeFsLocal(
      this.app.vault,
      this.settings.syncObsidianConfig ?? true,
      this.settings.syncThirdPartyPlugins ?? true,
      this.settings.syncSelfPlugin ?? true,
      this.settings.syncBookmarks ?? false,
      this.settings.syncAppearance ?? false,
      this.app.vault.configDir,
      this.manifest.id,
      profiler,
      this.settings.deleteToWhere ?? "system"
    );
    // Load the previous sync's full remote entity list to enable
    // incremental delta enumeration (only fetch changed items from OneDrive
    // instead of re-listing all remote files every sync).
    const prevRemoteEntities = this.isDbReady()
      ? await getPrevRemoteEntities(this.db, this.vaultRandomID)
      : undefined;
    const fsRemote = getClient(
      this.settings,
      this.app.vault.getName(),
      async () => await this.saveSettings(),
      prevRemoteEntities
    );
    const fsEncrypt = new FakeFsEncrypt(
      fsRemote,
      this.settings.password ?? "",
      this.settings.encryptionMethod ?? "rclone-base64"
    );

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    const profileID = this.getCurrProfileID();

    const getProtectError = (
      protectModifyPercentage: number,
      realModifyDeleteCount: number,
      allFilesCount: number
    ) => {
      const percent = ((100 * realModifyDeleteCount) / allFilesCount).toFixed(
        1
      );
      const res = t("syncrun_abort_protectmodifypercentage", {
        protectModifyPercentage,
        realModifyDeleteCount,
        allFilesCount,
        percent,
      });
      return res;
    };

    const getNotice = (
      s: SyncTriggerSourceType,
      msg: string,
      timeout?: number
    ) => {
      if (s === "manual" || s === "dry") {
        new Notice(msg, timeout);
      }
    };

    const notifyFunc = async (s: SyncTriggerSourceType, step: number) => {
      switch (step) {
        case 0:
          if (s === "dry") {
            if (this.settings.currLogLevel === "info") {
              getNotice(s, t("syncrun_shortstep0"));
            } else {
              getNotice(s, t("syncrun_step0"));
            }
          }

          break;

        case 1:
          if (this.settings.currLogLevel === "info") {
            getNotice(
              s,
              t("syncrun_shortstep1", {
                serviceType: this.settings.serviceType,
              })
            );
          } else {
            getNotice(
              s,
              t("syncrun_step1", {
                serviceType: this.settings.serviceType,
              })
            );
          }
          break;

        case 2:
          if (this.settings.currLogLevel === "info") {
            // pass
          } else {
            getNotice(s, t("syncrun_step2"));
          }
          break;

        case 3:
          if (this.settings.currLogLevel === "info") {
            // pass
          } else {
            getNotice(s, t("syncrun_step3"));
          }
          break;

        case 4:
          if (this.settings.currLogLevel === "info") {
            // pass
          } else {
            getNotice(s, t("syncrun_step4"));
          }
          break;

        case 5:
          if (this.settings.currLogLevel === "info") {
            // pass
          } else {
            getNotice(s, t("syncrun_step5"));
          }
          break;

        case 6:
          if (this.settings.currLogLevel === "info") {
            // pass
          } else {
            getNotice(s, t("syncrun_step6"));
          }
          break;

        case 7:
          if (s === "dry") {
            if (this.settings.currLogLevel === "info") {
              getNotice(s, t("syncrun_shortstep2skip"));
            } else {
              getNotice(s, t("syncrun_step7skip"));
            }
          } else {
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step7"));
            }
          }
          break;

        case 8:
          if (this.settings.currLogLevel === "info") {
            getNotice(s, t("syncrun_shortstep2"));
          } else {
            getNotice(s, t("syncrun_step8"));
          }
          break;

        default:
          throw Error(`unknown step=${step} for showing notice`);
      }
    };

    const errNotifyFunc = async (s: SyncTriggerSourceType, error: Error) => {
      console.error(error);

      // Self-heal: when the sync hits 404 on files that were in the walk
      // result but no longer exist on OneDrive (stale incremental delta
      // merge — the delta API's eventual consistency hasn't reflected
      // deletions from the previous sync), clear the stale state so the
      // NEXT sync does a full enumeration and gets the correct file list.
      // This is the same mechanism as the plugin-restart workaround
      // (main.ts onload clears prevRemoteEntities), but automatic and
      // scoped to the exact error — no manual restart needed.
      const selfHealStaleDelta = async () => {
        try {
          if (this.isDbReady()) {
            await this.db.simpleKVForMiscTbl.removeItem(
              `${this.vaultRandomID}-prevRemoteEntities`
            );
          }
          this.settings.onedrive.deltaLink = "";
          await this.saveSettings();
          console.info(
            "Self-heal: cleared prevRemoteEntities + deltaLink after " +
              "REMOTE_NOT_FOUND. Next sync will do full enumeration."
          );
        } catch (e) {
          console.error("Self-heal failed:", e);
        }
      };

      if (error instanceof AggregateError) {
        // Partition into 404 "file deleted since walk" vs other errors.
        const notFound: any[] = [];
        const others: Error[] = [];
        for (const e of error.errors) {
          if ((e as any)?.code === "REMOTE_NOT_FOUND") {
            notFound.push(e);
          } else {
            others.push(e);
          }
        }
        // Aggregated notice for files deleted on OneDrive mid-sync
        if (notFound.length > 0) {
          const keys = notFound.map((e) => e.key as string).filter(Boolean);
          const shown =
            keys.length > 5
              ? `${keys.slice(0, 5).join(", ")}, … (+${keys.length - 5} more)`
              : keys.join(", ");
          const msg =
            others.length === 0
              ? `${notFound.length} file(s) were deleted on OneDrive since the sync started — skipped. Next sync will re-scan and catch up.\n${shown}`
              : `${notFound.length} file(s) deleted on OneDrive since sync started (skipped): ${shown}`;
          // Always show errors, even for auto-sync — getNotice suppresses
          // non-manual triggers, but errors must never be silent.
          new Notice(msg, 10 * 1000);
          // Invalidate stale delta state for the next sync
          await selfHealStaleDelta();
        }
        // Show remaining (non-404) errors individually
        for (const e of others) {
          new Notice(e.message, 10 * 1000);
        }
      } else {
        // Single error — check if it's a REMOTE_NOT_FOUND
        if ((error as any)?.code === "REMOTE_NOT_FOUND") {
          await selfHealStaleDelta();
        }
        // Always show errors, even for auto-sync.
        new Notice(error?.message ?? "error while sync", 10 * 1000);
      }
    };

    const ribboonFunc = async (s: SyncTriggerSourceType, step: number) => {
      if (step === 1) {
        if (this.syncRibbon !== undefined) {
          setIcon(this.syncRibbon, iconNameSyncRunning);
          this.syncRibbon.setAttribute(
            "aria-label",
            t("syncrun_syncingribbon", {
              pluginName: this.manifest.name,
              triggerSource: s,
            })
          );
        }
      } else if (step === 8) {
        // last step
        if (this.syncRibbon !== undefined) {
          setIcon(this.syncRibbon, iconNameSyncWait);
          const originLabel = `${this.manifest.name}`;
          this.syncRibbon.setAttribute("aria-label", originLabel);
        }
      }
    };

    const statusBarFunc = async (
      s: SyncTriggerSourceType,
      step: number,
      everythingOk: boolean
    ) => {
      if (step === 1) {
        // change status to "syncing..." on statusbar
        this.updateLastSyncMsg(s, "syncing", -1, -1);
      } else if (step === 8 && everythingOk) {
        const ts = Date.now();
        await upsertLastSuccessSyncTimeByVault(this.db, this.vaultRandomID, ts);
        // Keep the rate-limit handler's in-memory cache fresh so it can
        // decide eligibility without an extra DB read per vault event.
        this.lastSuccessSyncMs = ts;
        this.updateLastSyncMsg(s, "not_syncing", ts, null); // hack: 'not_syncing'
      } else if (!everythingOk) {
        const ts = Date.now();
        await upsertLastFailedSyncTimeByVault(this.db, this.vaultRandomID, ts);
        this.updateLastSyncMsg(s, "not_syncing", null, ts);
      }
    };

    const markIsSyncingFunc = async (isSyncing: boolean) => {
      this.isSyncing = isSyncing;
    };

    const callbackSyncProcess = async (
      s: SyncTriggerSourceType,
      realCounter: number,
      realTotalCount: number,
      pathName: string,
      decision: string
    ) => {
      this.setCurrSyncMsg(
        t,
        s,
        realCounter,
        realTotalCount,
        pathName,
        decision,
        triggerSource
      );
    };

    if (this.isSyncing) {
      getNotice(
        triggerSource,
        t("syncrun_alreadyrunning", {
          pluginName: this.manifest.name,
          syncStatus: "running",
          newTriggerSource: triggerSource,
        })
      );

      if (this.currSyncMsg !== undefined && this.currSyncMsg !== "") {
        getNotice(triggerSource, this.currSyncMsg);
      }
      return;
    }

    const configSaver = async () => {
      // persist device-specific onedrive auth to the DB only — do NOT touch
      // data.json here (token refresh must not bump data.json's mtime, or the
      // config-dir sync sees a false "local modified" → ping-pong conflict).
      await upsertOnedriveAuthByVault(
        this.db,
        this.vaultRandomID,
        this.extractOnedriveAuth()
      );
    };

    try {
      const syncResult = await syncer(
        fsLocal,
        fsRemote,
        fsEncrypt,
        profiler,
        this.db,
        triggerSource,
        profileID,
        this.vaultRandomID,
        this.app.vault.configDir,
        this.manifest.id,
        this.settings,
        this.manifest.version,
        configSaver,
        getProtectError,
        markIsSyncingFunc,
        notifyFunc,
        errNotifyFunc,
        ribboonFunc,
        statusBarFunc,
        callbackSyncProcess
      );
      // C4 (Task 7): the REMOTE_ETAG_MISMATCH (412) re-route inside sync.ts
      // ABSORBS the error — the sync completes without it ever reaching
      // errNotifyFunc. Check the collected re-route entries post-sync to
      // notify the user and append to the vault-root conflict log.
      try {
        const conflicts = syncResult?.conflictsEncountered ?? [];
        if (conflicts.length > 0) {
          const names = conflicts
            .map((entry) => entry.key)
            .slice(0, 5)
            .join(", ");
          new Notice(t("conflict_resolved_notice", { names }), 10 * 1000);
          const adapter = this.app.vault.adapter;
          for (const entry of conflicts) {
            await appendConflictLog(adapter, formatConflictLogLine(entry));
          }
        }
      } catch (conflictLogErr) {
        // Best-effort: a failed notice/log append must never turn a
        // successful sync (conflicts already merged/duplicated) into an
        // error path.
        console.error("conflict log append failed:", conflictLogErr);
      }
    } finally {
      // Ensure resource cleanup, prevRemoteEntities save, and SYNC_DONE
      // always run — even if syncer throws. Without this, a throw skips
      // fsEncrypt.closeResources() (resource leak) and SYNC_DONE (blocks
      // syncOnSave + sidecar reconciliation listeners).
      try {
        fsEncrypt.closeResources();

        // Save the remote entity list so the next sync can use it for
        // incremental delta enumeration (only fetch changed items).
        // Proactively remove files deleted on OneDrive during this sync
        // so prevRemoteEntities doesn't contain phantom entries that
        // would cause 404 on the next sync (OneDrive delta API eventual
        // consistency may not reflect the deletions yet).
        if (fsRemote.lastWalkResult && this.isDbReady()) {
          const deletedKeys = fsRemote.deletedRemotelyKeys;
          const entities =
            deletedKeys.size > 0
              ? fsRemote.lastWalkResult.filter(
                  (e) => !deletedKeys.has(e.keyRaw)
                )
              : [...fsRemote.lastWalkResult];
          // Merge in files uploaded during this sync so the next sync's
          // delta merge has them even if the OneDrive delta API hasn't
          // reflected the uploads yet (eventual consistency lag).
          if (fsRemote.uploadedEntities.length > 0) {
            const existingKeys = new Set(entities.map((e) => e.keyRaw));
            for (const uploaded of fsRemote.uploadedEntities) {
              if (!existingKeys.has(uploaded.keyRaw)) {
                entities.push(uploaded);
              }
            }
          }
          await savePrevRemoteEntities(this.db, this.vaultRandomID, entities);
        }
      } catch (cleanupErr) {
        console.error("Error during post-sync cleanup:", cleanupErr);
      }

      (profiler as Profiler | undefined)?.clear();

      this.syncEvent?.trigger("SYNC_DONE");
    }
  }

  async onload() {
    console.info(`loading plugin ${this.manifest.id}`);

    const { iconSvgSyncWait, iconSvgSyncRunning, iconSvgLogs } = getIconSvg();

    addIcon(iconNameSyncWait, iconSvgSyncWait);
    addIcon(iconNameSyncRunning, iconSvgSyncRunning);
    addIcon(iconNameLogs, iconSvgLogs);

    this.oauth2Info = {
      verifier: "",
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    }; // init

    this.currSyncMsg = "";
    this.isSyncing = false;
    this.hasPendingSyncOnSave = false;

    this.syncEvent = new Events();

    // Reconcile the synced_settings.json sidecar after every sync run — the
    // design-level clobber fix: re-read the sidecar into in-memory settings +
    // persist to data.json, so memory never goes stale over a freshly-pulled
    // config. Fires only on SYNC_DONE (post-sync, DB ready).
    this.registerEvent(
      this.syncEvent?.on("SYNC_DONE", this._reconcileSidecar)!
    );

    await this.loadSettings();

    // MUST after loadSettings and before prepareDB
    const profileID: string = this.getCurrProfileID();

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang!, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    await this.checkIfOauthExpires();

    // MUST before prepareDB()
    // And, it's also possible to be an empty string,
    // which means the vaultRandomID is read from db later!
    const vaultRandomIDFromOldConfigFile =
      await this.getVaultRandomIDFromOldConfigFile();

    // no need to await this
    this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(
        vaultBasePath,
        vaultRandomIDFromOldConfigFile,
        profileID
      );
    } catch (err: any) {
      new Notice(
        err?.message ?? "error of prepareDBAndVaultRandomID",
        10 * 1000
      );
      throw err;
    }

    // must AFTER preparing DB: merge device-specific onedrive auth from the
    // DB (or migrate from data.json on first run). The token no longer lives
    // in synced data.json, so we load it from the device-local DB here.
    await this.mergeOnedriveAuthFromDBOrMigrate();

    // Clear the prevRemoteEntities cache on every plugin load. This is the
    // full remote entity list from the last sync's walk(), used for
    // incremental delta enumeration. Clearing on load ensures the first
    // sync after reload always does a full (correct) enumeration, preventing
    // any stale or corrupted state from causing incorrect incremental merges.
    // Subsequent syncs within the same session still benefit from incremental
    // mode. The cost is one full enumeration per plugin reload (~3-7s for
    // 2500 files), which is the same as the pre-optimization behavior.
    if (this.isDbReady()) {
      await this.db.simpleKVForMiscTbl.removeItem(
        `${this.vaultRandomID}-prevRemoteEntities`
      );
    }

    // must AFTER preparing DB
    this.enableAutoClearOutputToDBHistIfSet();

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist();

    if ((this.app as any).plugins?.enabledPlugins?.has("remotely-save")) {
      new Notice(t("conflict_with_remotely_save"), 10000);
      return;
    }

    this.registerObsidianProtocolHandler(COMMAND_URI, async (inputParams) => {
      // console.debug(inputParams);
      const parsed = importQrCodeUri(inputParams, this.app.vault.getName());
      if (parsed.status === "error") {
        new Notice(parsed.message);
      } else {
        const copied = cloneDeep(parsed.result);
        // new Notice(JSON.stringify(copied))
        this.settings = Object.assign({}, this.settings, copied);
        this.saveSettings();
        new Notice(
          t("protocol_saveqr", {
            manifestName: this.manifest.name,
          })
        );
      }
    });

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK,
      async (inputParams) => {
        new Notice(
          t("protocol_callbacknotsupported", {
            params: JSON.stringify(inputParams),
          })
        );
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_ONEDRIVE,
      async (inputParams) => {
        if (
          inputParams.code !== undefined &&
          this.oauth2Info?.verifier !== undefined
        ) {
          if (this.oauth2Info.helperModal !== undefined) {
            const k = this.oauth2Info.helperModal.contentEl;
            k.empty();

            t("protocol_onedrive_connecting")
              .split("\n")
              .forEach((val) => {
                k.createEl("p", {
                  text: val,
                });
              });
          }

          const rsp = await sendAuthReqOnedrive(
            this.settings.onedrive.clientID,
            this.settings.onedrive.authority,
            inputParams.code,
            this.oauth2Info.verifier,
            async (e: any) => {
              new Notice(t("protocol_onedrive_connect_fail"));
              new Notice(`${e}`);
              return; // throw?
            }
          );

          if ((rsp as any).error !== undefined) {
            new Notice(`${JSON.stringify(rsp)}`);
            throw Error(`${JSON.stringify(rsp)}`);
          }

          const self = this;
          setConfigBySuccessfullAuthInplaceOnedrive(
            this.settings.onedrive,
            rsp as AccessCodeResponseSuccessfulTypeOnedrive,
            () => self.saveSettings()
          );

          const client = getClient(
            this.settings,
            this.app.vault.getName(),
            () => self.saveSettings()
          );
          this.settings.onedrive.username = await client.getUserDisplayName();
          await this.saveSettings();

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "onedrive-auth-button-hide",
            this.settings.onedrive.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_onedrive_connect_succ_revoke", {
              username: this.settings.onedrive.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "onedrive-revoke-auth-button-hide",
            this.settings.onedrive.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_onedrive_connect_fail"));
          throw Error(
            t("protocol_onedrive_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    this.enableMobileStatusBarIfSet();

    // Create Status Bar Item
    if (
      (!Platform.isMobile ||
        (Platform.isMobile && this.settings.enableMobileStatusBar)) &&
      this.settings.enableStatusBarInfo === true
    ) {
      const statusBarItem = this.addStatusBarItem();
      this.statusBarElement = statusBarItem.createEl("span");
      this.statusBarElement.setAttribute("data-tooltip-position", "top");

      if (!this.isSyncing) {
        this.updateLastSyncMsg(
          undefined,
          "not_syncing",
          await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
          await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
        );
      }
      // update statusbar text every 30 seconds
      this.registerInterval(
        window.setInterval(async () => {
          if (!this.isSyncing) {
            this.updateLastSyncMsg(
              undefined,
              "not_syncing",
              await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
              await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
            );
          }
        }, 1000 * 30)
      );
    }

    this.addCommand({
      id: "start-sync",
      name: t("command_startsync"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("manual");
      },
    });

    this.addCommand({
      id: "start-sync-dry-run",
      name: t("command_drynrun"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("dry");
      },
    });

    this.addCommand({
      id: "export-sync-plans-1-only-change",
      name: t("command_exportsyncplans_1_only_change"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          true
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-1",
      name: t("command_exportsyncplans_1"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-5",
      name: t("command_exportsyncplans_5"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          5,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-all",
      name: t("command_exportsyncplans_all"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          -1,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addSettingTab(new RemotelySaveSettingTab(this.app, this));

    // this.registerDomEvent(document, "click", (evt: MouseEvent) => {
    //   console.info("click", evt);
    // });

    this.enableCheckingFileStat();

    if (!this.settings.agreeToUseSyncV3) {
      const syncAlgoV3Modal = new SyncAlgoV3Modal(this.app, this);
      syncAlgoV3Modal.open();
    } else {
      this.enableAutoSyncIfSet();
      this.enableInitSyncIfSet();
      this.toggleSyncOnSaveIfSet();
    }

    // compare versions and read new versions
    const { oldVersion } = await upsertPluginVersionByVault(
      this.db,
      this.vaultRandomID,
      this.manifest.version
    );
  }

  async onunload() {
    console.info(`unloading plugin ${this.manifest.id}`);
    this.syncRibbon = undefined;
    if (this.appContainerObserver !== undefined) {
      this.appContainerObserver.disconnect();
      this.appContainerObserver = undefined;
    }
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = {
        verifier: "",
        helperModal: undefined,
        authDiv: undefined,
        revokeDiv: undefined,
        revokeAuthSetting: undefined,
      };
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );

    if (this.settings.syncedSettingFields === undefined) {
      this.settings.syncedSettingFields = [...DEFAULT_SYNCED_FIELDS];
    }
    // sidecar (cross-device) values win for the user-selected fields
    const sidecar = await this.readSidecar();
    if (sidecar !== null) {
      applySyncedFields(
        this.settings,
        sidecar,
        this.settings.syncedSettingFields
      );
    }

    if (this.settings.syncBookmarks === undefined) {
      this.settings.syncBookmarks = false;
    }

    if (this.settings.onedrive.clientID === "") {
      this.settings.onedrive.clientID = DEFAULT_SETTINGS.onedrive.clientID;
    }
    if (this.settings.onedrive.authority === "") {
      this.settings.onedrive.authority = DEFAULT_SETTINGS.onedrive.authority;
    }
    if (this.settings.onedrive.remoteBaseDir === undefined) {
      this.settings.onedrive.remoteBaseDir = "";
    }
    if (this.settings.onedrive.emptyFile === undefined) {
      this.settings.onedrive.emptyFile = "skip";
    }
    if (this.settings.onedrive.kind === undefined) {
      this.settings.onedrive.kind = "onedrive";
    }

    if (this.settings.ignorePaths === undefined) {
      this.settings.ignorePaths = [];
    }
    if (this.settings.onlyAllowPaths === undefined) {
      this.settings.onlyAllowPaths = [];
    }
    if (this.settings.enableStatusBarInfo === undefined) {
      this.settings.enableStatusBarInfo = true;
    }
    if (this.settings.disclaimerAcknowledged === undefined) {
      this.settings.disclaimerAcknowledged = false;
    }
    if (this.settings.syncOnSaveAfterMilliseconds === undefined) {
      this.settings.syncOnSaveAfterMilliseconds = -1;
    }
    if (this.settings.syncOnSaveMode === undefined) {
      // Back-compat: derive from the legacy syncOnSaveAfterMilliseconds flag
      // (pre-syncOnSaveMode configs). NB: syncOnSaveMode must NOT have a
      // default in DEFAULT_SETTINGS — Object.assign({}, DEFAULT, loaded)
      // would otherwise fill it and this branch would never run, silently
      // disabling sync-on-save for upgraders. See deriveSyncOnSaveMode + tests.
      this.settings.syncOnSaveMode = deriveSyncOnSaveMode(
        this.settings.syncOnSaveAfterMilliseconds
      );
    }
    if (this.settings.deleteToWhere === undefined) {
      this.settings.deleteToWhere = "system";
    }
    this.settings.logToDB = false; // deprecated as of 20240113

    if (this.settings.agreeToUseSyncV3 === undefined) {
      this.settings.agreeToUseSyncV3 = false;
    }
    if (this.settings.conflictAction === undefined) {
      this.settings.conflictAction = "keep_newer";
    }
    if (this.settings.howToCleanEmptyFolder === undefined) {
      this.settings.howToCleanEmptyFolder = "clean_both";
    }
    if (this.settings.protectModifyPercentage === undefined) {
      this.settings.protectModifyPercentage = 50;
    }
    if (this.settings.syncDirection === undefined) {
      this.settings.syncDirection = "bidirectional";
    }

    if (this.settings.obfuscateSettingFile === undefined) {
      this.settings.obfuscateSettingFile = true;
    }

    if (this.settings.enableMobileStatusBar === undefined) {
      this.settings.enableMobileStatusBar = false;
    }

    if (this.settings.trackRenames === undefined) {
      this.settings.trackRenames = false;
    }

    if (
      this.settings.encryptionMethod === undefined ||
      this.settings.encryptionMethod === "unknown"
    ) {
      if (
        this.settings.password === undefined ||
        this.settings.password === ""
      ) {
        // we have a preferred way
        this.settings.encryptionMethod = "rclone-base64";
      } else {
        // likely to be inherited from the old version
        this.settings.encryptionMethod = "openssl-base64";
      }
    }

    if (this.settings.profiler === undefined) {
      this.settings.profiler = DEFAULT_PROFILER_CONFIG;
    }
    if (this.settings.profiler.enable === undefined) {
      this.settings.profiler.enable = false;
    }
    if (this.settings.profiler.enablePrinting === undefined) {
      this.settings.profiler.enablePrinting = false;
    }
    if (this.settings.profiler.recordSize === undefined) {
      this.settings.profiler.recordSize = false;
    }

    // Migrate old syncConfigDir to new toggles
    if (this.settings.syncConfigDir === true) {
      this.settings.syncObsidianConfig = true;
      this.settings.syncThirdPartyPlugins = true;
      this.settings.syncSelfPlugin = true;
      this.settings.syncConfigDir = false;
    }
    // Apply defaults for new fields if missing
    this.settings.syncObsidianConfig ??= true;
    this.settings.syncThirdPartyPlugins ??= true;
    this.settings.syncSelfPlugin ??= true;

    await this.saveSettings();
  }

  /** Extract device-specific onedrive auth fields + password from live settings. */
  private extractOnedriveAuth(): OnedriveAuthFields {
    const o = this.settings.onedrive;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      accessTokenExpiresInSeconds: o.accessTokenExpiresInSeconds,
      accessTokenExpiresAtTime: o.accessTokenExpiresAtTime,
      deltaLink: o.deltaLink,
      username: o.username,
      credentialsShouldBeDeletedAtTime: o.credentialsShouldBeDeletedAtTime,
      password: this.settings.password,
    };
  }

  /** Merge device-specific onedrive auth + password from DB into live settings. */
  private mergeOnedriveAuthFromDB(auth: OnedriveAuthFields) {
    const o = this.settings.onedrive;
    o.accessToken = auth.accessToken;
    o.refreshToken = auth.refreshToken;
    o.accessTokenExpiresInSeconds = auth.accessTokenExpiresInSeconds;
    o.accessTokenExpiresAtTime = auth.accessTokenExpiresAtTime;
    o.deltaLink = auth.deltaLink;
    o.username = auth.username;
    o.credentialsShouldBeDeletedAtTime = auth.credentialsShouldBeDeletedAtTime;
    // Guard: old DB records (pre-password-migration) lack this field; keep
    // the value loaded from data.json until the first saveSettings persists it.
    this.settings.password = auth.password ?? this.settings.password;
  }

  /** Strip device-specific auth from an onedrive config copy (for data.json). */
  private stripOnedriveAuthInPlace(o: OnedriveConfig) {
    o.accessToken = "";
    o.refreshToken = "";
    o.accessTokenExpiresInSeconds = 0;
    o.accessTokenExpiresAtTime = 0;
    o.deltaLink = "";
    o.username = "";
    o.credentialsShouldBeDeletedAtTime = 0;
  }

  /** True once prepareDBAndVaultRandomID has populated this.db + this.vaultRandomID. */
  private isDbReady(): boolean {
    return (
      this.db !== undefined &&
      this.vaultRandomID !== undefined &&
      this.vaultRandomID !== ""
    );
  }

  /**
   * Merge onedrive auth from DB into live settings; if DB has no record yet
   * (first run after the token-out-of-data.json migration), migrate the auth
   * currently in settings.onedrive into the DB. Must be called AFTER
   * prepareDBAndVaultRandomID.
   */
  async mergeOnedriveAuthFromDBOrMigrate() {
    const authFromDB = await getOnedriveAuthByVault(
      this.db,
      this.vaultRandomID
    );
    if (authFromDB) {
      this.mergeOnedriveAuthFromDB(authFromDB);
    } else {
      await upsertOnedriveAuthByVault(
        this.db,
        this.vaultRandomID,
        this.extractOnedriveAuth()
      );
    }
  }

  async saveSettings() {
    const dbReady = this.isDbReady();
    // persist device-specific onedrive auth to the DB (not data.json)
    if (dbReady) {
      await upsertOnedriveAuthByVault(
        this.db,
        this.vaultRandomID,
        this.extractOnedriveAuth()
      );
    }
    // data.json gets auth stripped once DB is the source of truth;
    // before DB is ready (early in onload) we fall back to writing the
    // whole settings (legacy behavior) so checkIfOauthExpires etc. still
    // see a token.
    const settingsCopy = dbReady ? cloneDeep(this.settings) : this.settings;
    if (dbReady) {
      this.stripOnedriveAuthInPlace(settingsCopy.onedrive);
      stripPasswordInPlace(settingsCopy);
    }
    const dataToSave = settingsCopy.obfuscateSettingFile
      ? normalConfigToMessy(settingsCopy)
      : settingsCopy;
    // skip the disk write if content is unchanged — avoids spurious mtime
    // bumps that cause sync ping-pong on every load.
    const dataOnDisk = await this.loadData();
    if (JSON.stringify(dataToSave) !== JSON.stringify(dataOnDisk)) {
      await this.saveData(dataToSave);
    }
    // project selected fields into the plain-JSON sidecar (sync unit)
    await this.writeSidecar();
  }

  private sidecarPath(): string {
    return `${this.manifest.dir}/synced_settings.json`;
  }

  private buildSidecarText(): string | null {
    const fields = this.settings.syncedSettingFields ?? [];
    if (fields.length === 0) return null;
    const projected = projectSyncableFields(this.settings, fields);
    return JSON.stringify(projected, null, 2);
  }

  /** Write the sidecar only when content changed (diff guard — no spurious
   *  mtime bump, no ping-pong). No-op if no fields selected. */
  async writeSidecar() {
    const newText = this.buildSidecarText();
    const p = this.sidecarPath();
    const exists = await this.app.vault.adapter.exists(p);
    if (newText === null) {
      if (exists) await this.app.vault.adapter.remove(p);
      return;
    }
    if (exists) {
      const oldText = await this.app.vault.adapter.read(p);
      if (oldText === newText) return; // diff guard: no change, no write
    }
    await this.app.vault.adapter.write(p, newText);
  }

  /** Read + parse the sidecar. null if missing/corrupt. Never throws. */
  async readSidecar(): Promise<Partial<RemotelySavePluginSettings> | null> {
    const p = this.sidecarPath();
    try {
      const exists = await this.app.vault.adapter.exists(p);
      if (!exists) return null;
      const text = await this.app.vault.adapter.read(p);
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      return parsed as Partial<RemotelySavePluginSettings>;
    } catch (e) {
      console.warn("synced_settings.json unreadable, skipping reconcile", e);
      return null;
    }
  }

  /** Re-read the sidecar (possibly just downloaded/merged) into in-memory
   *  settings + persist to data.json. Design-level clobber fix: after every
   *  sync the plugin's memory tracks the synced sidecar, so a later
   *  saveSettings can never write stale values over a freshly-pulled config.
   *  Swallows all errors — must never break the sync chain. */
  _reconcileSidecar = async () => {
    try {
      const sidecar = await this.readSidecar();
      if (sidecar === null) return;
      const fields = this.settings.syncedSettingFields ?? [];
      if (fields.length === 0) return;
      applySyncedFields(this.settings, sidecar, fields);
      await this.saveSettings(); // persist to data.json; writeSidecar diff=no-op
    } catch (e) {
      console.warn("sidecar reconcile failed", e);
    }
  };

  /**
   * After 202403 the data should be of profile based.
   */
  getCurrProfileID() {
    if (this.settings.serviceType !== undefined) {
      return `${this.settings.serviceType}-default-1`;
    } else {
      throw Error("unknown serviceType in the setting!");
    }
  }

  async checkIfOauthExpires() {
    let needSave = false;
    const current = Date.now();

    // fullfill old version settings
    if (
      this.settings.onedrive.refreshToken !== "" &&
      this.settings.onedrive.credentialsShouldBeDeletedAtTime === undefined
    ) {
      this.settings.onedrive.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }

    // check expired or not
    let onedriveExpired = false;
    if (
      this.settings.onedrive.refreshToken !== "" &&
      current >= this.settings!.onedrive!.credentialsShouldBeDeletedAtTime!
    ) {
      console.warn(`onedrive expired`);
      onedriveExpired = true;
      this.settings.onedrive = cloneDeep(DEFAULT_ONEDRIVE_CONFIG);
      needSave = true;
    }

    // save back
    if (needSave) {
      await this.saveSettings();
    }

    // send notice
    if (onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth OneDrive (App Folder) for many days, you need to re-auth it again.`,
        6000
      );
    }
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = "";
    if (this.settings.vaultRandomID !== undefined) {
      // In old version, the vault id is saved in data.json
      // But we want to store it in localForage later
      if (this.settings.vaultRandomID !== "") {
        // a real string was assigned before
        vaultRandomID = this.settings.vaultRandomID;
      }
      console.debug("vaultRandomID is no longer saved in data.json");
      delete this.settings.vaultRandomID;
      await this.saveSettings();
    }
    return vaultRandomID;
  }

  async trash(x: string) {
    if (this.settings.deleteToWhere === "obsidian") {
      await this.app.vault.adapter.trashLocal(x);
    } else {
      // "system"
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x);
      }
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(
    vaultBasePath: string,
    vaultRandomIDFromOldConfigFile: string,
    profileID: string
  ) {
    const { db, vaultRandomID } = await prepareDBs(
      vaultBasePath,
      vaultRandomIDFromOldConfigFile,
      profileID
    );
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          this.syncRun("auto").catch((e) => {
            console.error("Auto-sync failed:", e);
          });
        }, this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          this.syncRun("auto_once_init").catch((e) => {
            console.error("Init-sync failed:", e);
          });
        }, this.settings.initRunAfterMilliseconds);
      });
    }
  }

  async _checkCurrFileModified(caller: "SYNC" | "FILE_CHANGES") {
    console.debug(`inside checkCurrFileModified`);
    // For FILE_CHANGES, use the actual modified file (tracked by
    // _syncOnSaveModifyHandler) instead of getActiveFile(), which may
    // return a different file if the user switched after saving.
    const currentFile =
      caller === "FILE_CHANGES" && this.lastModifiedFile
        ? this.lastModifiedFile
        : this.app.workspace.getActiveFile();

    if (currentFile) {
      console.debug(`we have currentFile=${currentFile.path}`);
      // get the last modified time of the current file
      // if it has modified after lastSuccessSync
      // then schedule a run for syncOnSaveAfterMilliseconds after it was modified
      const lastModified = currentFile.stat.mtime;
      const lastSuccessSyncMillis = await getLastSuccessSyncTimeByVault(
        this.db,
        this.vaultRandomID
      );

      console.debug(
        `lastModified=${lastModified}, lastSuccessSyncMillis=${lastSuccessSyncMillis}`
      );

      if (
        caller === "SYNC" ||
        (caller === "FILE_CHANGES" &&
          lastModified > (lastSuccessSyncMillis ?? 1))
      ) {
        console.debug(
          `so lastModified > lastSuccessSyncMillis or it's called while syncing before`
        );
        console.debug(
          `caller=${caller}, isSyncing=${this.isSyncing}, hasPendingSyncOnSave=${this.hasPendingSyncOnSave}`
        );
        if (this.isSyncing) {
          this.hasPendingSyncOnSave = true;
          // wait for next event
          return;
        } else {
          if (this.hasPendingSyncOnSave || caller === "FILE_CHANGES") {
            this.hasPendingSyncOnSave = false;
            await this.syncRun("auto_sync_on_save").catch((e) => {
              console.error("Sync-on-save failed:", e);
            });
          }
          return;
        }
      }
    } else {
      console.debug(`no currentFile here`);
    }
  }

  _syncOnSaveEvent1 = () => {
    this._checkCurrFileModified("SYNC");
  };

  _syncOnSaveModifyHandler = (file: any) => {
    // Track the actual modified file (not just getActiveFile()) so
    // _checkCurrFileModified checks the right file even if the user
    // switched to a different file before the throttle fires.
    this.lastModifiedFile = file;
    this._syncOnSaveEvent2();
  };

  _syncOnSaveEvent2 = throttle(
    async () => {
      await this._checkCurrFileModified("FILE_CHANGES");
    },
    1000 * 3,
    {
      leading: false,
      trailing: true,
    }
  );

  /**
   * Sync-on-save "1-minute rate-limit" handler. On any vault change event,
   * sync immediately UNLESS a sync happened within the last
   * SYNC_ON_SAVE_RATE_LIMIT_MS (then drop — periodic auto-sync catches up).
   * Requires periodic auto-sync (autoRunEveryMilliseconds > 0) as the safety
   * net; otherwise the handler stays inert. No throttle, no SYNC_DONE
   * listener, no defer state — the 1-min window is the rate limit.
   */
  _syncOnSaveRateLimitHandler = async (_file: any) => {
    // Prerequisite: periodic auto-sync must be enabled — it catches the
    // changes dropped within the 1-min window. If periodic is off, the
    // rate-limit mode stays inert (no sync on save).
    if (
      this.settings.autoRunEveryMilliseconds === undefined ||
      this.settings.autoRunEveryMilliseconds === null ||
      this.settings.autoRunEveryMilliseconds <= 0
    ) {
      return;
    }
    // Coalesce bursts (bulk rename / find-replace fire N events): while one
    // rate-limit check/sync is already running, drop the rest. This also
    // prevents N duplicate syncRun setup passes (each builds FakeFsLocal +
    // reads getPrevRemoteEntities before syncRun's own isSyncing guard
    // dedupes them). Periodic auto-sync + the next eligible save catch the
    // dropped changes. No defer state, no timer.
    if (this.rateLimitTriggerInFlight) {
      return;
    }
    this.rateLimitTriggerInFlight = true;
    try {
      // Fast-path: skip the cache read + syncRun setup if a sync is already
      // running. (TOCTOU fast-path, not a guard — the authoritative dedup is
      // syncRun's own isSyncing check; the in-flight flag above is what
      // actually coalesces bursts.)
      if (this.isSyncing) {
        return;
      }
      // Use the in-memory cache of the last successful sync time (updated
      // synchronously on sync completion in statusBarFunc step 8) to avoid an
      // IndexedDB read on every vault event. Lazy-load once per session
      // (undefined = not yet loaded; null = loaded, never synced).
      let lastSyncMs = this.lastSuccessSyncMs;
      if (lastSyncMs === undefined) {
        lastSyncMs = await getLastSuccessSyncTimeByVault(
          this.db,
          this.vaultRandomID
        );
        this.lastSuccessSyncMs = lastSyncMs;
      }
      if (shouldRateLimitSync(Date.now(), lastSyncMs)) {
        await this.syncRun("auto_sync_on_save").catch((e) => {
          console.error("Sync-on-save (rate-limit) failed:", e);
        });
      }
      // else: within the 1-min window → drop (ignore this trigger).
    } catch (e) {
      console.error("Sync-on-save (rate-limit) check failed:", e);
    } finally {
      this.rateLimitTriggerInFlight = false;
    }
  };

  toggleSyncOnSaveIfSet() {
    // Always tear down every sync-on-save listener first so re-toggling
    // (settings change, sync-algo notice) never double-registers.
    this.syncEvent?.off("SYNC_DONE", this._syncOnSaveEvent1);
    this.app.vault.off("modify", this._syncOnSaveModifyHandler);
    this.app.vault.off("create", this._syncOnSaveEvent2);
    this.app.vault.off("delete", this._syncOnSaveEvent2);
    this.app.vault.off("rename", this._syncOnSaveEvent2);
    this.app.vault.off("modify", this._syncOnSaveRateLimitHandler);
    this.app.vault.off("create", this._syncOnSaveRateLimitHandler);
    this.app.vault.off("delete", this._syncOnSaveRateLimitHandler);
    this.app.vault.off("rename", this._syncOnSaveRateLimitHandler);

    const mode = this.settings.syncOnSaveMode;
    if (mode === "throttle") {
      this.app.workspace.onLayoutReady(() => {
        // listen to sync done
        this.registerEvent(
          this.syncEvent?.on("SYNC_DONE", this._syncOnSaveEvent1)!
        );
        // listen to current file save changes
        // Use _syncOnSaveModifyHandler for "modify" to track the actual
        // modified file, not just getActiveFile() at throttle time.
        this.registerEvent(
          this.app.vault.on("modify", this._syncOnSaveModifyHandler)
        );
        this.registerEvent(this.app.vault.on("create", this._syncOnSaveEvent2));
        this.registerEvent(this.app.vault.on("delete", this._syncOnSaveEvent2));
        this.registerEvent(this.app.vault.on("rename", this._syncOnSaveEvent2));
      });
    } else if (mode === "rateLimit") {
      this.app.workspace.onLayoutReady(() => {
        this.registerEvent(
          this.app.vault.on("modify", this._syncOnSaveRateLimitHandler)
        );
        this.registerEvent(
          this.app.vault.on("create", this._syncOnSaveRateLimitHandler)
        );
        this.registerEvent(
          this.app.vault.on("delete", this._syncOnSaveRateLimitHandler)
        );
        this.registerEvent(
          this.app.vault.on("rename", this._syncOnSaveRateLimitHandler)
        );
      });
    }
    // mode === "off" (or unset) → nothing registered.
  }

  enableMobileStatusBarIfSet() {
    this.app.workspace.onLayoutReady(() => {
      if (Platform.isMobile && this.settings.enableMobileStatusBar) {
        this.appContainerObserver = changeMobileStatusBar("enable");
      }
    });
  }

  enableCheckingFileStat() {
    this.app.workspace.onLayoutReady(() => {
      const t = (x: TransItemType, vars?: any) => {
        return this.i18n.t(x, vars);
      };
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (file instanceof TFolder) {
            // folder not supported yet
            return;
          }

          menu.addItem((item) => {
            item
              .setTitle(t("menu_check_file_stat"))
              .setIcon("file-cog")
              .onClick(async () => {
                const filePath = file.path;
                const fsLocal = new FakeFsLocal(
                  this.app.vault,
                  this.settings.syncObsidianConfig ?? true,
                  this.settings.syncThirdPartyPlugins ?? true,
                  this.settings.syncSelfPlugin ?? true,
                  this.settings.syncBookmarks ?? false,
                  this.settings.syncAppearance ?? false,
                  this.app.vault.configDir,
                  this.manifest.id,
                  undefined,
                  this.settings.deleteToWhere ?? "system"
                );
                const s = await fsLocal.stat(filePath);
                new Notice(JSON.stringify(s, null, 2), 10000);
              });
          });
        })
      );
    });
  }

  async saveAgreeToUseNewSyncAlgorithm() {
    this.settings.agreeToUseSyncV3 = true;
    await this.saveSettings();
  }

  setCurrSyncMsg(
    t: (x: TransItemType, vars?: any) => string,
    s: SyncTriggerSourceType,
    i: number,
    totalCount: number,
    pathName: string,
    decision: string,
    triggerSource: SyncTriggerSourceType
  ) {
    const L = `${totalCount}`.length;
    const iStr = `${i}`.padStart(L, "0");
    const prefix = getStatusBarShortMsgFromSyncSource(t, s);
    const shortMsg = prefix + `Syncing ${iStr}/${totalCount}`;
    const longMsg =
      prefix +
      `Syncing progress=${iStr}/${totalCount},decision=${decision},path=${pathName},source=${triggerSource}`;
    this.currSyncMsg = longMsg;

    if (this.statusBarElement !== undefined) {
      this.statusBarElement.setText(shortMsg);
      this.statusBarElement.setAttribute("aria-label", longMsg);
    }
  }

  updateLastSyncMsg(
    s: SyncTriggerSourceType | undefined,
    syncStatus: "not_syncing" | "syncing",
    lastSuccessSyncMillis: number | null | undefined,
    lastFailedSyncMillis: number | null | undefined
  ) {
    if (this.statusBarElement === undefined) return;

    // console.debug(lastSuccessSyncMillis);
    // console.debug(lastFailedSyncMillis);

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    let lastSyncMsg = t("statusbar_lastsync_never");
    let lastSyncLabelMsg = t("statusbar_lastsync_never_label");

    const inputTs = Math.max(
      lastSuccessSyncMillis ?? -999,
      lastFailedSyncMillis ?? -999
    );
    const isSuccess =
      (lastSuccessSyncMillis ?? -999) >= (lastFailedSyncMillis ?? -999);

    if (syncStatus === "syncing") {
      lastSyncMsg =
        getStatusBarShortMsgFromSyncSource(t, s!) + t("statusbar_syncing");
    } else if (inputTs > 0) {
      let prefix = "";
      if (isSuccess) {
        prefix = t("statusbar_sync_status_prefix_success");
      } else {
        prefix = t("statusbar_sync_status_prefix_failed");
      }

      const deltaTime = Date.now() - inputTs;
      // create human readable time
      const years = Math.floor(deltaTime / 31556952000);
      const months = Math.floor(deltaTime / 2629746000);
      const weeks = Math.floor(deltaTime / 604800000);
      const days = Math.floor(deltaTime / 86400000);
      const hours = Math.floor(deltaTime / 3600000);
      const minutes = Math.floor(deltaTime / 60000);
      const seconds = Math.floor(deltaTime / 1000);
      let timeText = "";
      if (years > 0) {
        timeText = t("statusbar_time_years", { time: years });
      } else if (months > 0) {
        timeText = t("statusbar_time_months", { time: months });
      } else if (weeks > 0) {
        timeText = t("statusbar_time_weeks", { time: weeks });
      } else if (days > 0) {
        timeText = t("statusbar_time_days", { time: days });
      } else if (hours > 0) {
        timeText = t("statusbar_time_hours", { time: hours });
      } else if (minutes > 0) {
        timeText = t("statusbar_time_minutes", { time: minutes });
      } else if (seconds > 30) {
        timeText = t("statusbar_time_lessminute");
      } else {
        timeText = t("statusbar_time_now");
      }
      const dateText = new Date(inputTs).toLocaleTimeString(
        navigator.language,
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }
      );

      lastSyncMsg = prefix + timeText;
      lastSyncLabelMsg =
        prefix + t("statusbar_lastsync_label", { date: dateText });
    } else {
      // TODO: no idea what happened.
    }

    this.statusBarElement.setText(lastSyncMsg);
    this.statusBarElement.setAttribute("aria-label", lastSyncLabelMsg);
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir =
      this.manifest.dir ||
      `${this.app.vault.configDir}/plugins/${this.manifest.dir}`;
    const pluginConfigDirExists =
      await this.app.vault.adapter.exists(pluginConfigDir);
    if (!pluginConfigDirExists) {
      // what happened?
      return;
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);

    const contentText = "data.json\n";

    try {
      if (!ignoreFileExists) {
        // not exists, directly create
        // no need to await
        this.app.vault.adapter.write(ignoreFile, contentText);
      }
    } catch (error) {
      // just skip
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 30;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearAllLoggerOutputRecords(this.db);
      }, initClearOutputToDBHistAfterMilliseconds);
    });
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45;
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, initClearSyncPlanHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, autoClearSyncPlanHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }
}
