// License: Apache-2.0. See LICENSE.
import type { RemotelySavePluginSettings } from "./baseTypes";

/**
 * Catalog of settings fields eligible for cross-device sync via the
 * synced_settings.json sidecar. Device-specific fields
 * (enableMobileStatusBar, currLogLevel, disclaimerAcknowledged,
 * obfuscateSettingFile, enableStatusBarInfo) are intentionally NOT selectable
 * — they stay per-device. password and onedrive auth live in the device-local
 * DB and are never synced.
 */
export const SYNCABLE_FIELDS = [
  "ignorePaths",
  "onlyAllowPaths",
  "conflictAction",
  "syncConfigDir",
  "syncObsidianConfig",
  "syncThirdPartyPlugins",
  "syncSelfPlugin",
  "syncBookmarks",
  "syncAppearance",
  "syncUnderscoreItems",
  "lang",
  "concurrency",
  "skipSizeLargerThan",
  "protectModifyPercentage",
  "syncDirection",
  "deleteToWhere",
  "encryptionMethod",
  "autoRunEveryMilliseconds",
  "initRunAfterMilliseconds",
  "syncOnSaveAfterMilliseconds",
  "syncOnSaveMode",
  "deferSyncIdleMs",
] as const;

/** Default selection: every catalog field is synced unless the user opts out. */
export const DEFAULT_SYNCED_FIELDS: string[] = [...SYNCABLE_FIELDS];

const SYNCABLE_SET: Set<string> = new Set(SYNCABLE_FIELDS);

/**
 * Project the user-selected syncable fields out of the full settings into a
 * plain object for the sidecar. Only fields that are (a) in the user's
 * selection AND (b) in the SYNCABLE_FIELDS catalog are included — the safety
 * rail that keeps password/onedrive/device fields out even if mis-selected.
 */
export function projectSyncableFields(
  settings: RemotelySavePluginSettings,
  fields: string[]
): Partial<RemotelySavePluginSettings> {
  const out: Partial<RemotelySavePluginSettings> = {};
  for (const f of fields) {
    if (!SYNCABLE_SET.has(f)) continue;
    if (f in settings) {
      (out as unknown as Record<string, unknown>)[f] = (
        settings as unknown as Record<string, unknown>
      )[f];
    }
  }
  return out;
}

/**
 * Merge a downloaded sidecar partial into settings, touching ONLY the user's
 * selected syncable fields. Non-selected fields are untouched; unknown keys in
 * `partial` are ignored (forward/back compat). Mutates and returns `settings`.
 */
export function applySyncedFields(
  settings: RemotelySavePluginSettings,
  partial: Partial<RemotelySavePluginSettings>,
  fields: string[]
): RemotelySavePluginSettings {
  for (const f of fields) {
    if (!SYNCABLE_SET.has(f)) continue;
    if (f in partial) {
      (settings as unknown as Record<string, unknown>)[f] = (
        partial as unknown as Record<string, unknown>
      )[f];
    }
  }
  return settings;
}

/**
 * Strip the encryption password from a settings copy before it is written to
 * data.json. password lives in the device-local DB (like onedrive auth), so it
 * must never appear in the synced/obfuscated data.json. Mutates in place.
 */
export function stripPasswordInPlace(copy: RemotelySavePluginSettings): void {
  copy.password = "";
}

/**
 * Toggle a field's membership in a list: add if absent, remove if present.
 * Returns a NEW array; does not mutate the input. Used by the per-setting
 * sync toggle UI to add/remove a field from syncedSettingFields.
 */
export function toggleFieldInList(list: string[], field: string): string[] {
  const cur = new Set(list);
  if (cur.has(field)) {
    cur.delete(field);
  } else {
    cur.add(field);
  }
  return [...cur];
}
