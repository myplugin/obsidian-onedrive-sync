// License: Apache-2.0. See LICENSE.

/** Result of checking whether a sync item should be ignored. */
export interface SkipCheckResult {
  finalIsIgnored: boolean;
}

// Built-in blacklist: device-specific files always excluded from sync
// regardless of toggle state.
const OBSIDIAN_BLACKLIST = [
  "workspace.json",
  "workspace-mobile.json",
  "workspaces.json",
  "core-plugins-migration.json",
];

// Files always synced when syncSelfPlugin is on (everything else in the
// self-plugin dir is always skipped, e.g. data.json).
const SELF_PLUGIN_ALLOWED = [
  "main.js",
  "manifest.json",
  "styles.css",
  "synced_settings.json",
  ".gitignore",
];

// Decide whether a sync item should be ignored. Five independent toggles
// control what gets synced inside the Obsidian config folder (.obsidian/):
//   syncObsidianConfig  — core config files, snippets, themes, icons
//   syncAppearance      — appearance.json
//   syncBookmarks       — bookmarks.json
//   syncThirdPartyPlugins — other plugins' code and settings
//   syncSelfPlugin      — this plugin's own code files
//
// All toggles are independent — none controls another.
//
// Backslashes in the key are normalized to "/" for Windows/Unix parity.
// Double-backslashes in regex patterns are normalized to "/" but
// single-backslash escapes like \.png$ are left untouched.
export function checkIsSkipItemOrNotByName(
  key: string,
  isHidden: boolean,
  isFolder: boolean,
  isSymlink: boolean,
  obsidianFolder: string,
  ignorePaths: string[],
  onlyAllowPaths: string[],
  syncObsidianConfig: boolean,
  syncAppearance: boolean,
  syncBookmarks: boolean,
  syncThirdPartyPlugins: boolean,
  syncSelfPlugin: boolean,
  selfPluginId: string
): SkipCheckResult {
  const normalizedKey = key.replace(/\\/g, "/");

  const normalizePattern = (p: string): string => p.replace(/\\\\/g, "/");

  const matchesList = (list: string[]): boolean => {
    for (const raw of list) {
      if (raw.trim() === "") {
        continue;
      }
      const pattern = normalizePattern(raw);
      if (new RegExp(pattern).test(normalizedKey)) {
        return true;
      }
    }
    return false;
  };

  const isDenied = matchesList(ignorePaths);

  const allowHasEntries = onlyAllowPaths.some((s) => s.trim() !== "");
  const isAllowed = !allowHasEntries || matchesList(onlyAllowPaths);

  const otherSkip = isHidden || isFolder || isSymlink;

  // Check if key is inside the obsidian config folder
  const inObsidianFolder =
    obsidianFolder !== "" &&
    (normalizedKey === obsidianFolder ||
      normalizedKey.startsWith(`${obsidianFolder}/`));

  // Check if key is the config folder root itself (".obsidian" or
  // ".obsidian/"). The root must stay walkable when any toggle is on so
  // children can be enumerated and routed; skip it only when all are off.
  const isConfigRoot =
    obsidianFolder !== "" &&
    (normalizedKey === obsidianFolder ||
      normalizedKey === `${obsidianFolder}/`);

  // Determine if key is inside the self-plugin directory
  const selfPluginPrefix = `${obsidianFolder}/plugins/${selfPluginId}/`;
  const inSelfPlugin =
    normalizedKey.startsWith(selfPluginPrefix) ||
    normalizedKey === `${obsidianFolder}/plugins/${selfPluginId}`;

  // Check if key is inside other plugins (plugins/ but not self)
  const pluginsPrefix = `${obsidianFolder}/plugins/`;
  const inPlugins = normalizedKey.startsWith(pluginsPrefix);
  const inOtherPlugins = inPlugins && !inSelfPlugin;

  // Extract the basename (last path segment)
  const basename = normalizedKey.split("/").pop() ?? "";

  // Determine finalIsIgnored based on toggle routing
  let finalIsIgnored: boolean;

  if (!inObsidianFolder) {
    // Outside .obsidian/: standard logic
    finalIsIgnored = isDenied || !isAllowed || otherSkip;
  } else {
    // Inside .obsidian/
    if (isConfigRoot) {
      // The config folder root itself must stay walkable when any toggle
      // is on, so children can be enumerated and routed. Skip it only
      // when all five toggles are off.
      finalIsIgnored = !(
        syncObsidianConfig ||
        syncAppearance ||
        syncBookmarks ||
        syncThirdPartyPlugins ||
        syncSelfPlugin
      );
    } else if (OBSIDIAN_BLACKLIST.includes(basename)) {
      // Check blacklist first (always excluded)
      finalIsIgnored = true;
    } else if (basename === "appearance.json") {
      finalIsIgnored = !syncAppearance;
    } else if (basename === "bookmarks.json") {
      finalIsIgnored = !syncBookmarks;
    } else if (inSelfPlugin) {
      // Self plugin directory: only sync allowed files
      if (SELF_PLUGIN_ALLOWED.includes(basename)) {
        finalIsIgnored = !syncSelfPlugin;
      } else {
        finalIsIgnored = true; // e.g. data.json
      }
    } else if (inOtherPlugins) {
      finalIsIgnored = !syncThirdPartyPlugins;
    } else {
      // Root config files, snippets/, themes/, icons/
      finalIsIgnored = !syncObsidianConfig;
    }

    // Apply deny/allow lists on top (deny always wins)
    if (isDenied) {
      finalIsIgnored = true;
    }
    // Allow list: if allow mode is on and not allowed, skip
    if (allowHasEntries && !isAllowed) {
      finalIsIgnored = true;
    }
  }

  return { finalIsIgnored };
}
