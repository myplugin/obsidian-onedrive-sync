// License: Apache-2.0. See LICENSE.
import { type Setting, setIcon } from "obsidian";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { toggleFieldInList } from "./syncSettings";

/**
 * Insert a cloud/cloud-off icon next to the setting's title that toggles
 * whether `fieldName` syncs across devices (membership in
 * syncedSettingFields). ON (in list) → lucide `cloud` (accent); OFF →
 * `cloud-off` (muted). Click toggles + saveSettings + re-renders.
 */
export function addSyncToggle(
  setting: Setting,
  fieldName: string,
  plugin: RemotelySavePlugin,
  t: (k: TransItemType, vars?: any) => string
): void {
  const labelFor = (on: boolean) =>
    on ? t("settings_synctoggle_on") : t("settings_synctoggle_off");

  const initiallyOn = (plugin.settings.syncedSettingFields ?? []).includes(
    fieldName
  );
  const iconEl = setting.nameEl.createEl("span", {
    cls: "rs-sync-toggle-icon",
    attr: {
      role: "button",
      tabindex: "0",
      "aria-label": labelFor(initiallyOn),
      title: labelFor(initiallyOn),
    },
  });

  const render = () => {
    const on = (plugin.settings.syncedSettingFields ?? []).includes(fieldName);
    setIcon(iconEl, on ? "cloud" : "cloud-off");
    iconEl.toggleClass("is-on", on);
    iconEl.toggleClass("is-off", !on);
    iconEl.setAttr("aria-label", labelFor(on));
    iconEl.setAttr("title", labelFor(on));
  };

  const click = async () => {
    plugin.settings.syncedSettingFields = toggleFieldInList(
      plugin.settings.syncedSettingFields ?? [],
      fieldName
    );
    await plugin.saveSettings();
    render();
  };

  render();
  iconEl.addEventListener("click", (e) => {
    e.preventDefault();
    void click();
  });
  iconEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void click();
    }
  });
}
