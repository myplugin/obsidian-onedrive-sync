// License: PolyForm Strict 1.0.0 (source-available). See LICENSE.pro.

// biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
import AggregateError from "aggregate-error";
import PQueue from "p-queue";
import XRegExp from "xregexp";
import type {
  BatchRenameOp,
  ConflictActionType,
  Entity,
  MixedEntity,
  RemotelySavePluginSettings,
  SUPPORTED_SERVICES_TYPE,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { CONFLICT_LOG_FILENAME, type ConflictLogEntry } from "./conflictLog";
import {
  computeMergedContent,
  isMergable,
  mergeFile,
  tryDuplicateFile,
  writeDupCopyForDirtyOpen,
} from "./conflictLogic";
import { copyFile, copyFileOrFolder, copyFolder } from "./copyLogic";
import {
  clearFileContentHistoryByVaultAndProfile,
  getFileContentHistoryByVaultAndProfile,
  upsertFileContentHistoryByVaultAndProfile,
} from "./fileContentHistory";
import type { FakeFs } from "./fsAll";
import type { FakeFsEncrypt } from "./fsEncrypt";
import {
  type InternalDBs,
  clearPrevSyncRecordByVaultAndProfile,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
  upsertPrevSyncRecordByVaultAndProfile,
} from "./localdb";
import { debugInfo } from "./logger";
import {
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2,
} from "./metadataOnRemote";
import {
  atWhichLevel,
  getFolderLevels,
  getParentFolder,
  isHiddenPath,
  isSpecialFolderNameToSkip,
  roughSizeOfObject,
  unixTimeToStr,
} from "./misc";
import type { Profiler } from "./profiler";
import { quickXorHash } from "./quickXorHash";
import { shouldSkipSync, splitUploadDownloadOps } from "./syncOptimize";

const copyEntityAndFixTimeFormat = (
  src: Entity,
  serviceType: SUPPORTED_SERVICES_TYPE
) => {
  const result = Object.assign({}, src);
  if (result.mtimeCli !== undefined) {
    if (result.mtimeCli === 0) {
      result.mtimeCli = undefined;
    } else {
      result.mtimeCliFmt = unixTimeToStr(result.mtimeCli);
    }
  }
  if (result.ctimeCli !== undefined) {
    if (result.ctimeCli === 0) {
      result.ctimeCli = undefined;
    } else {
      result.ctimeCliFmt = unixTimeToStr(result.ctimeCli);
    }
  }
  if (result.mtimeSvr !== undefined) {
    if (result.mtimeSvr === 0) {
      result.mtimeSvr = undefined;
    } else {
      result.mtimeSvrFmt = unixTimeToStr(result.mtimeSvr);
    }
  }
  if (result.prevSyncTime !== undefined) {
    if (result.prevSyncTime === 0) {
      result.prevSyncTime = undefined;
    } else {
      result.prevSyncTimeFmt = unixTimeToStr(result.prevSyncTime);
    }
  }

  return result;
};

/**
 * Directly throw error here.
 * We can only defer the checking now, because before decryption we don't know whether it's a file or folder.
 * @param remote
 */
const ensureMTimeOfRemoteEntityValid = (remote: Entity) => {
  if (
    !remote.key!.endsWith("/") &&
    remote.mtimeCli === undefined &&
    remote.mtimeSvr === undefined
  ) {
    if (remote.key === remote.keyEnc) {
      throw Error(
        `Your remote file ${remote.key} has last modified time 0, don't know how to deal with it.`
      );
    } else {
      throw Error(
        `Your remote file ${remote.key} (encrypted as ${remote.keyEnc}) has last modified time 0, don't know how to deal with it.`
      );
    }
  }
  return remote;
};

const isInsideObsFolder = (x: string, configDir: string) => {
  if (!configDir.startsWith(".")) {
    throw Error(`configDir should starts with . but we get ${configDir}`);
  }
  return x === configDir || x.startsWith(`${configDir}/`);
};

interface IsSkipResult {
  enableAllowMode: boolean;
  isExplictlyAllowed: boolean;
  isExplictlyIgnored: boolean;
  finalIsIgnored: boolean;
}

export const checkIsSkipItemOrNotByName = (
  key: string,
  syncObsidianConfig: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  syncBookmarks: boolean,
  syncAppearance: boolean,
  syncUnderscoreItems: boolean,
  syncDotItems: boolean,
  configDir: string,
  ignorePaths: string[],
  onlyAllowPaths: string[],
  selfPluginId: string
): IsSkipResult => {
  if (key === undefined) {
    throw Error(`checkIsSkipItemOrNotByName meets undefinded key!`);
  }

  const normalizedKey = key.replace(/\\/g, "/"); // slash compatibility (parity with tester)

  let finalIsIgnored: boolean | undefined = undefined;

  let enableAllowMode = false;
  let isExplictlyAllowed = false;
  if (onlyAllowPaths !== undefined && onlyAllowPaths.length > 0) {
    for (const r of onlyAllowPaths) {
      if (r.trim() === "") {
        // ignore empty lines
        continue;
      }
      enableAllowMode = true; // we really want to check the allow list

      if (XRegExp(r.replace(/\\\\/g, "/"), "A").test(normalizedKey)) {
        isExplictlyAllowed = true;
      }
    }
  }
  // we want to determine "is skippable or not".
  // if the key meets the allow list,
  //     it may or may not be skippable,
  //     and is deferred to next checking steps
  // if the key doesn't meet the allow list,
  //     it must be skippable.
  if (enableAllowMode && !isExplictlyAllowed) {
    finalIsIgnored = true; // must be skippable
  }

  let isExplictlyIgnored = false;
  if (ignorePaths !== undefined && ignorePaths.length > 0) {
    for (const r of ignorePaths) {
      if (r.trim() === "") {
        // ignore empty lines
        continue;
      }
      if (XRegExp(r.replace(/\\\\/g, "/"), "A").test(normalizedKey)) {
        if (finalIsIgnored === undefined) {
          isExplictlyIgnored = true;
          finalIsIgnored = true;
        }
      }
    }
  }

  // Built-in blacklist: always excluded
  const OBSIDIAN_BLACKLIST = [
    "workspace.json",
    "workspace-mobile.json",
    "workspaces.json",
    "core-plugins-migration.json",
  ];
  const SELF_PLUGIN_ALLOWED = [
    "main.js",
    "manifest.json",
    "styles.css",
    "synced_settings.json",
    ".gitignore",
  ];

  if (finalIsIgnored === undefined) {
    if (isInsideObsFolder(key, configDir)) {
      const basename = normalizedKey.split("/").pop() ?? "";
      const selfPluginPrefix = `${configDir}/plugins/${selfPluginId}/`;
      const inSelfPlugin =
        normalizedKey.startsWith(selfPluginPrefix) ||
        normalizedKey === `${configDir}/plugins/${selfPluginId}`;
      const pluginsPrefix = `${configDir}/plugins/`;
      const inOtherPlugins =
        normalizedKey.startsWith(pluginsPrefix) && !inSelfPlugin;
      // Config root (.obsidian/ itself) stays walkable when any toggle is on
      const isConfigRoot =
        normalizedKey === `${configDir}/` || normalizedKey === configDir;

      if (isConfigRoot) {
        finalIsIgnored = !(
          syncObsidianConfig ||
          syncAppearance ||
          syncBookmarks ||
          syncThirdPartyPlugins ||
          syncSelfPlugin
        );
      } else if (OBSIDIAN_BLACKLIST.includes(basename)) {
        finalIsIgnored = true;
      } else if (basename === "appearance.json") {
        finalIsIgnored = !syncAppearance;
      } else if (basename === "bookmarks.json") {
        finalIsIgnored = !syncBookmarks;
      } else if (inSelfPlugin) {
        if (normalizedKey.endsWith("/")) {
          // Folder: include if syncSelfPlugin (don't filter by SELF_PLUGIN_ALLOWED)
          finalIsIgnored = !syncSelfPlugin;
        } else {
          finalIsIgnored = SELF_PLUGIN_ALLOWED.includes(basename)
            ? !syncSelfPlugin
            : true;
        }
      } else if (
        // The plugins/ directory itself: include if either plugin toggle is on
        normalizedKey === `${configDir}/plugins/`
      ) {
        finalIsIgnored = !(syncSelfPlugin || syncThirdPartyPlugins);
      } else if (inOtherPlugins) {
        finalIsIgnored = !syncThirdPartyPlugins;
      } else {
        finalIsIgnored = !syncObsidianConfig;
      }
    } else {
      // not config files, do not judge now, do nothing
    }
  }

  if (isSpecialFolderNameToSkip(key, [])) {
    // some special dirs and files are always skipped
    if (finalIsIgnored === undefined) {
      isExplictlyIgnored = true;
      finalIsIgnored = true;
    }
  }

  const checkIsHidden =
    (!syncDotItems && isHiddenPath(key, true, false)) ||
    (!syncUnderscoreItems && isHiddenPath(key, false, true)) ||
    key === "/" ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 ||
    // The per-device 412-conflict log must never be synced (it would itself
    // conflict between devices), even when the user syncs dot items.
    key === CONFLICT_LOG_FILENAME;
  if (finalIsIgnored === undefined) {
    isExplictlyIgnored = checkIsHidden;
    finalIsIgnored = checkIsHidden;
  }

  if (finalIsIgnored === undefined) {
    throw Error(`no finalIsIgnored in checkIsSkipItemOrNotByName for ${key}`);
  }

  return {
    enableAllowMode: enableAllowMode,
    isExplictlyAllowed: isExplictlyAllowed,
    isExplictlyIgnored: isExplictlyIgnored,
    finalIsIgnored: finalIsIgnored,
  };
};

/**
 * | finalIgnored                    | reason                                       | explictlyIgnored | allowMode | explictlyAllowed |
 * | ------------------------------- | -------------------------------------------- | ---------------- | --------- | ---------------- |
 * | no                              | nothing blocking                             | no               | no        | no               |
 * | yes, MAY be changed by children | allow mode not allowed, inexplicitly ignored | no               | yes       | no               |
 * | no, MAY apply to parents        | allow mode allowed                           | no               | yes       | yes              |
 * | yes, also apply to children     | explictly ignored                            | yes              | no        | no               |
 * | yes, also apply to children     | explictly ignored                            | yes              | yes       | no               |
 * | yes, also apply to children     | explictly ignored                            | yes              | yes       | yes              |
 */
export const getSkipItemsByList = (
  skipOrNotResults: Record<string, IsSkipResult>
): string[] => {
  const allPotentialKeys = Object.keys(skipOrNotResults);

  // from short(shadow) to long(deep) , ascending
  const sortedKeys = allPotentialKeys.sort((k1, k2) => k1.length - k2.length);

  // we deal with explicty ignored list firstly, apply them to children
  const explictlyIgnoredSet = new Set<string>();
  for (const key of sortedKeys) {
    if (skipOrNotResults[key].isExplictlyIgnored) {
      skipOrNotResults[key].finalIsIgnored = true;
      explictlyIgnoredSet.add(key);
    } else {
      const parents = getFolderLevels(key, true).reverse();
      for (const key2 of parents) {
        if (explictlyIgnoredSet.has(key2)) {
          skipOrNotResults[key].isExplictlyIgnored = true;
          skipOrNotResults[key].finalIsIgnored = true;
          explictlyIgnoredSet.add(key);
          break;
        }
      }
    }
  }

  // we deal with explictly allow list secondly, apply them to PARENTS if possible
  let enableAllowMode = false;
  if (
    allPotentialKeys.length > 0 &&
    allPotentialKeys[0] !== undefined &&
    skipOrNotResults[allPotentialKeys[0]] !== undefined
  ) {
    enableAllowMode = skipOrNotResults[allPotentialKeys[0]].enableAllowMode;
  }
  if (enableAllowMode) {
    for (let index = 0; index < sortedKeys.length; index++) {
      // reverse order, long(deep) to short(shadow), ascending
      const key = sortedKeys[sortedKeys.length - index - 1];
      if (
        !skipOrNotResults[key].isExplictlyIgnored &&
        skipOrNotResults[key].isExplictlyAllowed
      ) {
        // the file is explictly allowed, and not explictly ignored by anywhere
        // we allow all its parents!
        const parents = getFolderLevels(key, true).reverse();

        for (const key2 of parents) {
          if (
            key2 in skipOrNotResults &&
            !skipOrNotResults[key2].isExplictlyIgnored &&
            !explictlyIgnoredSet.has(key2)
          ) {
            skipOrNotResults[key2].isExplictlyAllowed = true;
            skipOrNotResults[key2].finalIsIgnored = false; // from ignored to allowed
          } else {
            throw Error(
              `${key}'s parent ${key2} in abnormal state: ${JSON.stringify(skipOrNotResults[key2])}`
            );
          }
        }
      }
    }
  }

  // get all finalIsIgnored
  const result: string[] = [];
  for (const key of sortedKeys) {
    if (skipOrNotResults[key].finalIsIgnored) {
      result.push(key);
    }
  }
  console.debug(`finalIsIgnored list= ${JSON.stringify(result)}`);
  return result;
};

export type SyncPlanType = Record<string, MixedEntity>;

const ensembleMixedEnties = async (
  localEntityList: Entity[],
  prevSyncEntityList: Entity[],
  remoteEntityList: Entity[],

  syncObsidianConfig: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  syncBookmarks: boolean,
  syncAppearance: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  syncDotItems: boolean,
  ignorePaths: string[],
  onlyAllowPaths: string[],
  selfPluginId: string,
  fsEncrypt: FakeFsEncrypt,
  serviceType: SUPPORTED_SERVICES_TYPE,

  profiler: Profiler | undefined
): Promise<SyncPlanType> => {
  profiler?.addIndent();
  profiler?.insert("ensembleMixedEnties: enter");
  profiler?.insertSize("sizeof localEntityList", localEntityList);
  profiler?.insertSize("sizeof prevSyncEntityList", prevSyncEntityList);
  profiler?.insertSize("sizeof remoteEntityList", remoteEntityList);

  const finalMappings: SyncPlanType = {};

  const skipOrNotResults: Record<string, IsSkipResult> = {};

  // remote has to be first
  let remoteMaySkipCountAndNotConfig = 0;
  for (const remote of remoteEntityList) {
    const remoteCopied = ensureMTimeOfRemoteEntityValid(
      copyEntityAndFixTimeFormat(remote, serviceType)
    );

    const key = remoteCopied.key!;

    const skipOrNot = checkIsSkipItemOrNotByName(
      key,
      syncObsidianConfig,
      syncThirdPartyPlugins,
      syncSelfPlugin,
      syncBookmarks,
      syncAppearance,
      syncUnderscoreItems,
      syncDotItems,
      configDir,
      ignorePaths,
      onlyAllowPaths,
      selfPluginId
    );
    skipOrNotResults[key] = skipOrNot;
    if (skipOrNot.finalIsIgnored && !key.startsWith(configDir)) {
      remoteMaySkipCountAndNotConfig += 1;
    }

    // 20240907: users (not on windows) doesn't like it. revert back now.
    // TODO: platform specific but not introducing obsidian dependency into sync.ts
    // const checkValidNameResult = checkValidName(key);
    // if (!checkValidNameResult.result) {
    //   throw Error(
    //     `your remote folder/file name is invalid: ${checkValidNameResult.reason}`
    //   );
    // }

    finalMappings[key] = {
      key: key,
      remote: remoteCopied,
    };
  }

  profiler?.insert("ensembleMixedEnties: finish remote");
  profiler?.insertSize("sizeof finalMappings", finalMappings);

  if (
    Object.keys(finalMappings).filter((k) => !k.startsWith(configDir)).length -
      remoteMaySkipCountAndNotConfig ===
      0 ||
    localEntityList.filter((e) => !e.key?.startsWith(configDir)).length === 0
  ) {
    // Special checking:
    // if one side is totally empty,
    // usually that's a hard rest.
    // So we need to ignore everything of prevSyncEntityList to avoid deletions!
    // TODO: acutally erase everything of prevSyncEntityList?
    // TODO: local should also go through a checkIsSkipItemOrNotByName checking beforehand
  } else {
    // normally go through the prevSyncEntityList
    for (const prevSync of prevSyncEntityList) {
      const key = prevSync.key!;

      if (!(key in skipOrNotResults)) {
        const skipOrNot = checkIsSkipItemOrNotByName(
          key,
          syncObsidianConfig,
          syncThirdPartyPlugins,
          syncSelfPlugin,
          syncBookmarks,
          syncAppearance,
          syncUnderscoreItems,
          syncDotItems,
          configDir,
          ignorePaths,
          onlyAllowPaths,
          selfPluginId
        );
        skipOrNotResults[key] = skipOrNot;
      }

      // TODO: abstraction leaking?
      const prevSyncCopied = await fsEncrypt.encryptEntity(
        copyEntityAndFixTimeFormat(prevSync, serviceType)
      );
      if (Object.prototype.hasOwnProperty.call(finalMappings, key)) {
        finalMappings[key].prevSync = prevSyncCopied;
      } else {
        finalMappings[key] = {
          key: key,
          prevSync: prevSyncCopied,
        };
      }
    }
  }

  profiler?.insert("ensembleMixedEnties: finish prevSync");
  profiler?.insertSize("sizeof finalMappings", finalMappings);

  // local has to be last
  // because we want to get keyEnc based on the remote
  // (we don't consume prevSync here because it gains no benefit)
  for (const local of localEntityList) {
    const key = local.key!;

    if (!(key in skipOrNotResults)) {
      const skipOrNot = checkIsSkipItemOrNotByName(
        key,
        syncObsidianConfig,
        syncThirdPartyPlugins,
        syncSelfPlugin,
        syncBookmarks,
        syncAppearance,
        syncUnderscoreItems,
        syncDotItems,
        configDir,
        ignorePaths,
        onlyAllowPaths,
        selfPluginId
      );
      skipOrNotResults[key] = skipOrNot;
    }

    // 20240907: users (not on windows) doesn't like it. revert back now.
    // TODO: platform specific but not introducing obsidian dependency into sync.ts
    // const checkValidNameResult = checkValidName(key);
    // if (!checkValidNameResult.result) {
    //   throw Error(
    //     `your local folder/file name is invalid: ${checkValidNameResult.reason}`
    //   );
    // }

    // TODO: abstraction leaking?
    const localCopied = await fsEncrypt.encryptEntity(
      copyEntityAndFixTimeFormat(local, serviceType)
    );
    if (Object.prototype.hasOwnProperty.call(finalMappings, key)) {
      finalMappings[key].local = localCopied;
    } else {
      finalMappings[key] = {
        key: key,
        local: localCopied,
      };
    }
  }

  profiler?.insert("ensembleMixedEnties: finish local");
  profiler?.insertSize("sizeof finalMappings", finalMappings);

  // we check the skipOrNotResults again! in case we adjust some paths!
  const allReallySkipKeys = getSkipItemsByList(skipOrNotResults);
  for (const key of allReallySkipKeys) {
    delete finalMappings[key];
  }

  profiler?.insert("ensembleMixedEnties: finish parsing all skip items");
  profiler?.insertSize("sizeof finalMappings", finalMappings);

  // console.debug("in the end of ensembleMixedEnties, finalMappings is:");
  // console.debug(finalMappings);

  profiler?.insert("ensembleMixedEnties: exit");
  profiler?.removeIndent();
  return finalMappings;
};

/**
 * Heavy lifting.
 * Basically follow the sync algorithm of https://github.com/Jwink3101/syncrclone
 * Also deal with syncDirection which makes it more complicated
 */
const getSyncPlanInplace = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  skipSizeLargerThan: number,
  conflictAction: ConflictActionType,
  syncDirection: SyncDirectionType,
  profiler: Profiler | undefined,
  settings: RemotelySavePluginSettings,
  triggerSource: SyncTriggerSourceType,
  configDir: string
) => {
  profiler?.addIndent();
  profiler?.insert("getSyncPlanInplace: enter");
  // from long(deep) to short(shadow), descending
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );
  profiler?.insert("getSyncPlanInplace: finish sorting");
  profiler?.insertSize("sizeof sortedKeys", sortedKeys);

  const keptFolder = new Set<string>();

  for (let i = 0; i < sortedKeys.length; ++i) {
    if (i % 100 === 0) {
      profiler?.insertSize(
        `sizeof sortedKeys in the beginning of i=${i}`,
        mixedEntityMappings
      );
    }
    const key = sortedKeys[i];
    const mixedEntry = mixedEntityMappings[key];

    // Skip entries already decided by a prior pass (matchMoves/detectMoves).
    // The decision tree below would overwrite move decisions with
    // delete/create — defeating rename tracking.
    if (mixedEntry.decision !== undefined) {
      continue;
    }

    const { local, prevSync, remote } = mixedEntry;

    // console.debug(`getSyncPlanInplace: key=${key}`)

    if (key.endsWith("/")) {
      // folder
      // folder doesn't worry about mtime and size, only check their existences
      if (keptFolder.has(key)) {
        // parent should also be kept
        // console.debug(`${key} in keptFolder`)
        keptFolder.add(getParentFolder(key));
        // should fill the missing part
        if (local !== undefined && remote !== undefined) {
          mixedEntry.decisionBranch = 101;
          mixedEntry.decision = "folder_existed_both_then_do_nothing";
          mixedEntry.change = false;
        } else if (local !== undefined && remote === undefined) {
          if (
            syncDirection === "incremental_pull_only" ||
            syncDirection === "incremental_pull_and_delete_only"
          ) {
            mixedEntry.decisionBranch = 107;
            mixedEntry.decision = "folder_to_skip";
            mixedEntry.change = false;
          } else {
            mixedEntry.decisionBranch = 102;
            mixedEntry.decision =
              "folder_existed_local_then_also_create_remote";
            mixedEntry.change = true;
          }
        } else if (local === undefined && remote !== undefined) {
          if (
            syncDirection === "incremental_push_only" ||
            syncDirection === "incremental_push_and_delete_only"
          ) {
            mixedEntry.decisionBranch = 108;
            mixedEntry.decision = "folder_to_skip";
            mixedEntry.change = false;
          } else {
            mixedEntry.decisionBranch = 103;
            mixedEntry.decision =
              "folder_existed_remote_then_also_create_local";
            mixedEntry.change = true;
          }
        } else {
          // why?? how??
          mixedEntry.decisionBranch = 104;
          mixedEntry.decision = "folder_to_be_created";
          mixedEntry.change = true;
        }
        keptFolder.delete(key); // no need to save it in the Set later
      } else {
        if (local !== undefined && remote !== undefined) {
          // both exist, do nothing
          mixedEntry.decisionBranch = 121;
          mixedEntry.decision = "folder_existed_both_then_do_nothing";
          mixedEntry.change = false;
          keptFolder.add(getParentFolder(key));
        } else if (local !== undefined && remote === undefined) {
          if (prevSync !== undefined) {
            // then the folder is deleted on remote
            if (
              syncDirection === "incremental_push_only" ||
              syncDirection === "incremental_push_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 122;
              mixedEntry.decision = "folder_to_skip";
              keptFolder.add(getParentFolder(key));
              mixedEntry.change = false;
            } else if (syncDirection === "incremental_pull_only") {
              mixedEntry.decisionBranch = 123;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else if (syncDirection === "incremental_pull_and_delete_only") {
              if (
                key === `${configDir}/` ||
                key === `${configDir}/bookmarks.json`
              ) {
                // special: never delete .obsidian folder!
                mixedEntry.decisionBranch = 137;
                mixedEntry.decision = "folder_existed_both_then_do_nothing";
                mixedEntry.change = false;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 135;
                mixedEntry.decision = "folder_to_be_deleted_on_local";
                mixedEntry.change = true;
              }
            } else {
              // bidirectional
              if (
                key === `${configDir}/` ||
                key === `${configDir}/bookmarks.json`
              ) {
                // special: never delete .obsidian folder!
                mixedEntry.decisionBranch = 138;
                mixedEntry.decision = "folder_existed_both_then_do_nothing";
                mixedEntry.change = false;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 124;
                mixedEntry.decision = "folder_to_be_deleted_on_local";
                mixedEntry.change = true;
              }
            }
          } else {
            // then the folder is created on local

            if (
              syncDirection === "incremental_push_only" ||
              syncDirection === "incremental_push_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 125;
              mixedEntry.decision =
                "folder_existed_local_then_also_create_remote";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            } else if (
              syncDirection === "incremental_pull_only" ||
              syncDirection === "incremental_pull_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 126;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              // bidirectional
              mixedEntry.decisionBranch = 127;
              mixedEntry.decision =
                "folder_existed_local_then_also_create_remote";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          }
        } else if (local === undefined && remote !== undefined) {
          if (prevSync !== undefined) {
            // then the folder is deleted on local
            if (syncDirection === "incremental_push_only") {
              mixedEntry.decisionBranch = 128;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else if (syncDirection === "incremental_push_and_delete_only") {
              mixedEntry.decisionBranch = 136;
              mixedEntry.decision = "folder_to_be_deleted_on_remote";
              mixedEntry.change = true;
            } else if (
              syncDirection === "incremental_pull_only" ||
              syncDirection === "incremental_pull_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 129;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              // bidirectional
              mixedEntry.decisionBranch = 130;
              mixedEntry.decision = "folder_to_be_deleted_on_remote";
              mixedEntry.change = true;
            }
          } else {
            // then the folder is created on remote
            if (
              syncDirection === "incremental_push_only" ||
              syncDirection === "incremental_push_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 131;
              mixedEntry.decision = "folder_to_skip";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else if (
              syncDirection === "incremental_pull_only" ||
              syncDirection === "incremental_pull_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 132;
              mixedEntry.decision =
                "folder_existed_remote_then_also_create_local";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            } else {
              // bidirectional
              mixedEntry.decisionBranch = 133;
              mixedEntry.decision =
                "folder_existed_remote_then_also_create_local";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          }
        } else {
          // local === undefined && remote === undefined
          // no folder to delete or create, do nothing
          mixedEntry.decisionBranch = 134;
          mixedEntry.decision = "folder_to_skip";
          mixedEntry.change = false;
        }
      }
    } else {
      // file

      if (local === undefined && remote === undefined) {
        // both deleted, only in history
        mixedEntry.decisionBranch = 1;
        mixedEntry.decision = "only_history";
        mixedEntry.change = false;
      } else if (local !== undefined && remote !== undefined) {
        if (
          (local.mtimeCli === remote.mtimeCli ||
            local.mtimeCli === remote.mtimeSvr) &&
          local.sizeEnc === remote.sizeEnc
        ) {
          // completely equal / identical
          mixedEntry.decisionBranch = 2;
          mixedEntry.decision = "equal";
          mixedEntry.change = false;
          keptFolder.add(getParentFolder(key));
        } else {
          // Both exists, but modified or conflict
          // Look for past files of A or B.
          const localEqualPrevSync =
            prevSync?.mtimeCli === local.mtimeCli &&
            prevSync?.sizeEnc === local.sizeEnc;
          const remoteEqualPrevSync =
            (prevSync?.mtimeSvr === remote.mtimeCli ||
              prevSync?.mtimeSvr === remote.mtimeSvr) &&
            prevSync?.sizeEnc === remote.sizeEnc;

          if (localEqualPrevSync && !remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              remote.sizeEnc! <= skipSizeLargerThan
            ) {
              if (
                syncDirection === "incremental_push_only" ||
                syncDirection === "incremental_push_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 26;
                mixedEntry.decision = "conflict_modified_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 9;
                mixedEntry.decision = "remote_is_modified_then_pull";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              }
            } else {
              throw Error(
                `remote is modified (branch 9) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              local.sizeEnc! <= skipSizeLargerThan
            ) {
              if (
                syncDirection === "incremental_pull_only" ||
                syncDirection === "incremental_pull_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 27;
                mixedEntry.decision = "conflict_modified_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                mixedEntry.decisionBranch = 10;
                mixedEntry.decision = "local_is_modified_then_push";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              }
            } else {
              throw Error(
                `local is modified (branch 10) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && !remoteEqualPrevSync) {
            // If both compare False (Didn't exist means both are new. Both exist but don't compare means both are modified)
            if (prevSync === undefined) {
              // Didn't exist means both are new
              if (syncDirection === "bidirectional") {
                if (
                  conflictAction === "keep_newer" ||
                  (conflictAction === "smart_conflict" &&
                    key.startsWith(`${configDir}/`))
                ) {
                  if (
                    (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                    (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                  ) {
                    mixedEntry.decisionBranch = 11;
                    mixedEntry.decision = "conflict_created_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 12;
                    mixedEntry.decision = "conflict_created_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "keep_larger") {
                  if (local.sizeEnc! >= remote.sizeEnc!) {
                    mixedEntry.decisionBranch = 13;
                    mixedEntry.decision = "conflict_created_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 14;
                    mixedEntry.decision = "conflict_created_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "smart_conflict") {
                  // try merge!
                  mixedEntry.decisionBranch = 302;
                  mixedEntry.decision = "conflict_created_then_smart_conflict";
                  mixedEntry.change = true;
                  keptFolder.add(getParentFolder(key));
                }
              } else if (
                syncDirection === "incremental_pull_only" ||
                syncDirection === "incremental_pull_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 22;
                mixedEntry.decision = "conflict_created_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else if (
                syncDirection === "incremental_push_only" ||
                syncDirection === "incremental_push_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 23;
                mixedEntry.decision = "conflict_created_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                throw Error(
                  `no idea how to deal with syncDirection=${String(syncDirection)} while conflict created`
                );
              }
            } else {
              // Both exist but don't compare means both are modified
              if (syncDirection === "bidirectional") {
                if (
                  conflictAction === "keep_newer" ||
                  (conflictAction === "smart_conflict" &&
                    key.startsWith(`${configDir}/`))
                ) {
                  if (
                    (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                    (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                  ) {
                    mixedEntry.decisionBranch = 16;
                    mixedEntry.decision = "conflict_modified_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 17;
                    mixedEntry.decision = "conflict_modified_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "keep_larger") {
                  if (local.sizeEnc! >= remote.sizeEnc!) {
                    mixedEntry.decisionBranch = 18;
                    mixedEntry.decision = "conflict_modified_then_keep_local";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  } else {
                    mixedEntry.decisionBranch = 19;
                    mixedEntry.decision = "conflict_modified_then_keep_remote";
                    mixedEntry.change = true;
                    keptFolder.add(getParentFolder(key));
                  }
                } else if (conflictAction === "smart_conflict") {
                  // yeah, try to merge them!
                  mixedEntry.decisionBranch = 301;
                  mixedEntry.decision = "conflict_modified_then_smart_conflict";
                  mixedEntry.change = true;
                  keptFolder.add(getParentFolder(key));
                }
              } else if (
                syncDirection === "incremental_pull_only" ||
                syncDirection === "incremental_pull_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 24;
                mixedEntry.decision = "conflict_modified_then_keep_remote";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else if (
                syncDirection === "incremental_push_only" ||
                syncDirection === "incremental_push_and_delete_only"
              ) {
                mixedEntry.decisionBranch = 25;
                mixedEntry.decision = "conflict_modified_then_keep_local";
                mixedEntry.change = true;
                keptFolder.add(getParentFolder(key));
              } else {
                throw Error(
                  `no idea how to deal with syncDirection=${String(syncDirection)} while conflict modified`
                );
              }
            }
          } else {
            // Both compare true.
            // This is likely because of the mtimeCli and mtimeSvr tricks.
            // The result should be equal!!!
            mixedEntry.decisionBranch = 21;
            mixedEntry.decision = "equal";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        }
      } else if (local === undefined && remote !== undefined) {
        // A is missing
        if (prevSync === undefined) {
          // if B is not in the previous list, B is new
          if (
            skipSizeLargerThan <= 0 ||
            remote.sizeEnc! <= skipSizeLargerThan
          ) {
            if (
              syncDirection === "incremental_push_only" ||
              syncDirection === "incremental_push_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 28;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 3;
              mixedEntry.decision = "remote_is_created_then_pull";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            mixedEntry.decisionBranch = 36;
            mixedEntry.decision = "remote_is_created_too_large_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        } else if (
          (prevSync.mtimeSvr === remote.mtimeCli ||
            prevSync.mtimeSvr === remote.mtimeSvr) &&
          prevSync.sizeEnc === remote.sizeEnc
        ) {
          // if B is in the previous list and UNMODIFIED, B has been deleted by A
          if (syncDirection === "incremental_push_only") {
            mixedEntry.decisionBranch = 29;
            mixedEntry.decision = "conflict_created_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          } else if (syncDirection === "incremental_push_and_delete_only") {
            mixedEntry.decisionBranch = 38;
            mixedEntry.decision = "local_is_deleted_thus_also_delete_remote";
            mixedEntry.change = true;
          } else if (
            syncDirection === "incremental_pull_only" ||
            syncDirection === "incremental_pull_and_delete_only"
          ) {
            mixedEntry.decisionBranch = 35;
            mixedEntry.decision = "conflict_created_then_keep_remote";
            mixedEntry.change = true;
            keptFolder.add(getParentFolder(key));
          } else {
            mixedEntry.decisionBranch = 4;
            mixedEntry.decision = "local_is_deleted_thus_also_delete_remote";
            mixedEntry.change = true;
          }
        } else {
          // if B is in the previous list and MODIFIED, B has been deleted by A but modified by B
          if (
            skipSizeLargerThan <= 0 ||
            remote.sizeEnc! <= skipSizeLargerThan
          ) {
            if (
              syncDirection === "incremental_push_only" ||
              syncDirection === "incremental_push_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 30;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 5;
              mixedEntry.decision = "remote_is_modified_then_pull";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            throw Error(
              `remote is modified (branch 5) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else if (local !== undefined && remote === undefined) {
        // B is missing

        if (prevSync === undefined) {
          // if A is not in the previous list, A is new
          if (skipSizeLargerThan <= 0 || local.sizeEnc! <= skipSizeLargerThan) {
            if (
              syncDirection === "incremental_pull_only" ||
              syncDirection === "incremental_pull_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 31;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 6;
              mixedEntry.decision = "local_is_created_then_push";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            mixedEntry.decisionBranch = 37;
            mixedEntry.decision = "local_is_created_too_large_then_do_nothing";
            mixedEntry.change = false;
            keptFolder.add(getParentFolder(key));
          }
        } else if (
          (prevSync.mtimeSvr === local.mtimeCli ||
            prevSync.mtimeCli === local.mtimeCli) &&
          prevSync.sizeEnc === local.sizeEnc
        ) {
          // if A is in the previous list and UNMODIFIED, A has been deleted by B
          // But if the file was synthesized (never actually uploaded to OneDrive
          // because emptyFile: "skip"), don't treat it as "remote deleted" —
          // re-push instead to avoid deleting empty notes.
          if (prevSync.synthesizedFile === true) {
            mixedEntry.decisionBranch = 10;
            mixedEntry.decision = "local_is_modified_then_push";
            mixedEntry.change = true;
            keptFolder.add(getParentFolder(key));
          } else if (
            syncDirection === "incremental_push_only" ||
            syncDirection === "incremental_push_and_delete_only"
          ) {
            mixedEntry.decisionBranch = 32;
            mixedEntry.decision = "conflict_created_then_keep_local";
            mixedEntry.change = true;
          } else if (syncDirection === "incremental_pull_only") {
            mixedEntry.decisionBranch = 33;
            mixedEntry.decision = "conflict_created_then_do_nothing";
            mixedEntry.change = false;
          } else if (syncDirection === "incremental_pull_and_delete_only") {
            if (
              key === `${configDir}/` ||
              key === `${configDir}/bookmarks.json`
            ) {
              // special: never delete .obsidian/bookmarks.json file!
              mixedEntry.decisionBranch = 139;
              mixedEntry.decision = "conflict_created_then_keep_local";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 39;
              mixedEntry.decision = "remote_is_deleted_thus_also_delete_local";
              mixedEntry.change = true;
            }
          } else {
            if (
              key === `${configDir}/` ||
              key === `${configDir}/bookmarks.json`
            ) {
              // special: never delete .obsidian/bookmarks.json file!
              mixedEntry.decisionBranch = 140;
              mixedEntry.decision = "conflict_created_then_keep_local";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 7;
              mixedEntry.decision = "remote_is_deleted_thus_also_delete_local";
              mixedEntry.change = true;
            }
          }
        } else {
          // if A is in the previous list and MODIFIED, A has been deleted by B but modified by A
          if (skipSizeLargerThan <= 0 || local.sizeEnc! <= skipSizeLargerThan) {
            if (
              syncDirection === "incremental_pull_only" ||
              syncDirection === "incremental_pull_and_delete_only"
            ) {
              mixedEntry.decisionBranch = 34;
              mixedEntry.decision = "conflict_created_then_do_nothing";
              mixedEntry.change = false;
              keptFolder.add(getParentFolder(key));
            } else {
              mixedEntry.decisionBranch = 8;
              mixedEntry.decision = "local_is_modified_then_push";
              mixedEntry.change = true;
              keptFolder.add(getParentFolder(key));
            }
          } else {
            throw Error(
              `local is modified (branch 8) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else {
        throw Error(
          `should not reach branch -1 while getting sync plan: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }

      if (mixedEntry.decision === undefined) {
        throw Error(
          `unexpectedly no decision of file in the end: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }
    }
  }

  profiler?.insert("getSyncPlanInplace: finish looping");

  keptFolder.delete("/");
  keptFolder.delete("");
  if (keptFolder.size > 0) {
    // L3: warn-skip instead of crash. Stale entries from move/rename
    // (batchRename doesn't fully update prevRemoteEntities) can leave
    // folders with no decisions. Crashing the whole sync is worse than
    // warn-skipping — the next sync's delta will resolve them.
    console.warn(
      `sync: ${keptFolder.size} folder(s) kept with no decisions (likely stale entries from move/rename — warn-skip, not crash): ${String([...keptFolder])}`
    );
  }

  // finally we want to make our life easier
  const currTime = Date.now();
  const currTimeFmt = unixTimeToStr(currTime);
  // because the path should not as / in the beginning,
  // we should be safe to add these keys:
  const sizeofmixedEntityMappings = roughSizeOfObject(mixedEntityMappings);
  mixedEntityMappings["/$@meta"] = {
    key: "/$@meta", // don't mess up with the types
    sideNotes: {
      version: "20240714 fs version",
      generateTime: currTime,
      generateTimeFmt: currTimeFmt,
      service: settings.serviceType,
      concurrency: settings.concurrency,
      hasPassword: settings.password !== "",
      syncObsidianConfig: settings.syncObsidianConfig,
      syncThirdPartyPlugins: settings.syncThirdPartyPlugins,
      syncSelfPlugin: settings.syncSelfPlugin,
      syncBookmarks: settings.syncBookmarks,
      syncAppearance: settings.syncAppearance,
      syncUnderscoreItems: settings.syncUnderscoreItems,
      syncDotItems: settings.syncDotItems,
      skipSizeLargerThan: settings.skipSizeLargerThan,
      protectModifyPercentage: settings.protectModifyPercentage,
      conflictAction: conflictAction,
      syncDirection: syncDirection,
      triggerSource: triggerSource,
      sizeof: sizeofmixedEntityMappings,
    },
  };

  profiler?.insert("getSyncPlanInplace: exit");
  profiler?.insertSize(
    "sizeof mixedEntityMappings in the end of getSyncPlanInplace",
    mixedEntityMappings
  );
  profiler?.removeIndent();

  return mixedEntityMappings;
};

/**
 * Pure move-detection: match "locally-deleted" files against
 * "locally-created" files by quickXorHash + size. Stamps move decisions
 * on matched pairs so getSyncPlanInplace skips them (they're already
 * decided). No I/O — local hashes must be pre-populated on Entity.hash
 * (detectMoves does this; tests inject them directly).
 *
 * Source set: local gone, prevSync/remote still present (vanished locally).
 * Target set: local present, prevSync/remote absent (appeared locally).
 * Match key: quickXorHash === quickXorHash AND size === size.
 */
export const matchMoves = (
  mappings: Record<string, MixedEntity>,
  trackRenames: boolean
): void => {
  if (!trackRenames) return;

  const sources: { key: string; hash: string; size: number }[] = [];
  for (const [key, entry] of Object.entries(mappings)) {
    if (key.endsWith("/")) continue;
    if (entry.decision !== undefined) continue;
    if (
      entry.local === undefined &&
      (entry.prevSync !== undefined || entry.remote !== undefined)
    ) {
      const hash = entry.remote?.hash ?? entry.prevSync?.hash;
      const size =
        entry.remote?.sizeEnc ??
        entry.prevSync?.sizeEnc ??
        entry.remote?.sizeRaw ??
        entry.prevSync?.sizeRaw;
      if (hash !== undefined && size !== undefined) {
        sources.push({ key, hash, size });
      }
    }
  }

  const targets: { key: string; hash: string; size: number }[] = [];
  for (const [key, entry] of Object.entries(mappings)) {
    if (key.endsWith("/")) continue;
    if (entry.decision !== undefined) continue;
    if (
      entry.local !== undefined &&
      entry.prevSync === undefined &&
      entry.remote === undefined
    ) {
      const entity = entry.local;
      const hash = entity.hash;
      const size = entity.sizeEnc ?? entity.sizeRaw;
      if (hash !== undefined && size !== undefined) {
        targets.push({ key, hash, size });
      }
    }
  }

  const usedSources = new Set<string>();
  for (const target of targets) {
    const match = sources.find(
      (s) =>
        !usedSources.has(s.key) &&
        s.hash === target.hash &&
        s.size === target.size
    );
    if (match) {
      usedSources.add(match.key);
      mappings[target.key].decision = "local_moved_then_rename_remote";
      mappings[target.key].decisionBranch = 200;
      mappings[target.key].change = true;
      mappings[target.key].movedFromKey = match.key;
      // Carry the Graph item id from the source's remote/prevSync entity.
      // The move dispatch saves it to the new path's prevSync record so the
      // NEXT sync can detect ghost remotes (old-path entries left by delta
      // merge after a move) by matching remoteId.
      const sourceEntity =
        mappings[match.key].remote ?? mappings[match.key].prevSync;
      mappings[target.key].movedFromRemoteId = sourceEntity?.remoteId;
      mappings[match.key].decision = "moved_away";
      mappings[match.key].decisionBranch = 201;
      mappings[match.key].change = false;
    }
  }
};

/**
 * Infer folder moves from file moves. After matchMoves stamps file move
 * decisions, this function checks if the moved files' old/new parent folders
 * form a folder pair (old folder exists on remote, new folder exists locally).
 * If so, it marks the ROOT folder as a folder move (single PATCH moves the
 * entire subtree) and converts individual file moves inside to "moved_with_parent"
 * (no-op — the folder rename handles them).
 *
 * Only triggers if ALL old-path files are matched as moves (no unmatched
 * files that would need individual delete). Falls back to individual file
 * moves otherwise.
 */
export const matchFolderMoves = (
  mappings: Record<string, MixedEntity>
): void => {
  // Step 1: Find folder pairs from file moves
  const folderPairs: { oldKey: string; newKey: string }[] = [];
  const seenOldParents = new Set<string>();

  for (const [key, entry] of Object.entries(mappings)) {
    if (
      entry.decision === "local_moved_then_rename_remote" &&
      entry.movedFromKey
    ) {
      const oldParent = getParentFolder(entry.movedFromKey);
      const newParent = getParentFolder(key);
      if (!seenOldParents.has(oldParent)) {
        seenOldParents.add(oldParent);
        const oldFolder = mappings[oldParent];
        const newFolder = mappings[newParent];
        if (
          oldFolder &&
          newFolder &&
          oldFolder.local === undefined &&
          (oldFolder.remote !== undefined ||
            oldFolder.prevSync !== undefined) &&
          newFolder.local !== undefined &&
          newFolder.remote === undefined &&
          newFolder.prevSync === undefined
        ) {
          folderPairs.push({ oldKey: oldParent, newKey: newParent });
        }
      }
    }
  }

  if (folderPairs.length === 0) return;

  // Step 2: Root pairs = not children of other pairs
  const rootPairs = folderPairs.filter(
    (pair) =>
      !folderPairs.some(
        (other) =>
          other !== pair &&
          pair.oldKey.startsWith(other.oldKey) &&
          pair.oldKey !== other.oldKey
      )
  );

  // Step 3: Verify ALL old-path files are matched (no unmatched deletes)
  const validPairs = rootPairs.filter((pair) => {
    for (const [k, entry] of Object.entries(mappings)) {
      if (k.startsWith(pair.oldKey) && !k.endsWith("/")) {
        if (entry.local === undefined && entry.decision !== "moved_away") {
          return false;
        }
      }
    }
    return true;
  });

  if (validPairs.length === 0) return;

  // Step 4: Mark folder moves and unmark contents
  for (const pair of validPairs) {
    mappings[pair.oldKey].decision = "folder_moved_away";
    mappings[pair.oldKey].decisionBranch = 210;
    mappings[pair.oldKey].change = false;

    mappings[pair.newKey].decision = "folder_moved_then_rename_remote";
    mappings[pair.newKey].decisionBranch = 211;
    mappings[pair.newKey].change = true;
    mappings[pair.newKey].movedFromKey = pair.oldKey;
    const src = mappings[pair.oldKey].remote ?? mappings[pair.oldKey].prevSync;
    mappings[pair.newKey].movedFromRemoteId = src?.remoteId;

    for (const [k, entry] of Object.entries(mappings)) {
      if (k === pair.oldKey || k === pair.newKey) continue;

      // Old path: everything inside is moved with parent
      if (k.startsWith(pair.oldKey)) {
        entry.decision = "moved_with_parent";
        entry.decisionBranch = 212;
        entry.change = false;
      }
      // New path: only mark matched files and folders with old-path equivalent
      if (k.startsWith(pair.newKey)) {
        if (entry.decision === "local_moved_then_rename_remote") {
          entry.decision = "moved_with_parent";
          entry.decisionBranch = 212;
          entry.change = false;
        } else if (entry.decision === undefined && k.endsWith("/")) {
          const oldEquiv = pair.oldKey + k.slice(pair.newKey.length);
          if (mappings[oldEquiv] && mappings[oldEquiv].local === undefined) {
            entry.decision = "moved_with_parent";
            entry.decisionBranch = 212;
            entry.change = false;
          }
        }
      }
    }
  }

  const fileMovesRemaining = Object.values(mappings).filter(
    (e) => e.decision === "local_moved_then_rename_remote"
  ).length;
  console.debug(
    `matchFolderMoves: ${validPairs.length} root folder move(s), ${fileMovesRemaining} individual file move(s) remaining`
  );
};

/**
 * Async wrapper: computes local quickXorHash for newly-created files
 * (target candidates), then calls matchMoves. Gated by settings.trackRenames
 * and disabled under encryption (ciphertext hash != plaintext hash —
 * rclone-crypt uses a random nonce per upload).
 */
const detectMoves = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  settings: RemotelySavePluginSettings,
  fsEncrypt: FakeFsEncrypt,
  fsLocal: FakeFs,
  profiler: Profiler | undefined
): Promise<void> => {
  profiler?.addIndent();
  profiler?.insert("detectMoves: enter");

  if (!settings.trackRenames) {
    console.debug("detectMoves: trackRenames disabled, skipping");
    profiler?.insert("detectMoves: disabled, skipping");
    profiler?.removeIndent();
    return;
  }

  if (!fsEncrypt.isPasswordEmpty()) {
    console.debug("detectMoves: encryption enabled, skipping (MVP limitation)");
    profiler?.insert(
      "detectMoves: encryption enabled, skipping (MVP limitation)"
    );
    profiler?.removeIndent();
    return;
  }

  console.debug("detectMoves: computing local hashes for new files...");
  let hashedCount = 0;
  for (const [key, entry] of Object.entries(mixedEntityMappings)) {
    if (key.endsWith("/")) continue;
    if (
      entry.local !== undefined &&
      entry.prevSync === undefined &&
      entry.remote === undefined &&
      entry.local.hash === undefined
    ) {
      try {
        const content = await fsLocal.readFile(entry.local.keyRaw);
        entry.local.hash = quickXorHash(content);
        hashedCount += 1;
      } catch (e) {
        console.warn(`detectMoves: could not hash ${key}: ${String(e)}`);
      }
    }
  }
  console.debug(`detectMoves: hashed ${hashedCount} local files`);
  profiler?.insert(`detectMoves: hashed ${hashedCount} local files`);

  matchMoves(mixedEntityMappings, settings.trackRenames ?? false);

  // Infer folder moves from file moves — rename root folder (1 PATCH)
  // instead of individual files. Converts file moves inside to
  // "moved_with_parent" (no-op).
  matchFolderMoves(mixedEntityMappings);

  const moveCount = Object.values(mixedEntityMappings).filter(
    (e) => e.decision === "local_moved_then_rename_remote"
  ).length;
  console.debug(
    `detectMoves: detected ${moveCount} move(s), skipping delete+reupload for those files`
  );

  profiler?.insert("detectMoves: exit");
  profiler?.removeIndent();
};

/**
 * Remove ghost remote entries left by delta merge after a move.
 * When a file is moved (PATCH parentReference), the delta doesn't emit
 * @removed for the old path — the file just "appears" at the new path.
 * But mergeDeltaWithPrevState keeps the old-path entry from the previous
 * state. These ghosts have remote≠undefined but local=undefined and
 * prevSync=undefined (cleared by the move dispatch). They'd be misclassified
 * as "created on remote" and crash getSyncPlanInplace via keptFolder.
 *
 * Detection: if a ghost's remote.remoteId matches a prevSync.remoteId at a
 * DIFFERENT path, the file was moved — delete the ghost's remote.
 * Always runs (not gated by trackRenames) — ghosts can persist across
 * syncs after a move, even if trackRenames is later disabled.
 */
export const removeGhostRemotes = (
  mappings: Record<string, MixedEntity>
): void => {
  const prevSyncRemoteIds = new Map<string, string>();
  for (const [key, entry] of Object.entries(mappings)) {
    if (entry.prevSync?.remoteId !== undefined) {
      prevSyncRemoteIds.set(entry.prevSync.remoteId, key);
    }
  }

  let ghostCount = 0;
  for (const [key, entry] of Object.entries(mappings)) {
    if (
      entry.remote !== undefined &&
      entry.local === undefined &&
      entry.prevSync === undefined &&
      entry.decision === undefined &&
      entry.remote.remoteId !== undefined
    ) {
      const otherKey = prevSyncRemoteIds.get(entry.remote.remoteId);
      if (otherKey !== undefined && otherKey !== key) {
        delete entry.remote;
        ghostCount += 1;
      }
    }
  }
  if (ghostCount > 0) {
    console.debug(
      `removeGhostRemotes: removed ${ghostCount} ghost remote(s) (stale old-path entries from delta merge after move)`
    );
  }
};

export const splitFourStepsOnEntityMappings = (
  mixedEntityMappings: Record<string, MixedEntity>
) => {
  type StepArrayType = MixedEntity[] | undefined | null;
  const onlyMarkSyncedOps: StepArrayType[] = [];
  const folderCreationOps: StepArrayType[] = [];
  const moveOps: StepArrayType[] = [];
  const deletionOps: StepArrayType[] = [];
  const uploadDownloads: StepArrayType[] = [];

  // from long(deep) to short(shadow)
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );

  let allFilesCount = 0; // how many files in entities
  let realModifyDeleteCount = 0; // how many files to be modified / deleted
  let realTotalCount = 0; // how many files to be delt with

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];

    if (key === "/$@meta") {
      continue; // special
    }

    const val = mixedEntityMappings[key];

    if (!key.endsWith("/")) {
      allFilesCount += 1;
    }

    if (
      val.decision === "local_is_created_too_large_then_do_nothing" ||
      val.decision === "remote_is_created_too_large_then_do_nothing" ||
      val.decision === "folder_to_skip"
    ) {
      // pass
    } else if (
      val.decision === "equal" ||
      val.decision === "conflict_created_then_do_nothing" ||
      val.decision === "folder_existed_both_then_do_nothing"
    ) {
      if (
        onlyMarkSyncedOps.length === 0 ||
        onlyMarkSyncedOps[0] === undefined ||
        onlyMarkSyncedOps[0] === null
      ) {
        onlyMarkSyncedOps[0] = [val];
      } else {
        onlyMarkSyncedOps[0].push(val); // only one level is needed here
      }

      // don't need to update realTotalCount here
    } else if (
      val.decision === "folder_existed_local_then_also_create_remote" ||
      val.decision === "folder_existed_remote_then_also_create_local" ||
      val.decision === "folder_to_be_created"
    ) {
      // console.debug(`splitting folder: key=${key},val=${JSON.stringify(val)}`);
      const level = atWhichLevel(key);
      // console.debug(`atWhichLevel: ${level}`);
      const k = folderCreationOps[level - 1];
      if (k === undefined || k === null) {
        folderCreationOps[level - 1] = [val];
      } else {
        k.push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "only_history" ||
      val.decision === "local_is_deleted_thus_also_delete_remote" ||
      val.decision === "remote_is_deleted_thus_also_delete_local" ||
      val.decision === "folder_to_be_deleted_on_both" ||
      val.decision === "folder_to_be_deleted_on_local" ||
      val.decision === "folder_to_be_deleted_on_remote"
    ) {
      const level = atWhichLevel(key);
      const k = deletionOps[level - 1];
      if (k === undefined || k === null) {
        deletionOps[level - 1] = [val];
      } else {
        k.push(val);
      }
      realTotalCount += 1;

      if (
        val.decision.includes("deleted") &&
        !val.decision.includes("folder")
      ) {
        // only count files here, skip folder
        realModifyDeleteCount += 1;
      }
    } else if (
      val.decision === "local_is_modified_then_push" ||
      val.decision === "remote_is_modified_then_pull" ||
      val.decision === "local_is_created_then_push" ||
      val.decision === "remote_is_created_then_pull" ||
      val.decision === "conflict_created_then_keep_local" ||
      val.decision === "conflict_created_then_keep_remote" ||
      val.decision === "conflict_created_then_smart_conflict" ||
      val.decision === "conflict_modified_then_keep_local" ||
      val.decision === "conflict_modified_then_keep_remote" ||
      val.decision === "conflict_modified_then_smart_conflict"
    ) {
      if (
        uploadDownloads.length === 0 ||
        uploadDownloads[0] === undefined ||
        uploadDownloads[0] === null
      ) {
        uploadDownloads[0] = [val];
      } else {
        uploadDownloads[0].push(val); // only one level is needed here
      }
      realTotalCount += 1;

      if (
        val.decision.includes("modified") ||
        val.decision.includes("conflict")
      ) {
        realModifyDeleteCount += 1;
      }
    } else if (
      val.decision === "moved_away" ||
      val.decision === "folder_moved_away" ||
      val.decision === "moved_with_parent"
    ) {
      // Old-path half of a move, or contents moved with parent folder —
      // just needs prevSync record cleanup (no-op)
      if (
        onlyMarkSyncedOps.length === 0 ||
        onlyMarkSyncedOps[0] === undefined ||
        onlyMarkSyncedOps[0] === null
      ) {
        onlyMarkSyncedOps[0] = [val];
      } else {
        onlyMarkSyncedOps[0].push(val);
      }
      // Don't increment realTotalCount — no actual transfer
    } else if (
      val.decision === "local_moved_then_rename_remote" ||
      val.decision === "folder_moved_then_rename_remote"
    ) {
      // Move: rename on remote (metadata op, no content transfer)
      // Routed to moveOps (executed BEFORE deletions) so files are moved
      // out of old folders before those folders are deleted.
      if (
        moveOps.length === 0 ||
        moveOps[0] === undefined ||
        moveOps[0] === null
      ) {
        moveOps[0] = [val];
      } else {
        moveOps[0].push(val);
      }
      realTotalCount += 1;
      // Do NOT increment realModifyDeleteCount — rename is content-preserving
    } else {
      throw Error(`unknown decision ${val.decision} for ${key}`);
    }
  }

  // the deletionOps should be run from max level to min level
  // right now it is sorted by level from min to max (NOT length of key!)
  // so we need to reverse it!
  deletionOps.reverse(); // inplace reverse

  return {
    onlyMarkSyncedOps: onlyMarkSyncedOps,
    folderCreationOps: folderCreationOps,
    moveOps: moveOps,
    deletionOps: deletionOps,
    uploadDownloads: uploadDownloads,
    allFilesCount: allFilesCount,
    realModifyDeleteCount: realModifyDeleteCount,
    realTotalCount: realTotalCount,
  };
};

const fullfillMTimeOfRemoteEntityInplace = (
  remote: Entity,
  mtimeCli?: number
) => {
  // TODO:
  // mtimeCli is not reliably updated by the remote, so we don't depend on it here.
  // if the content is not updated even the time is updated...
  // so we do not check remote.mtimeCli for now..
  if (
    mtimeCli !== undefined &&
    mtimeCli > 0 /* &&
    (remote.mtimeCli === undefined ||
      remote.mtimeCli <= 0 ||
      (remote.mtimeSvr !== undefined &&
        remote.mtimeSvr > 0 &&
        remote.mtimeCli >= remote.mtimeSvr))
    */
  ) {
    remote.mtimeCli = mtimeCli;
  }
  return remote;
};

/**
 * The "heavy lifting" shared by the conflict_*_then_smart_conflict decisions:
 * three-way merge via mergeFile for mergeable text files, otherwise
 * tryDuplicateFile (.dup rename + upload + download). Extracted verbatim from
 * the conflict branch of dispatchOperationToActualV3 so the push-path 412
 * re-route (If-Match precondition failure -> REMOTE_ETAG_MISMATCH) runs the
 * EXACT same code path as a walk-time-detected conflict.
 */
export const handleConflictModifiedSmartConflict = async (
  r: MixedEntity,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  isFileDirtyOpen?: (path: string) => boolean,
  dirtyOpenHandledPaths?: Set<string>
) => {
  // Dirty-buffer guard: both sub-paths below would clobber an unsaved
  // editor buffer — mergeFile writes the merged result over the local
  // file, and tryDuplicateFile renames the local file away then downloads
  // over the original name. Instead, write ONE .dup conflict copy (holding
  // the merged content for mergeable files, the raw remote content
  // otherwise), leave the local file and the remote completely untouched,
  // and skip ALL prev-sync record updates (no clear, no upsert), so a
  // later run re-decides this conflict from the unchanged state once the
  // user saves the buffer.
  if (!r.key.endsWith("/") && isFileDirtyOpen?.(r.key) === true) {
    if (!dirtyOpenHandledPaths?.has(r.key)) {
      dirtyOpenHandledPaths?.add(r.key);
      let mergedContent: ArrayBuffer | undefined = undefined;
      if (isMergable(r.local!, r.remote!)) {
        const origContent = await getFileContentHistoryByVaultAndProfile(
          db,
          vaultRandomID,
          profileID,
          r.local!
        );
        mergedContent = await computeMergedContent(
          r.key,
          fsLocal,
          fsEncrypt,
          origContent
        );
      }
      await writeDupCopyForDirtyOpen(r.key, fsLocal, fsEncrypt, {
        content: mergedContent,
        remoteMtime: r.remote?.mtimeCli ?? r.remote?.mtimeSvr,
      });
    }
    return;
  }

  // heavy lifting
  if (isMergable(r.local!, r.remote!)) {
    const origContent = await getFileContentHistoryByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.local!
    );
    // console.debug(`we get origContent:`)
    // console.debug(origContent)
    const { entity, content } = await mergeFile(
      r.key,
      fsLocal,
      fsEncrypt,
      origContent
    );
    await upsertPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      entity
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      entity,
      content
    );
  } else {
    // duplicate the files
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.key
    );
    const mtimeCli = (await fsLocal.stat(r.key)).mtimeCli!;
    await tryDuplicateFile(
      r.key,
      fsLocal,
      fsEncrypt,
      async (upload) => {
        if (upload !== undefined) {
          // TODO: abstract away the dirty hack
          fullfillMTimeOfRemoteEntityInplace(upload, mtimeCli);
          await upsertPrevSyncRecordByVaultAndProfile(
            db,
            vaultRandomID,
            profileID,
            upload
          );
        }
      },
      async (download) => {
        if (download !== undefined) {
          await upsertPrevSyncRecordByVaultAndProfile(
            db,
            vaultRandomID,
            profileID,
            download
          );
        }
      }
    );
  }
};

export const dispatchOperationToActualV3 = async (
  key: string,
  vaultRandomID: string,
  profileID: string,
  r: MixedEntity,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: InternalDBs,
  conflictAction: ConflictActionType,
  conflictsEncountered?: ConflictLogEntry[],
  isFileDirtyOpen?: (path: string) => boolean,
  dirtyOpenHandledPaths?: Set<string>
) => {
  // console.debug(
  //   `inside dispatchOperationToActualV3, key=${key}, r=${JSON.stringify(
  //     r,
  //     null,
  //     2
  //   )}`
  // );
  if (r.decision === "only_history") {
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      key
    );
    if (conflictAction === "smart_conflict") {
      await clearFileContentHistoryByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
    }
  } else if (
    r.decision === "local_is_created_too_large_then_do_nothing" ||
    r.decision === "remote_is_created_too_large_then_do_nothing" ||
    r.decision === "folder_to_skip"
  ) {
    // !! no actual sync being kept happens,
    // so no sync record here
    // pass
  } else if (
    r.decision === "equal" ||
    r.decision === "conflict_created_then_do_nothing" ||
    r.decision === "folder_existed_both_then_do_nothing"
  ) {
    // !! we MIGHT need to upsert the record,
    // so that next time we can determine the change delta

    if (r.prevSync !== undefined) {
      // if we have prevSync,
      // we don't need to update prevSync, because the record is already there!

      // but we might need to update content, because it's a new feature
      if (conflictAction === "smart_conflict") {
        if (isMergable(r.local!)) {
          const k = await getFileContentHistoryByVaultAndProfile(
            db,
            vaultRandomID,
            profileID,
            r.local!
          );
          if (k === null || k === undefined) {
            await upsertFileContentHistoryByVaultAndProfile(
              db,
              vaultRandomID,
              profileID,
              r.local!,
              await fsLocal.readFile(r.local!.keyRaw)
            );
          }
        }
      }
    } else {
      // if we don't have prevSync, we use remote entity AND local mtime
      // as if it is "uploaded"
      if (r.remote !== undefined) {
        let entity = r.remote;
        // TODO: abstract away the dirty hack
        entity = fullfillMTimeOfRemoteEntityInplace(entity, r.local?.mtimeCli);

        if (entity !== undefined) {
          await upsertPrevSyncRecordByVaultAndProfile(
            db,
            vaultRandomID,
            profileID,
            entity
          );
          if (conflictAction === "smart_conflict") {
            if (isMergable(entity)) {
              await upsertFileContentHistoryByVaultAndProfile(
                db,
                vaultRandomID,
                profileID,
                entity,
                await fsLocal.readFile(entity.keyRaw)
              );
            }
          }
        }
      }
    }
  } else if (
    r.decision === "local_is_modified_then_push" ||
    r.decision === "local_is_created_then_push" ||
    r.decision === "folder_existed_local_then_also_create_remote" ||
    r.decision === "conflict_created_then_keep_local" ||
    r.decision === "conflict_modified_then_keep_local"
  ) {
    // console.debug(`before upload in sync, r=${JSON.stringify(r, null, 2)}`);
    const mtimeCli = (await fsLocal.stat(r.key)).mtimeCli!;
    try {
      const { entity, content } = await copyFileOrFolder(
        r.key,
        fsLocal,
        fsEncrypt,
        r.remote?.etag
      );
      // TODO: abstract away the dirty hack
      fullfillMTimeOfRemoteEntityInplace(entity, mtimeCli);
      // console.debug(`after fullfill, entity=${JSON.stringify(entity,null,2)}`)
      await upsertPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        entity
      );
      if (conflictAction === "smart_conflict") {
        if (isMergable(entity)) {
          await upsertFileContentHistoryByVaultAndProfile(
            db,
            vaultRandomID,
            profileID,
            entity,
            content!
          );
        }
      }
    } catch (e: any) {
      if ((e as any)?.code === "REMOTE_ETAG_MISMATCH") {
        // 412 = OneDrive atomically REJECTED the write (If-Match
        // precondition failed): nothing was written remotely and the local
        // file is untouched, so there is no half state. Re-route this entry
        // to the exact same path a walk-time-detected conflict takes
        // (mergeFile for mergeable text, tryDuplicateFile otherwise)
        // instead of silently clobbering the other device's change or
        // hard-failing the whole sync.
        r.decision = "conflict_modified_then_smart_conflict";
        await handleConflictModifiedSmartConflict(
          r,
          fsLocal,
          fsEncrypt,
          db,
          vaultRandomID,
          profileID,
          isFileDirtyOpen,
          dirtyOpenHandledPaths
        );
        // C4 (Task 7): record the SUCCESSFULLY re-routed conflict (the
        // handler returned without throwing) so main.ts can notify the user
        // and append to the vault-root conflict log after the sync — the
        // absorbed error never reaches errNotifyFunc. The disposition is
        // decided by the same condition the handler branches on.
        conflictsEncountered?.push({
          ts: new Date(),
          key: r.key,
          walkEtag: r.remote?.etag,
          disposition: isMergable(r.local!, r.remote!)
            ? "merged"
            : "duplicated",
        });
      } else {
        throw e;
      }
    }
  } else if (
    r.decision === "remote_is_modified_then_pull" ||
    r.decision === "remote_is_created_then_pull" ||
    r.decision === "conflict_created_then_keep_remote" ||
    r.decision === "conflict_modified_then_keep_remote" ||
    r.decision === "folder_existed_remote_then_also_create_local"
  ) {
    // Dirty-buffer guard: the download below ends in fsLocal.writeFile ->
    // vault.adapter.writeBinary, which bypasses Obsidian's editor
    // reconciliation, and the sync plan only saw the ON-DISK mtime, so an
    // unsaved editor buffer is invisible to the conflict decisions. If the
    // target file is open with unsaved changes, do NOT overwrite it: write
    // the remote content to a .dup conflict copy instead, and skip the
    // prev-sync record + content history updates below, so a later run
    // retries this download once the user saves the buffer.
    if (!r.key.endsWith("/") && isFileDirtyOpen?.(r.key) === true) {
      if (!dirtyOpenHandledPaths?.has(r.key)) {
        dirtyOpenHandledPaths?.add(r.key);
        await writeDupCopyForDirtyOpen(r.key, fsLocal, fsEncrypt, {
          remoteMtime: r.remote?.mtimeCli ?? r.remote?.mtimeSvr,
        });
      }
      return;
    }
    let c1: ArrayBuffer | undefined = undefined;
    if (r.key.endsWith("/")) {
      await fsLocal.mkdir(r.key);
    } else {
      const { content } = await copyFile(r.key, fsEncrypt, fsLocal);
      c1 = content;
    }
    await upsertPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.remote!
    );
    if (conflictAction === "smart_conflict") {
      if (isMergable(r.remote!)) {
        await upsertFileContentHistoryByVaultAndProfile(
          db,
          vaultRandomID,
          profileID,
          r.remote!,
          c1! // always file, always has real value
        );
      }
    }
  } else if (r.decision === "local_is_deleted_thus_also_delete_remote") {
    // local is deleted, we need to delete remote now
    await fsEncrypt.rm(r.key);
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.key
    );
    if (conflictAction === "smart_conflict") {
      if (isMergable(r.remote!)) {
        await clearFileContentHistoryByVaultAndProfile(
          db,
          vaultRandomID,
          profileID,
          r.key
        );
      }
    }
  } else if (r.decision === "remote_is_deleted_thus_also_delete_local") {
    // Dirty-buffer guard: deleting the disk file under an editor with
    // unsaved changes can make Obsidian drop the editor and lose the
    // user's buffer. Keep the local file in place — that IS the
    // protection here; the remote is already gone, so there is nothing
    // to preserve and NO .dup copy is written (unlike the download /
    // smart-conflict guards). Also skip clearing the prev-sync record
    // (and the file-content history) below, so the next run re-decides
    // this path from the unchanged state: once the user saves the
    // buffer, the disk mtime advances and the plan becomes branch 8
    // (local_is_modified_then_push — the file is re-created on the
    // remote) or branch 34 (do-nothing) for pull-only directions, which
    // the existing conflict logic already handles. Self-resolving.
    if (!r.key.endsWith("/") && isFileDirtyOpen?.(r.key) === true) {
      if (!dirtyOpenHandledPaths?.has(r.key)) {
        dirtyOpenHandledPaths?.add(r.key);
        console.debug(
          `dirty-open guard: ${r.key} is open with unsaved changes, skipping local deletion of the remote-deleted file`
        );
      }
      return;
    }
    // remote is deleted, we need to delete local now
    await fsLocal.rm(r.key);
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.key
    );
    if (conflictAction === "smart_conflict") {
      if (isMergable(r.local!)) {
        await clearFileContentHistoryByVaultAndProfile(
          db,
          vaultRandomID,
          profileID,
          r.key
        );
      }
    }
  } else if (
    r.decision === "conflict_created_then_smart_conflict" ||
    r.decision === "conflict_modified_then_smart_conflict"
  ) {
    await handleConflictModifiedSmartConflict(
      r,
      fsLocal,
      fsEncrypt,
      db,
      vaultRandomID,
      profileID,
      isFileDirtyOpen,
      dirtyOpenHandledPaths
    );
  } else if (r.decision === "folder_to_be_created") {
    await fsLocal.mkdir(r.key);
    const { entity } = await copyFolder(r.key, fsLocal, fsEncrypt);
    await upsertPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      entity
    );
    // no need to record file content for folder here
  } else if (
    r.decision === "folder_to_be_deleted_on_both" ||
    r.decision === "folder_to_be_deleted_on_local" ||
    r.decision === "folder_to_be_deleted_on_remote"
  ) {
    if (
      r.decision === "folder_to_be_deleted_on_both" ||
      r.decision === "folder_to_be_deleted_on_local"
    ) {
      await fsLocal.rm(r.key);
    }
    if (
      r.decision === "folder_to_be_deleted_on_both" ||
      r.decision === "folder_to_be_deleted_on_remote"
    ) {
      await fsEncrypt.rm(r.key);
    }
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.key
    );
    // no need to record file content for folder here
  } else if (
    r.decision === "local_moved_then_rename_remote" ||
    r.decision === "folder_moved_then_rename_remote"
  ) {
    // Rename on remote: old key -> this key (the new path)
    const oldKey = r.movedFromKey!;
    await fsEncrypt.rename(oldKey, r.key);
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      oldKey
    );
    if (r.local !== undefined) {
      if (r.movedFromRemoteId !== undefined) {
        r.local.remoteId = r.movedFromRemoteId;
      }
      await upsertPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        r.local
      );
    }
  } else if (
    r.decision === "moved_away" ||
    r.decision === "folder_moved_away"
  ) {
    // Old-path half of a move pair. The rename is executed on the target key.
    // Just clear the stale prevSync record.
    await clearPrevSyncRecordByVaultAndProfile(
      db,
      vaultRandomID,
      profileID,
      r.key
    );
  } else if (r.decision === "moved_with_parent") {
    // Contents moved with parent folder — already on remote after folder rename.
    if (r.local !== undefined) {
      // New path: create prevSync record
      if (r.movedFromRemoteId !== undefined) {
        r.local.remoteId = r.movedFromRemoteId;
      }
      await upsertPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        r.local
      );
    } else {
      // Old path: clear stale prevSync
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        r.key
      );
    }
  } else {
    throw Error(`don't know how to dispatch decision: ${JSON.stringify(r)}`);
  }
};

export const doActualSync = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  vaultRandomID: string,
  profileID: string,
  concurrency: number,
  protectModifyPercentage: number,
  getProtectModifyPercentageErrorStrFunc: any,
  db: InternalDBs,
  profiler: Profiler | undefined,
  conflictAction: ConflictActionType,
  triggerSource: SyncTriggerSourceType,
  callbackSyncProcess?: any,
  remoteDeltaCount?: number,
  conflictsEncountered?: ConflictLogEntry[],
  isFileDirtyOpen?: (path: string) => boolean,
  dirtyOpenHandledPaths?: Set<string>
) => {
  profiler?.addIndent();
  profiler?.insert("doActualSync: enter");
  console.debug(`concurrency === ${concurrency}`);
  const {
    onlyMarkSyncedOps,
    folderCreationOps,
    moveOps,
    deletionOps,
    uploadDownloads,
    allFilesCount,
    realModifyDeleteCount,
    realTotalCount,
  } = splitFourStepsOnEntityMappings(mixedEntityMappings);
  // console.debug(`onlyMarkSyncedOps: ${JSON.stringify(onlyMarkSyncedOps)}`);
  // console.debug(`folderCreationOps: ${JSON.stringify(folderCreationOps)}`);
  // console.debug(`deletionOps: ${JSON.stringify(deletionOps)}`);
  // console.debug(`uploadDownloads: ${JSON.stringify(uploadDownloads)}`);
  console.debug(`allFilesCount: ${allFilesCount}`);
  console.debug(`realModifyDeleteCount: ${realModifyDeleteCount}`);
  console.debug(`realTotalCount: ${realTotalCount}`);
  profiler?.insert("doActualSync: finish splitting steps");

  profiler?.insertSize(
    "doActualSync: sizeof onlyMarkSyncedOps",
    onlyMarkSyncedOps
  );
  profiler?.insertSize(
    "doActualSync: sizeof folderCreationOps",
    folderCreationOps
  );
  profiler?.insertSize("doActualSync: sizeof realTotalCount", deletionOps);

  console.debug(`protectModifyPercentage: ${protectModifyPercentage}`);

  if (
    protectModifyPercentage >= 0 &&
    realModifyDeleteCount >= 0 &&
    allFilesCount > 0
  ) {
    if (
      protectModifyPercentage === 100 &&
      realModifyDeleteCount === allFilesCount
    ) {
      // special treatment for 100%
      // let it pass, we do nothing here
    } else if (
      realModifyDeleteCount * 100 >=
      allFilesCount * protectModifyPercentage
    ) {
      const errorStr: string = getProtectModifyPercentageErrorStrFunc(
        protectModifyPercentage,
        realModifyDeleteCount,
        allFilesCount
      );

      profiler?.insert("doActualSync: error branch");
      profiler?.removeIndent();
      throw Error(errorStr);
    }
  }

  const nested = [
    onlyMarkSyncedOps,
    folderCreationOps,
    moveOps,
    deletionOps,
    uploadDownloads,
  ];
  const logTexts = [
    `1. record the items already being synced`,
    `2. create all folders from shadowest to deepest`,
    `3. rename moved files on remote (before deleting old folders)`,
    `4. delete files and folders from deepest to shadowest`,
    `5. upload or download files in parallel, with the desired concurrency=${concurrency}`,
  ];

  let realCounter = 0;
  for (let i = 0; i < nested.length; ++i) {
    // C optimization: Skip onlyMarkSyncedOps when remote is unchanged
    // (delta=0). "equal" files with prevSync don't need any operation —
    // their prevSync records are already correct. Only skip when not using
    // smart_conflict (which might need content history updates).
    if (
      i === 0 &&
      remoteDeltaCount === 0 &&
      conflictAction !== "smart_conflict"
    ) {
      console.debug("Skipping onlyMarkSyncedOps: remote unchanged (delta=0)");
      profiler?.insert(
        "doActualSync: skipped step 0 (onlyMarkSyncedOps, delta=0)"
      );
      continue;
    }

    profiler?.addIndent();
    profiler?.insert(`doActualSync: step ${i} start`);
    console.debug(logTexts[i]);

    const operations = nested[i];

    for (let j = 0; j < operations.length; ++j) {
      const singleLevelOps = operations[j];
      if (singleLevelOps === undefined || singleLevelOps === null) {
        continue;
      }

      const potentialErrors: Error[] = [];
      let tooManyErrors = false;

      // D optimization: For upload/download step (i=4), split into
      // dual queues for parallel upload+download execution.
      if (i === 4) {
        const { uploads, downloads } = splitUploadDownloadOps(singleLevelOps);
        const uploadQueue = new PQueue({
          concurrency,
          autoStart: true,
        });
        const downloadQueue = new PQueue({
          concurrency,
          autoStart: true,
        });

        const makeFn = (val: MixedEntity) => async () => {
          await callbackSyncProcess?.(
            triggerSource,
            realCounter,
            realTotalCount,
            val.key,
            val.decision
          );
          if (val.change === undefined || val.change) {
            realCounter += 1;
          }
          await dispatchOperationToActualV3(
            val.key,
            vaultRandomID,
            profileID,
            val,
            fsLocal,
            fsEncrypt,
            db,
            conflictAction,
            conflictsEncountered,
            isFileDirtyOpen,
            dirtyOpenHandledPaths
          );
        };

        const makeCatch = () => (e: any) => {
          // Preserve .code and .key from the original error so
          // errNotifyFunc can identify REMOTE_NOT_FOUND and trigger
          // the self-heal (clearing stale delta state).
          const wrapped = new Error(e.message);
          (wrapped as any).code = (e as any)?.code;
          (wrapped as any).key = (e as any)?.key;
          potentialErrors.push(wrapped);
          if (potentialErrors.length >= 3) {
            tooManyErrors = true;
            uploadQueue.pause();
            uploadQueue.clear();
            downloadQueue.pause();
            downloadQueue.clear();
          }
        };

        for (const val of uploads) {
          uploadQueue.add(makeFn(val)).catch(makeCatch());
        }
        for (const val of downloads) {
          downloadQueue.add(makeFn(val)).catch(makeCatch());
        }

        await Promise.all([uploadQueue.onIdle(), downloadQueue.onIdle()]);
      } else if (i === 2 && singleLevelOps.length > 0) {
        // moveOps: batch all renames into one $batch request, then
        // process results (clear old prevSync + upsert new prevSync).
        // This replaces N individual rename HTTP calls with 1 batch call.
        const batchOps: BatchRenameOp[] = singleLevelOps.map((val) => {
          // Phase 3: look up parent folder remoteId from the entity
          // map to skip the stat call in fsOnedrive.batchRename.
          // Newly created folders won't have a remoteId here (mkdir
          // response isn't captured into the map), so those fall
          // back to stat via the _parentRemoteIdCache safety net.
          const k = val.key.endsWith("/") ? val.key.slice(0, -1) : val.key;
          const slashIdx = k.lastIndexOf("/");
          const parentKey = slashIdx === -1 ? "" : `${k.slice(0, slashIdx)}/`;
          const parentEntity = parentKey
            ? mixedEntityMappings[parentKey]
            : undefined;
          return {
            key1: val.movedFromKey!,
            key2: val.key,
            sourceRemoteId: val.movedFromRemoteId,
            targetParentRemoteId:
              parentEntity?.remote?.remoteId ??
              parentEntity?.prevSync?.remoteId,
          };
        });

        console.debug(`doActualSync: batchRename ${batchOps.length} move ops`);
        const results = await fsEncrypt.batchRename(batchOps);

        for (let k = 0; k < singleLevelOps.length; ++k) {
          const val = singleLevelOps[k];
          const result = results[k];

          await callbackSyncProcess?.(
            triggerSource,
            realCounter,
            realTotalCount,
            val.key,
            val.decision
          );
          if (val.change === undefined || val.change) {
            realCounter += 1;
          }

          if (!result.ok) {
            const err =
              result.error ??
              new Error(`batch rename failed: ${result.status}`);
            const wrapped = new Error(`${val.key}: ${err.message}`);
            (wrapped as any).code = (err as any)?.code;
            (wrapped as any).key = val.key;
            potentialErrors.push(wrapped);
            if (potentialErrors.length >= 3) {
              tooManyErrors = true;
            }
          } else {
            const oldKey = val.movedFromKey!;
            await clearPrevSyncRecordByVaultAndProfile(
              db,
              vaultRandomID,
              profileID,
              oldKey
            );
            if (val.local !== undefined) {
              if (val.movedFromRemoteId !== undefined) {
                val.local.remoteId = val.movedFromRemoteId;
              }
              await upsertPrevSyncRecordByVaultAndProfile(
                db,
                vaultRandomID,
                profileID,
                val.local
              );
            }
          }
        }
      } else {
        // Single queue (steps 0-1, 3: onlyMarkSyncedOps, folderCreation, deletion)
        const queue = new PQueue({
          concurrency,
          autoStart: true,
        });

        for (let k = 0; k < singleLevelOps.length; ++k) {
          const val = singleLevelOps[k];
          const key = val.key;

          const fn = async () => {
            await callbackSyncProcess?.(
              triggerSource,
              realCounter,
              realTotalCount,
              key,
              val.decision
            );
            if (val.change === undefined || val.change) {
              realCounter += 1;
            }
            await dispatchOperationToActualV3(
              key,
              vaultRandomID,
              profileID,
              val,
              fsLocal,
              fsEncrypt,
              db,
              conflictAction,
              conflictsEncountered,
              isFileDirtyOpen,
              dirtyOpenHandledPaths
            );
          };

          queue.add(fn).catch((e) => {
            const msg = `${key}: ${e.message}`;
            // Preserve .code and .key from the original error so
            // errNotifyFunc can identify REMOTE_NOT_FOUND and trigger
            // the self-heal (clearing stale delta state).
            const wrapped = new Error(msg);
            (wrapped as any).code = (e as any)?.code;
            (wrapped as any).key = (e as any)?.key;
            potentialErrors.push(wrapped);
            if (potentialErrors.length >= 3) {
              tooManyErrors = true;
              queue.pause();
              queue.clear();
            }
          });
        }

        await queue.onIdle();
      }

      if (potentialErrors.length > 0) {
        if (tooManyErrors) {
          potentialErrors.push(
            new Error("too many errors, stop the remaining tasks")
          );
        }
        throw new AggregateError(potentialErrors);
      }
    }

    profiler?.insert(`doActualSync: step ${i} end`);
    profiler?.removeIndent();
  }

  profiler?.insert(`doActualSync: exit`);
  profiler?.removeIndent();
};

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_local_meta"
  | "getting_local_prev_sync"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "cleaning"
  | "finish";

/**
 * Every input variable should be mockable, so that testable.
 */
export async function syncer(
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  profiler: Profiler | undefined,
  db: InternalDBs,
  triggerSource: SyncTriggerSourceType,
  profileID: string,
  vaultRandomID: string,
  configDir: string,
  selfPluginId: string,
  settings: RemotelySavePluginSettings,
  pluginVersion: string,
  configSaver: () => Promise<any>,
  getProtectModifyPercentageErrorStrFunc: any,
  markIsSyncingFunc: (isSyncing: boolean) => void,
  notifyFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>,
  errNotifyFunc?: (s: SyncTriggerSourceType, error: Error) => Promise<any>,
  ribboonFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>,
  statusBarFunc?: (
    s: SyncTriggerSourceType,
    step: number,
    everythingOk: boolean
  ) => any,
  callbackSyncProcess?: any,
  // Dirty-buffer protection: injected by main.ts, returns true when the
  // (plain-text, vault-relative) path is currently open in an editor with
  // unsaved changes. Optional — when not supplied, the guard is a no-op
  // and behavior is unchanged.
  isFileDirtyOpen?: (path: string) => boolean
) {
  debugInfo(`starting sync.`);
  markIsSyncingFunc(true);

  let everythingOk = true;
  let step = 0;
  // C4 (Task 7): 412 re-routed conflicts collected during this run. The
  // re-route absorbs REMOTE_ETAG_MISMATCH (nothing reaches errNotifyFunc),
  // so main.ts reads this from the return value after the sync to notify
  // the user and append to the vault-root conflict log.
  const conflictsEncountered: ConflictLogEntry[] = [];

  // Dirty-buffer guard anti-loop / dedupe: paths the dirty-open guard has
  // already handled during THIS run — either by writing a .dup conflict
  // copy (download / smart-conflict paths) or by skipping a local
  // deletion (remote-deleted path) — so each dirty-open file is acted on
  // and logged at most once per run. Fresh set per syncer call; across
  // runs the dup-chain freshness check inside writeDupCopyForDirtyOpen
  // takes over for the copy-writing paths.
  const dirtyOpenHandledPaths = new Set<string>();

  try {
    // try mode?
    await notifyFunc?.(triggerSource, step);

    step = 1;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
    profiler?.insert("start big sync func");

    step = 2;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
    if (fsEncrypt.innerFs !== fsRemote) {
      throw Error(`your enc should has inner of the remote`);
    }
    const passwordCheckResult = await fsEncrypt.isPasswordOk();
    if (!passwordCheckResult.ok) {
      throw Error(passwordCheckResult.reason);
    }
    profiler?.insert(
      `finish step${step} (list partial remote and check password)`
    );

    step = 3;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
    const remoteEntityList = await fsEncrypt.walk();
    // console.debug(`remoteEntityList:`);
    // console.debug(remoteEntityList);
    profiler?.insert(`finish step${step} (list remote)`);

    step = 4;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
    const localEntityList = await fsLocal.walk();
    // console.debug(`localEntityList:`);
    // console.debug(localEntityList);
    profiler?.insert(`finish step${step} (list local)`);

    step = 5;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
    const prevSyncEntityList = await getAllPrevSyncRecordsByVaultAndProfile(
      db,
      vaultRandomID,
      profileID
    );
    // console.debug(`prevSyncEntityList:`);
    // console.debug(prevSyncEntityList);
    profiler?.insert(`finish step${step} (prev sync)`);

    // Early exit optimization: if remote is unchanged (delta=0) and local
    // is unchanged (all mtimes match prevSync), skip sync plan building and
    // execution entirely. Reduces "no changes" sync from O(N) to O(1).
    const skipSync = shouldSkipSync(
      fsRemote.lastWalkDeltaCount,
      localEntityList,
      prevSyncEntityList
    );
    if (skipSync) {
      debugInfo(
        "No changes detected (remote delta=0, local mtime all match). Skipping sync plan and execution."
      );
      profiler?.insert(
        "early exit: no changes detected, skipping sync plan and execution"
      );
    } else {
      step = 6;
      await notifyFunc?.(triggerSource, step);
      await ribboonFunc?.(triggerSource, step);
      await statusBarFunc?.(triggerSource, step, everythingOk);
      let mixedEntityMappings = await ensembleMixedEnties(
        localEntityList,
        prevSyncEntityList,
        remoteEntityList,
        settings.syncObsidianConfig ?? true,
        settings.syncThirdPartyPlugins ?? true,
        settings.syncSelfPlugin ?? true,
        settings.syncBookmarks ?? false,
        settings.syncAppearance ?? false,
        configDir,
        settings.syncUnderscoreItems ?? false,
        settings.syncDotItems ?? false,
        settings.ignorePaths ?? [],
        settings.onlyAllowPaths ?? [],
        selfPluginId,
        fsEncrypt,
        settings.serviceType,
        profiler
      );
      profiler?.insert(`finish step${step} (build partial mixedEntity)`);

      await detectMoves(
        mixedEntityMappings,
        settings,
        fsEncrypt,
        fsLocal,
        profiler
      );

      // Remove ghost remotes: old-path entries left by delta merge after
      // a move. Always runs — ghosts can persist across syncs.
      removeGhostRemotes(mixedEntityMappings);

      mixedEntityMappings = await getSyncPlanInplace(
        mixedEntityMappings,
        settings.skipSizeLargerThan ?? -1,
        settings.conflictAction ?? "keep_newer",
        settings.syncDirection ?? "bidirectional",
        profiler,
        settings,
        triggerSource,
        configDir
      );
      console.debug(`mixedEntityMappings:`);
      console.debug(mixedEntityMappings); // for debugging
      profiler?.insert("finish building full sync plan");

      await insertSyncPlanRecordByVault(
        db,
        mixedEntityMappings,
        vaultRandomID,
        settings.serviceType
      );
      profiler?.insert("finish writing sync plan");
      profiler?.insert(`finish step${step} (make plan)`);

      // The operations above are almost read only and kind of safe.
      // The operations below begins to write or delete (!!!) something.

      step = 7;
      if (triggerSource !== "dry") {
        await notifyFunc?.(triggerSource, step);
        await ribboonFunc?.(triggerSource, step);
        await statusBarFunc?.(triggerSource, step, everythingOk);
        await doActualSync(
          mixedEntityMappings,
          fsLocal,
          fsEncrypt,
          vaultRandomID,
          profileID,
          settings.concurrency ?? 5,
          settings.protectModifyPercentage ?? 50,
          getProtectModifyPercentageErrorStrFunc,
          db,
          profiler,
          settings.conflictAction ?? "keep_newer",
          triggerSource,
          callbackSyncProcess,
          fsRemote.lastWalkDeltaCount,
          conflictsEncountered,
          isFileDirtyOpen,
          dirtyOpenHandledPaths
        );
        profiler?.insert(`finish step${step} (actual sync)`);
      } else {
        await notifyFunc?.(triggerSource, step);
        await ribboonFunc?.(triggerSource, step);
        await statusBarFunc?.(triggerSource, step, everythingOk);
        profiler?.insert(
          `finish step${step} (skip actual sync because of dry run)`
        );
      }
    } // end skipSync else block — steps 6-7 only run when changes detected
  } catch (error: any) {
    profiler?.insert("start error branch");
    everythingOk = false;
    await errNotifyFunc?.(triggerSource, error as Error);

    profiler?.insert("finish error branch");
  } finally {
    profiler?.insert("finish syncRun");
    // console.debug(profiler?.toString());
    await profiler?.save(db, vaultRandomID, settings.serviceType);

    step = 8;
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);

    debugInfo(`ending sync.`);
    // Always clear the in-progress flag in `finally` so a throw anywhere in
    // error handling (errNotifyFunc) or the final status update can never
    // leave isSyncing stuck true. A stuck flag would make every subsequent
    // scheduled auto-sync hit the re-entrancy guard in syncRun() and return
    // silently — i.e. auto sync would look dead until the plugin reloads.
    markIsSyncingFunc(false);
  }

  return { conflictsEncountered };
}
