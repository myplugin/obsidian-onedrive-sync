import type { ListedFiles, Vault } from "obsidian";
import type { Entity } from "./baseTypes";

import { Queue } from "@fyears/tsqueue";
import { chunkArray, isSpecialFolderNameToSkip, statFix } from "./misc";

const isPluginDirItself = (x: string, pluginId: string) => {
  return (
    x === pluginId ||
    x === `${pluginId}/` ||
    x.endsWith(`/${pluginId}`) ||
    x.endsWith(`/${pluginId}/`)
  );
};

const isLikelyPluginSubFiles = (x: string) => {
  const reqFiles = [
    "main.js",
    "manifest.json",
    ".gitignore",
    "styles.css",
    "synced_settings.json",
  ];
  for (const iterator of reqFiles) {
    if (x === iterator || x.endsWith(`/${iterator}`)) {
      return true;
    }
  }
  return false;
};

// List files inside the Obsidian config folder (e.g. `.obsidian/`), using
// BFS. Five independent toggles control what gets listed:
//   syncObsidianConfig    — core config files, snippets/, themes/, icons/
//   syncAppearance        — appearance.json
//   syncBookmarks         — bookmarks.json
//   syncThirdPartyPlugins — other plugins' code and settings
//   syncSelfPlugin        — this plugin's own code files (pluginId)
//
// Device-specific files (workspace*.json, workspaces.json,
// core-plugins-migration.json) are always excluded via skipNames, and
// inside the self-plugin dir only isLikelyPluginSubFiles entries are
// listed (e.g. data.json is device-specific and never listed).
export const listFilesInObsFolder = async (
  configDir: string,
  vault: Vault,
  pluginId: string,
  syncObsidianConfig: boolean,
  syncAppearance: boolean,
  syncBookmarks: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean
): Promise<Entity[]> => {
  // All toggles off: nothing in the config dir should be synced, so don't
  // even walk it.
  if (
    !syncObsidianConfig &&
    !syncAppearance &&
    !syncBookmarks &&
    !syncThirdPartyPlugins &&
    !syncSelfPlugin
  ) {
    return [];
  }

  const q = new Queue([configDir]);
  const CHUNK_SIZE = 10;
  const contents: Entity[] = [];

  // Names always skipped within the config dir. `workspace*` and
  // `workspaces.json` / `core-plugins-migration.json` are device-specific.
  // `appearance.json` (active theme, light/dark mode, enabled CSS snippets,
  // accent color) is skipped unless `syncAppearance` is on, so each device
  // keeps its own theme selection. `bookmarks.json` is skipped unless
  // `syncBookmarks` is on.
  const skipNames = [
    "workspace",
    "workspace.json",
    "workspace-mobile.json",
    "workspaces.json",
    "core-plugins-migration.json",
  ];
  if (!syncAppearance) {
    skipNames.push("appearance.json");
  }
  if (!syncBookmarks) {
    skipNames.push("bookmarks.json");
  }

  // Decide whether a child path inside configDir should be enqueued for
  // BFS, based on the five independent toggles. Paths outside configDir
  // (should not happen here) are left to the caller's judgement.
  const prefix = `${configDir}/`;
  const shouldTraverse = (childPath: string): boolean => {
    if (!childPath.startsWith(prefix)) {
      return true;
    }
    const segments = childPath.slice(prefix.length).split("/");
    if (segments[0] === "plugins") {
      if (segments.length === 1) {
        // the plugins/ dir itself: traverse if any plugin toggle is on
        return syncThirdPartyPlugins || syncSelfPlugin;
      }
      if (segments.length === 2) {
        // plugins/<id>: route self vs third-party
        return segments[1] === pluginId
          ? syncSelfPlugin
          : syncThirdPartyPlugins;
      }
      // deeper inside a plugin dir: already gated at plugins/<id>
      return true;
    }
    if (segments.length === 1) {
      // root-level entries of the config dir
      if (segments[0] === "appearance.json") {
        return syncAppearance;
      }
      if (segments[0] === "bookmarks.json") {
        return syncBookmarks;
      }
      // core config files, snippets/, themes/, icons/, ...
      return syncObsidianConfig;
    }
    // deeper inside snippets/, themes/, icons/, ...: already gated at the
    // corresponding root-level folder
    return true;
  };

  while (q.length > 0) {
    const itemsToFetch: string[] = [];
    while (q.length > 0) {
      itemsToFetch.push(q.pop() as string);
    }

    const itemsToFetchChunks = chunkArray(itemsToFetch, CHUNK_SIZE);
    for (const singleChunk of itemsToFetchChunks) {
      const r = singleChunk.map(async (x) => {
        const statRes = await statFix(vault, x);

        if (statRes === undefined || statRes === null) {
          throw Error("something goes wrong while listing hidden folder");
        }
        const isFolder = statRes.type === "folder";
        let children: ListedFiles | undefined = undefined;
        if (isFolder) {
          children = await vault.adapter.list(x);
        }

        if (
          !isFolder &&
          (statRes.mtime === undefined ||
            statRes.mtime === null ||
            statRes.mtime === 0)
        ) {
          throw Error(
            `File in Obsidian ${configDir} has last modified time 0: ${x}, don't know how to deal with it.`
          );
        }

        return {
          itself: {
            key: isFolder ? `${x}/` : x, // local always unencrypted
            keyRaw: isFolder ? `${x}/` : x,
            mtimeCli: statRes.mtime,
            mtimeSvr: statRes.mtime,
            size: statRes.size, // local always unencrypted
            sizeRaw: statRes.size,
          },
          children: children,
        };
      });
      const r2 = (await Promise.all(r)).flat();

      for (const iter of r2) {
        contents.push(iter.itself);
        const isInsideSelfPlugin = isPluginDirItself(iter.itself.key, pluginId);
        if (iter.children !== undefined) {
          for (const iter2 of iter.children.folders) {
            if (isSpecialFolderNameToSkip(iter2, skipNames)) {
              continue;
            }
            if (!shouldTraverse(iter2)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              // special treatment for remotely-save folder
              continue;
            }
            q.push(iter2);
          }
          for (const iter2 of iter.children.files) {
            if (isSpecialFolderNameToSkip(iter2, skipNames)) {
              continue;
            }
            if (!shouldTraverse(iter2)) {
              continue;
            }
            if (isInsideSelfPlugin && !isLikelyPluginSubFiles(iter2)) {
              // special treatment for remotely-save folder
              continue;
            }
            q.push(iter2);
          }
        }
      }
    }
  }

  // console.debug(`contents in obs config: ${JSON.stringify(contents)}`);

  return contents;
};
