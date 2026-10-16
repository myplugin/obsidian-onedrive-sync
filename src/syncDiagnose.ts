// License: Apache-2.0. See LICENSE.

import XRegExp from "xregexp";
import {
  type RemotelySavePluginSettings,
  isDebugFolderPath,
} from "./baseTypes";
import { CONFLICT_LOG_FILENAME } from "./conflictLog";
import {
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2,
} from "./metadataOnRemote";
import { isHiddenPath, isSpecialFolderNameToSkip } from "./misc";

/**
 * Why a sync item is skipped. `code` is a stable machine-readable key the UI
 * maps to localized text; `detail` carries extra context (e.g. the matched
 * ignore-pattern source string) the UI may append.
 */
export interface SyncSkipReason {
  code: string;
  detail?: string;
}

export interface SyncDiagnosis {
  /** true = the path would be ignored (not enter the sync plan). */
  skipped: boolean;
  /** present only when skipped; the FIRST rule that decided it. */
  reason?: SyncSkipReason;
}

/**
 * Local copy of the built-in blacklist + self-plugin allowlist. These are
 * duplicated (not imported) from `src/sync.ts` because that file is PolyForm
 * Strict and the values are simple constants. If sync.ts changes them, update
 * here too — see the mirror note on `diagnoseSyncSkip`.
 */
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

/**
 * Test a regex entry against a normalized key, exactly the way the real sync
 * filter does: XRegExp with the "A" (ASCII) flag, `\\` pairs normalized to
 * `/`, empty entries skipped, invalid entries skipped silently.
 */
const regexHits = (raw: string, normalizedKey: string): boolean => {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  try {
    const pattern = raw.replace(/\\\\/g, "/");
    return XRegExp(pattern, "A").test(normalizedKey);
  } catch {
    return false;
  }
};

const listHasEntries = (list: string[] | undefined): boolean =>
  Array.isArray(list) &&
  list.some((s) => typeof s === "string" && s.trim() !== "");

const firstHit = (
  list: string[] | undefined,
  normalizedKey: string
): string | undefined => {
  if (!Array.isArray(list)) return undefined;
  for (const r of list) {
    if (regexHits(r, normalizedKey)) return r; // original source string, for UI
  }
  return undefined;
};

/**
 * Mirrors `checkIsSkipItemOrNotByName` in `src/sync.ts` (the version the real
 * sync path uses — NOT the parallel `src/skipFilter.ts` variant, whose logic
 * differs). Returns the FIRST rule that would mark the item ignored, so the
 * result matches the real sync decision and the user gets the dominant
 * reason. If you change the判定顺序 here, re-audit sync.ts:145 and vice
 * versa.
 *
 * The key must already be in sync-system form: vault-relative, no leading
 * `/`, folders ending with `/` (the caller normalizes via stat when the path
 * exists on disk).
 *
 * Walk is top-down: if any ancestor folder is skipped, the whole subtree is
 * never enumerated, so a descendant path won't be synced regardless of its
 * own check. This checks ancestors shallow→deep first; the first skipped
 * ancestor is the dominant reason (matches how fsLocal.walk prunes at the
 * folder). Otherwise the per-key判定 runs below.
 */
export function diagnoseSyncSkip(
  key: string,
  settings: RemotelySavePluginSettings,
  configDir: string,
  selfPluginId: string
): SyncDiagnosis {
  const normalizedKey = key.replace(/\\/g, "/");
  const segments = normalizedKey.split("/").filter((s) => s !== "");
  let acc = "";
  for (let i = 0; i < segments.length - 1; i++) {
    acc += `${segments[i]}/`;
    const ancestorDiag = diagnoseSelf(acc, settings, configDir, selfPluginId);
    if (ancestorDiag.skipped) {
      return {
        skipped: true,
        reason: { code: "ANCESTOR_SKIPPED", detail: acc },
      };
    }
  }
  return diagnoseSelf(normalizedKey, settings, configDir, selfPluginId);
}

/** Per-key判定 (no ancestor pruning). See diagnoseSyncSkip above. */
function diagnoseSelf(
  key: string,
  settings: RemotelySavePluginSettings,
  configDir: string,
  selfPluginId: string
): SyncDiagnosis {
  const normalizedKey = key.replace(/\\/g, "/");

  // Debug export folder: excluded at the fsLocal.walk layer (not by name
  // rules). Mirror it here so the diagnosis reports the truth. Checked first
  // so descendants also resolve via ancestor pruning.
  if (isDebugFolderPath(normalizedKey)) {
    return { skipped: true, reason: { code: "DEBUG_FOLDER" } };
  }

  // Mirror of sync.ts:120 isInsideObsFolder (not exported there).
  const inObsidianFolder =
    configDir !== "" &&
    (normalizedKey === configDir || normalizedKey.startsWith(`${configDir}/`));

  // ── 1. allow list (onlyAllowPaths) ──────────────────────────────────
  // sync.ts:167-190. If allow mode is on and the key isn't explicitly
  // allowed, it's skipped — this is checked FIRST and wins as the dominant
  // reason over everything below.
  const allowHasEntries = listHasEntries(settings.onlyAllowPaths);
  if (allowHasEntries) {
    const hit = firstHit(settings.onlyAllowPaths, normalizedKey);
    if (hit === undefined) {
      // not on the allow list → skipped
      return {
        skipped: true,
        reason: { code: "ALLOW_NOT_MATCHED" },
      };
    }
    // explicitly allowed — allow rule does not skip; fall through to deny /
    // obsidian routing / special / hidden checks below.
  }

  // ── 2. deny list (ignorePaths) ──────────────────────────────────────
  // sync.ts:192-206. sync.ts only sets this when finalIsIgnored was still
  // undefined, i.e. the allow check above did NOT fire. Since we returned
  // early on allow-not-matched, reaching here means the allow check passed
  // (or allow mode was off).
  const denyHit = firstHit(settings.ignorePaths, normalizedKey);
  if (denyHit !== undefined) {
    return {
      skipped: true,
      reason: { code: "DENY_MATCHED", detail: denyHit },
    };
  }

  // ── 3. .obsidian config-folder routing ──────────────────────────────
  // sync.ts:223-273. Only runs when not already decided.
  if (inObsidianFolder) {
    const basename = normalizedKey.split("/").pop() ?? "";
    const selfPluginPrefix = `${configDir}/plugins/${selfPluginId}/`;
    const inSelfPlugin =
      normalizedKey.startsWith(selfPluginPrefix) ||
      normalizedKey === `${configDir}/plugins/${selfPluginId}`;
    const pluginsPrefix = `${configDir}/plugins/`;
    const inOtherPlugins =
      normalizedKey.startsWith(pluginsPrefix) && !inSelfPlugin;
    const isConfigRoot =
      normalizedKey === `${configDir}/` || normalizedKey === configDir;

    if (isConfigRoot) {
      // sync.ts:237-244 — skipped only when ALL five toggles are off.
      const anyOn =
        (settings.syncObsidianConfig ?? true) ||
        (settings.syncAppearance ?? false) ||
        (settings.syncBookmarks ?? false) ||
        (settings.syncThirdPartyPlugins ?? true) ||
        (settings.syncSelfPlugin ?? true);
      if (!anyOn) {
        return {
          skipped: true,
          reason: { code: "OBS_CONFIG_ROOT_ALL_OFF" },
        };
      }
    } else if (OBSIDIAN_BLACKLIST.includes(basename)) {
      return { skipped: true, reason: { code: "OBS_BLACKLIST" } };
    } else if (basename === "appearance.json") {
      if (!(settings.syncAppearance ?? false)) {
        return { skipped: true, reason: { code: "APPEARANCE_OFF" } };
      }
    } else if (basename === "bookmarks.json") {
      if (!(settings.syncBookmarks ?? false)) {
        return { skipped: true, reason: { code: "BOOKMARKS_OFF" } };
      }
    } else if (inSelfPlugin) {
      // sync.ts:251-259. Folder → syncSelfPlugin toggle; file → allowlist.
      if (normalizedKey.endsWith("/")) {
        if (!(settings.syncSelfPlugin ?? true)) {
          return { skipped: true, reason: { code: "SELF_PLUGIN_OFF" } };
        }
      } else if (SELF_PLUGIN_ALLOWED.includes(basename)) {
        if (!(settings.syncSelfPlugin ?? true)) {
          return { skipped: true, reason: { code: "SELF_PLUGIN_OFF" } };
        }
      } else {
        // e.g. data.json — always skipped regardless of toggle
        return {
          skipped: true,
          reason: { code: "SELF_PLUGIN_NOT_ALLOWED" },
        };
      }
    } else if (normalizedKey === `${configDir}/plugins/`) {
      // sync.ts:260-264 — the plugins/ dir itself
      if (
        !(settings.syncSelfPlugin ?? true) &&
        !(settings.syncThirdPartyPlugins ?? true)
      ) {
        return { skipped: true, reason: { code: "PLUGINS_DIR_OFF" } };
      }
    } else if (inOtherPlugins) {
      if (!(settings.syncThirdPartyPlugins ?? true)) {
        return {
          skipped: true,
          reason: { code: "THIRD_PARTY_PLUGINS_OFF" },
        };
      }
    } else {
      // root config files, snippets/, themes/, icons/
      if (!(settings.syncObsidianConfig ?? true)) {
        return { skipped: true, reason: { code: "OBS_CONFIG_OFF" } };
      }
    }
  }

  // ── 4. special folders / files ──────────────────────────────────────
  // sync.ts:275-281.
  if (isSpecialFolderNameToSkip(normalizedKey, [])) {
    return { skipped: true, reason: { code: "SPECIAL_FOLDER" } };
  }

  // ── 5. hidden / device-specific ─────────────────────────────────────
  // sync.ts:283-295. Mirror the || short-circuit order: first hit wins.
  if (
    !(settings.syncDotItems ?? false) &&
    isHiddenPath(normalizedKey, true, false)
  ) {
    return { skipped: true, reason: { code: "DOT_HIDDEN" } };
  }
  if (
    !(settings.syncUnderscoreItems ?? false) &&
    isHiddenPath(normalizedKey, false, true)
  ) {
    return { skipped: true, reason: { code: "UNDERSCORE_HIDDEN" } };
  }
  if (normalizedKey === "/") {
    return { skipped: true, reason: { code: "VAULT_ROOT" } };
  }
  if (
    normalizedKey === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
    normalizedKey === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2
  ) {
    return { skipped: true, reason: { code: "METADATA_FILE" } };
  }
  if (normalizedKey === CONFLICT_LOG_FILENAME) {
    return { skipped: true, reason: { code: "CONFLICT_LOG" } };
  }

  // No rule fired → the path would enter the sync plan (not skipped).
  return { skipped: false };
}
