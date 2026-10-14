import {
  AlertTriangle,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  createElement,
} from "lucide";
import {
  type App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  moment,
  sanitizeHTMLToDom,
} from "obsidian";
import type { TextComponent } from "obsidian";
import type {
  CipherMethodType,
  ConflictActionType,
  SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR,
  SyncDirectionType,
  SyncOnSaveMode,
} from "./baseTypes";

import { messyConfigToNormal } from "./configPersist";
import {
  exportVaultProfilerResultsToFiles,
  exportVaultSyncPlansToFiles,
} from "./debugMode";
import { getClient } from "./fsGetter";
import {
  DEFAULT_ONEDRIVE_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierOnedrive,
} from "./fsOnedrive";
import type { TransItemType } from "./i18n";
import { parseUriByHand } from "./importExport";
import {
  clearAllPrevSyncRecordByVault,
  clearAllSyncPlanRecords,
  destroyDBs,
  getLastFailedCheckTimeByVault,
  getLastFailedSyncTimeByVault,
  getLastSuccessCheckTimeByVault,
  getLastSuccessSyncTimeByVault,
  upsertLastFailedCheckTimeByVault,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessCheckTimeByVault,
  upsertLastSuccessSyncTimeByVault,
} from "./localdb";
import { debugInfo, setDebugEnabled } from "./logger";
import type RemotelySavePlugin from "./main"; // unavoidable
import {
  changeMobileStatusBar,
  checkHasSpecialCharForDir,
  testPathAgainstRegexList,
} from "./misc";
import { DEFAULT_PROFILER_CONFIG } from "./profiler";
import { renderRegexListSetting } from "./regexListSetting";
import { generateClearDupFilesSettingsPart } from "./settingsClearDupFiles";
import { diagnoseSyncSkip } from "./syncDiagnose";
import { addSyncToggle } from "./syncToggle";

class PasswordModal extends Modal {
  plugin: RemotelySavePlugin;
  newPassword: string;
  encryptionMethodSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newPassword: string,
    encryptionMethodSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.newPassword = newPassword;
    this.encryptionMethodSetting = encryptionMethodSetting;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_password_title") });
    t("modal_password_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    [
      t("modal_password_attn1"),
      t("modal_password_attn2"),
      t("modal_password_attn3"),
      t("modal_password_attn4"),
      t("modal_password_attn5"),
    ].forEach((val, idx) => {
      if (idx < 3) {
        contentEl.createEl("p", {
          text: val,
          cls: "password-disclaimer",
        });
      } else {
        contentEl.createEl("p", {
          text: val,
        });
      }
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("modal_password_secondconfirm"));
        button.onClick(async () => {
          this.plugin.settings.password = this.newPassword;
          if (this.newPassword !== "") {
            this.encryptionMethodSetting.settingEl.removeClass(
              "settings-encryption-method-hide"
            );
          } else {
            this.encryptionMethodSetting.settingEl.addClass(
              "settings-encryption-method-hide"
            );
          }

          await this.plugin.saveSettings();
          new Notice(t("modal_password_notice"));
          this.close();
        });
        button.setClass("password-second-confirm");
      })
      .addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class EncryptionMethodModal extends Modal {
  plugin: RemotelySavePlugin;
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_encryptionmethod_title") });
    t("modal_encryptionmethod_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: sanitizeHTMLToDom(val),
        });
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(t("confirm"));
      button.onClick(async () => {
        this.close();
      });
      button.setClass("encryptionmethod-second-confirm");
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class ChangeRemoteBaseDirModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly newRemoteBaseDir: string;
  readonly service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newRemoteBaseDir: string,
    service: SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR
  ) {
    super(app);
    this.plugin = plugin;
    this.newRemoteBaseDir = newRemoteBaseDir;
    this.service = service;
  }

  onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("h2", { text: t("modal_remotebasedir_title") });
    t("modal_remotebasedir_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    if (
      this.newRemoteBaseDir === "" ||
      this.newRemoteBaseDir === this.app.vault.getName()
    ) {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(
            t("modal_remotebasedir_secondconfirm_vaultname")
          );
          button.onClick(async () => {
            // in the settings, the value is reset to the special case ""
            this.plugin.settings[this.service as "onedrive"].remoteBaseDir = "";
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    } else if (checkHasSpecialCharForDir(this.newRemoteBaseDir)) {
      contentEl.createEl("p", {
        text: t("modal_remotebasedir_invaliddirhint"),
      });
      new Setting(contentEl).addButton((button) => {
        button.setButtonText(t("goback"));
        button.onClick(() => {
          this.close();
        });
      });
    } else {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t("modal_remotebasedir_secondconfirm_change"));
          button.onClick(async () => {
            this.plugin.settings[this.service as "onedrive"].remoteBaseDir =
              this.newRemoteBaseDir;
            await this.plugin.saveSettings();
            new Notice(t("modal_remotebasedir_notice"));
            this.close();
          });
          button.setClass("remotebasedir-second-confirm");
        })
        .addButton((button) => {
          button.setButtonText(t("goback"));
          button.onClick(() => {
            this.close();
          });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly revokeAuthSetting: Setting;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.revokeAuthSetting = revokeAuthSetting;
  }

  async onOpen() {
    const { contentEl } = this;

    const { authUrl, verifier } = await getAuthUrlAndVerifierOnedrive(
      this.plugin.settings.onedrive.clientID,
      this.plugin.settings.onedrive.authority
    );
    this.plugin.oauth2Info.verifier = verifier;

    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    t("modal_onedriveauth_shortdesc")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });
    if (Platform.isLinux) {
      t("modal_onedriveauth_shortdesc_linux")
        .split("\n")
        .forEach((val) => {
          contentEl.createEl("p", {
            text: sanitizeHTMLToDom(val),
          });
        });
    }
    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_onedriveauth_copybutton"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_onedriveauth_copynotice"));
        };
      }
    );

    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class OnedriveRevokeAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
  }

  async onOpen() {
    const { contentEl } = this;
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step1"),
    });
    const consentUrl = "https://microsoft.com/consent";
    contentEl.createEl("p").createEl("a", {
      href: consentUrl,
      text: consentUrl,
    });

    contentEl.createEl("p", {
      text: t("modal_onedriverevokeauth_step2"),
    });

    new Setting(contentEl)
      .setName(t("modal_onedriverevokeauth_clean"))
      .setDesc(t("modal_onedriverevokeauth_clean_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("modal_onedriverevokeauth_clean_button"));
        button.onClick(async () => {
          try {
            this.plugin.settings.onedrive = JSON.parse(
              JSON.stringify(DEFAULT_ONEDRIVE_CONFIG)
            ) as typeof DEFAULT_ONEDRIVE_CONFIG;
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "onedrive-auth-button-hide",
              this.plugin.settings.onedrive.username !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "onedrive-revoke-auth-button-hide",
              this.plugin.settings.onedrive.username === ""
            );
            new Notice(t("modal_onedriverevokeauth_clean_notice"));
            this.close();
          } catch (err) {
            console.error(err);
            new Notice(t("modal_onedriverevokeauth_clean_fail"));
          }
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class ExportSettingsQrCodeModal extends Modal {
  plugin: RemotelySavePlugin;
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    contentEl.addClass("qrcode-export-modal");

    // Top intro: frames the two independent exports below.
    const intro = contentEl.createDiv({ cls: "qrcode-intro" });
    t("modal_qr_intro")
      .split("\n")
      .forEach((line) => {
        intro.createEl("p", { text: line });
      });

    // Renders a QR image (or the "too big" fallback) plus a copy-URI button.
    // Shared by both sections; primitive params only, so no extra type import.
    const renderQrBody = (
      container: HTMLElement,
      rawUri: string,
      imgUri: string | undefined,
      buttonLabel: string
    ) => {
      if (imgUri === undefined) {
        container.createEl("p", {
          text: t("modal_qr_too_big"),
          cls: "qrcode-too-big",
        });
      } else {
        const imgWrap = container.createDiv({ cls: "qrcode-img-wrap" });
        imgWrap.createEl("img", { cls: "qrcode-img" }, (el) => {
          el.src = imgUri;
        });
      }

      const btnWrap = container.createDiv({ cls: "qrcode-button-wrap" });
      btnWrap.createEl("button", { text: buttonLabel }, (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(rawUri);
          new Notice(t("modal_qr_button_notice"));
        };
      });
    };

    // Both exports are independent — build them in parallel.
    let configResult: Awaited<ReturnType<RemotelySavePlugin["exportConfigQr"]>>;
    let credentialsResult: Awaited<
      ReturnType<RemotelySavePlugin["exportCredentialsQr"]>
    >;
    try {
      [configResult, credentialsResult] = await Promise.all([
        this.plugin.exportConfigQr(),
        this.plugin.exportCredentialsQr(),
      ]);
    } catch (err) {
      console.error("ExportSettingsQrCodeModal.onOpen failed:", err);
      contentEl.createEl("p", {
        text: t("modal_qr_error"),
        cls: "qrcode-warning",
      });
      return;
    }

    // ===== Section 1 — plugin preferences (share-safe) =====
    const configSection = contentEl.createDiv({ cls: "qrcode-section" });
    configSection.createEl("h3", {
      text: t("modal_qr_config_title"),
      cls: "qrcode-section-title",
    });
    configSection.createEl("p", {
      text: t("modal_qr_config_desc"),
      cls: "qrcode-section-desc",
    });
    renderQrBody(
      configSection,
      configResult.rawUri,
      configResult.imgUri,
      t("modal_qr_button")
    );

    // ===== Section 2 — OneDrive login credentials (sensitive) =====
    const authSection = contentEl.createDiv({
      cls: "qrcode-section qrcode-section--sensitive",
    });
    authSection.createEl("h3", {
      text: t("modal_qr_auth_title"),
      cls: "qrcode-section-title qrcode-section-title--sensitive",
    });
    authSection.createEl("p", {
      text: t("modal_qr_auth_warning"),
      cls: "qrcode-warning",
    });

    if ("status" in credentialsResult && credentialsResult.status === "error") {
      // Not connected to OneDrive — no credentials to export.
      authSection.createEl("p", {
        text: credentialsResult.message || t("modal_qr_notconnected"),
        cls: "qrcode-section-desc",
      });
    } else if ("rawUri" in credentialsResult) {
      renderQrBody(
        authSection,
        credentialsResult.rawUri,
        credentialsResult.imgUri,
        t("modal_qr_auth_button")
      );
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export const wrapTextWithPasswordHide = (text: TextComponent) => {
  const hider = text.inputEl.insertAdjacentElement(
    "afterend",
    createSpan()
  ) as Element;
  // the init type of hider is "hidden" === eyeOff === password
  hider.appendChild(createElement(EyeOff));
  hider.addEventListener("click", (e) => {
    const isText = text.inputEl.getAttribute("type") === "text";
    hider.empty();
    hider.appendChild(createElement(isText ? EyeOff : Eye));
    text.inputEl.setAttribute("type", isText ? "password" : "text");
    text.inputEl.focus();
  });

  // the init type of text el is password
  text.inputEl.setAttribute("type", "password");
  return text;
};

export class RemotelySaveSettingTab extends PluginSettingTab {
  readonly plugin: RemotelySavePlugin;

  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Declarative settings (Obsidian ≥ 1.13 `getSettingDefinitions`). The
  // former four custom tabs (Account / Sync / Safety / Advanced) become four
  // navigable pages; the former `setHeading()` sections become groups.
  //
  // Mapping of the old imperative rows:
  //   • simple value rows (dropdowns/toggles whose onChange only persisted a
  //     value ± a side effect) → `control` definitions; values flow through
  //     the getControlValue / setControlValue overrides below.
  //   • single-button rows → `action` definitions (whole-row click).
  //   • info-only rows → empty definitions (name/desc, no control).
  //   • rows with custom interactions (multi-control rows, dynamic descs,
  //     chip lists, path testers, cross-row linkage, DOM refs held by
  //     main.ts's OAuth flow) → `render` definitions, which receive the same
  //     Setting API the old display() used — the imperative code is ported
  //     verbatim into the render callbacks.
  //
  // Groups carry "rs-panel rs-panel-active" so the panel-scoped rules in
  // styles.css (.rs-panel .setting-item …) keep applying to the rendered
  // rows exactly like they did inside the old tab panels.
  // ─────────────────────────────────────────────────────────────────────
  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // Long unbreakable strings (regexes, paths) must not overflow the
    // settings pane — same container class the imperative display() added.
    this.containerEl.addClass("rs-overflow-wrap");

    const panelCls = "rs-panel rs-panel-active";

    return [
      {
        type: "group",
        heading: "OneDrive sync",
        cls: panelCls,
        items: [
          {
            type: "page",
            name: t("settings_section_account"),
            items: this.buildAccountPage(),
          },
          {
            type: "page",
            name: t("settings_section_sync"),
            items: this.buildSyncPage(),
          },
          {
            type: "page",
            name: t("settings_section_safety"),
            items: this.buildSafetyPage(),
          },
          {
            type: "page",
            name: t("settings_section_advanced"),
            items: this.buildAdvancedPage(),
          },
        ],
      },
    ];
  }

  /**
   * Reads values for declarative `control` definitions. Keys are either
   * top-level settings fields, dotted paths into nested config objects
   * ("onedrive.emptyFile", "profiler.enable"), or string projections of
   * non-string fields (numbers are stringified for dropdowns; booleans map
   * to "enable"/"disable") — the inverse of setControlValue below.
   */
  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case "onedrive.emptyFile":
        return s.onedrive.emptyFile;
      case "syncDirection":
        return s.syncDirection ?? "bidirectional";
      case "concurrency":
        return `${s.concurrency ?? 5}`;
      case "deleteToWhere":
        return s.deleteToWhere ?? "system";
      case "skipSizeLargerThan":
        return `${s.skipSizeLargerThan ?? -1}`;
      case "currLogLevel":
        return s.currLogLevel ?? "info";
      case "enableStatusBarInfo":
        return s.enableStatusBarInfo ?? false;
      case "enableMobileStatusBar":
        return s.enableMobileStatusBar ? "enable" : "disable";
      case "syncObsidianConfig":
        return s.syncObsidianConfig ? "enable" : "disable";
      case "syncAppearance":
        return s.syncAppearance ? "enable" : "disable";
      case "syncBookmarks":
        return s.syncBookmarks ? "enable" : "disable";
      case "syncThirdPartyPlugins":
        return s.syncThirdPartyPlugins ? "enable" : "disable";
      case "syncSelfPlugin":
        return s.syncSelfPlugin ? "enable" : "disable";
      case "syncUnderscoreItems":
        return s.syncUnderscoreItems ? "enable" : "disable";
      case "syncDotItems":
        return s.syncDotItems ? "enable" : "disable";
      case "trackRenames":
        return s.trackRenames ? "enable" : "disable";
      case "obfuscateSettingFile":
        return s.obfuscateSettingFile ? "enable" : "disable";
      case "profiler.enable":
        return s.profiler?.enable ? "enable" : "disable";
      case "profiler.enablePrinting":
        return s.profiler?.enablePrinting ? "enable" : "disable";
      case "profiler.recordSize":
        return s.profiler?.recordSize ? "enable" : "disable";
      default:
        return (s as unknown as Record<string, unknown>)[key];
    }
  }

  /**
   * Persists values from declarative `control` definitions (inverse of
   * getControlValue), replaying the side effects the old imperative onChange
   * handlers had. All writes go through plugin.saveSettings(), which also
   * maintains the auth DB record, the obfuscated data.json, and the
   * synced-settings sidecar.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };
    const s = this.plugin.settings;
    switch (key) {
      case "onedrive.emptyFile":
        s.onedrive.emptyFile = value as "skip" | "error";
        break;
      case "syncDirection":
        s.syncDirection = value as SyncDirectionType;
        break;
      case "concurrency":
        s.concurrency = Number.parseInt(String(value));
        break;
      case "deleteToWhere":
        s.deleteToWhere = value as "system" | "obsidian";
        break;
      case "skipSizeLargerThan":
        s.skipSizeLargerThan = Number.parseInt(String(value));
        break;
      case "currLogLevel": {
        const level = String(value);
        s.currLogLevel = level;
        await this.plugin.saveSettings();
        // Keep the debug-gated logger in sync with the new level (set
        // first so switching TO debug logs its own confirmation).
        setDebugEnabled(level === "debug");
        debugInfo(`the log level is changed to ${level}`);
        return;
      }
      case "enableStatusBarInfo": {
        s.enableStatusBarInfo = value as boolean;
        await this.plugin.saveSettings();
        new Notice(t("settings_enablestatusbar_reloadrequired_notice"));
        return;
      }
      case "enableMobileStatusBar": {
        if (value === "enable") {
          s.enableMobileStatusBar = true;
          this.plugin.appContainerObserver = changeMobileStatusBar("enable");
        } else {
          s.enableMobileStatusBar = false;
          changeMobileStatusBar("disable", this.plugin.appContainerObserver);
          this.plugin.appContainerObserver?.disconnect();
          this.plugin.appContainerObserver = undefined;
        }
        break;
      }
      case "syncObsidianConfig":
        s.syncObsidianConfig = value === "enable";
        break;
      case "syncAppearance":
        s.syncAppearance = value === "enable";
        break;
      case "syncBookmarks":
        s.syncBookmarks = value === "enable";
        break;
      case "syncThirdPartyPlugins":
        s.syncThirdPartyPlugins = value === "enable";
        break;
      case "syncSelfPlugin":
        s.syncSelfPlugin = value === "enable";
        break;
      case "syncUnderscoreItems":
        s.syncUnderscoreItems = value === "enable";
        break;
      case "syncDotItems":
        s.syncDotItems = value === "enable";
        break;
      case "trackRenames":
        s.trackRenames = value === "enable";
        break;
      case "obfuscateSettingFile":
        s.obfuscateSettingFile = value === "enable";
        break;
      case "profiler.enable":
        if (s.profiler === undefined) {
          s.profiler = DEFAULT_PROFILER_CONFIG;
        }
        s.profiler.enable = value === "enable";
        break;
      case "profiler.enablePrinting":
        if (s.profiler === undefined) {
          s.profiler = DEFAULT_PROFILER_CONFIG;
        }
        s.profiler.enablePrinting = value === "enable";
        break;
      case "profiler.recordSize":
        if (s.profiler === undefined) {
          s.profiler = DEFAULT_PROFILER_CONFIG;
        }
        s.profiler.recordSize = value === "enable";
        break;
      default:
        (s as unknown as Record<string, unknown>)[key] = value;
        break;
    }
    await this.plugin.saveSettings();
  }

  // ① Account & connection — the former "Account" tab.
  private buildAccountPage(): SettingDefinitionItem[] {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    return [
      {
        type: "group",
        cls: "rs-panel rs-panel-active",
        items: [
          {
            // Collapsible disclaimer callout (custom DOM). The definition's
            // name/desc only feed the settings search index — the render
            // callback replaces the row content with the callout itself.
            name: t("settings_disclaimer_title"),
            desc: t("settings_disclaimer_summary"),
            render: (setting) => {
              setting.settingEl.empty();
              const host = setting.settingEl.createDiv({
                cls: "rs-regex-test-block",
              });
              this.renderDisclaimer(host);
            },
          },
          {
            // OneDrive auth / revoke-auth button pair, mutually hidden via
            // CSS classes. main.ts's OAuth protocol handler keeps live
            // references to these divs and to the revoke Setting, so the
            // block must stay imperative.
            name: t("settings_onedrive_auth"),
            desc: t("settings_onedrive_auth_desc"),
            render: (setting) => {
              setting.settingEl.empty();
              const host = setting.settingEl.createDiv({
                cls: "rs-regex-test-block",
              });
              this.renderOnedriveAuth(host);
            },
          },
          {
            // Remote folder name: text + confirm button (the value is only
            // applied through the second-confirm modal, never on keystroke).
            name: t("settings_remotebasedir"),
            desc: t("settings_remotebasedir_desc"),
            render: (setting) => {
              let newOnedriveRemoteBaseDir =
                this.plugin.settings.onedrive.remoteBaseDir || "";
              setting
                .addText((text) =>
                  text
                    .setPlaceholder(this.app.vault.getName())
                    .setValue(newOnedriveRemoteBaseDir)
                    .onChange((value) => {
                      newOnedriveRemoteBaseDir = value.trim();
                    })
                )
                .addButton((button) => {
                  button.setButtonText(t("confirm"));
                  button.onClick(() => {
                    new ChangeRemoteBaseDirModal(
                      this.app,
                      this.plugin,
                      newOnedriveRemoteBaseDir,
                      "onedrive"
                    ).open();
                  });
                });
            },
          },
          {
            name: t("settings_onedrive_emptyfile"),
            desc: t("settings_onedrive_emptyfile_desc"),
            control: {
              type: "dropdown",
              key: "onedrive.emptyFile",
              defaultValue: "skip",
              options: {
                skip: t("settings_onedrive_emptyfile_skip"),
                error: t("settings_onedrive_emptyfile_error"),
              },
            },
          },
          {
            // Check connectivity: the desc doubles as a live "last
            // connection" status line refreshed asynchronously — needs the
            // Setting reference, hence a render row.
            name: t("settings_checkonnectivity"),
            desc: t("settings_checkonnectivity_desc"),
            render: (setting) => {
              this.renderCheckConnectivity(setting);
            },
          },
        ],
      },
    ];
  }

  // Collapsible disclaimer callout (ported verbatim from the old imperative
  // account section). First manual collapse sticks disclaimerAcknowledged.
  private renderDisclaimer(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    const initiallyOpen = this.plugin.settings.disclaimerAcknowledged !== true;
    const disclaimerDiv = containerEl.createDiv({
      cls: initiallyOpen ? "rs-disclaimer rs-disclaimer-open" : "rs-disclaimer",
    });

    const header = disclaimerDiv.createDiv({ cls: "rs-disclaimer-header" });
    const chevron = header.createSpan({ cls: "rs-disclaimer-chevron" });
    chevron.appendChild(createElement(ChevronRight));
    header.createSpan({
      cls: "rs-disclaimer-title",
      text: t("settings_disclaimer_title"),
    });
    header.createSpan({
      cls: "rs-disclaimer-summary",
      text: t("settings_disclaimer_summary"),
    });

    const body = disclaimerDiv.createDiv({ cls: "rs-disclaimer-body" });

    for (const c of [
      t("settings_onedrive_disclaimer1"),
      t("settings_onedrive_disclaimer2"),
    ]) {
      const p = body.createEl("p", { cls: "rs-disclaimer-warn" });
      p.createSpan({ cls: "rs-disclaimer-icon" }).appendChild(
        createElement(AlertTriangle)
      );
      p.createSpan({ text: c });
    }

    const folderP = body.createEl("p", { cls: "rs-disclaimer-info" });
    folderP
      .createSpan({ cls: "rs-disclaimer-icon" })
      .appendChild(createElement(Info));
    folderP.createSpan({
      text: t("settings_onedrive_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.onedrive.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    const nobizP = body.createEl("p", { cls: "rs-disclaimer-info" });
    nobizP
      .createSpan({ cls: "rs-disclaimer-icon" })
      .appendChild(createElement(Info));
    nobizP.createSpan({ text: t("settings_onedrive_nobiz") });

    header.addEventListener("click", () => {
      const isOpen = disclaimerDiv.hasClass("rs-disclaimer-open");
      disclaimerDiv.toggleClass("rs-disclaimer-open", !isOpen);
      if (isOpen && this.plugin.settings.disclaimerAcknowledged !== true) {
        // 首次折叠 → 粘性置位,只写一次库
        this.plugin.settings.disclaimerAcknowledged = true;
        void this.plugin.saveSettings();
      }
    });
  }

  // OneDrive auth / revoke-auth block (ported verbatim). The divs and the
  // revoke Setting are registered into plugin.oauth2Info when the user
  // starts the auth flow — main.ts's protocol-handler callback mutates them
  // (class toggles + setDesc) after a successful sign-in.
  private renderOnedriveAuth(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    const onedriveSelectAuthDiv = containerEl.createDiv();
    const onedriveAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-auth-button-hide settings-auth-related",
    });
    const onedriveRevokeAuthDiv = onedriveSelectAuthDiv.createDiv({
      cls: "onedrive-revoke-auth-button-hide settings-auth-related",
    });

    const onedriveRevokeAuthSetting = new Setting(onedriveRevokeAuthDiv)
      .setName(t("settings_onedrive_revoke"))
      .setDesc(
        t("settings_onedrive_revoke_desc", {
          username: this.plugin.settings.onedrive.username,
        })
      )
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_revoke_button"));
        button.onClick(async () => {
          new OnedriveRevokeAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv
          ).open();
        });
      });

    new Setting(onedriveAuthDiv)
      .setName(t("settings_onedrive_auth"))
      .setDesc(t("settings_onedrive_auth_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_onedrive_auth_button"));
        button.onClick(async () => {
          const modal = new OnedriveAuthModal(
            this.app,
            this.plugin,
            onedriveAuthDiv,
            onedriveRevokeAuthDiv,
            onedriveRevokeAuthSetting
          );
          this.plugin.oauth2Info.helperModal = modal;
          this.plugin.oauth2Info.authDiv = onedriveAuthDiv;
          this.plugin.oauth2Info.revokeDiv = onedriveRevokeAuthDiv;
          this.plugin.oauth2Info.revokeAuthSetting = onedriveRevokeAuthSetting;
          modal.open();
        });
      });

    onedriveAuthDiv.toggleClass(
      "onedrive-auth-button-hide",
      this.plugin.settings.onedrive.username !== ""
    );
    onedriveRevokeAuthDiv.toggleClass(
      "onedrive-revoke-auth-button-hide",
      this.plugin.settings.onedrive.username === ""
    );
  }

  // "Check connectivity" row (ported verbatim): the button runs a live
  // connection check and the desc doubles as the last-connection status.
  private renderCheckConnectivity(checkSetting: Setting): void {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // Refresh the "last connection" status in this setting's desc. The last
    // connection = the single most recent of (sync success, sync fail, check
    // success, check fail); show its outcome + relative time, or "never" if
    // there has been no sync/check yet. Mobile sync only flashes a brief
    // popup, so surfacing the last result here lets the user confirm whether
    // the last connection actually succeeded.
    const refreshConnStatus = async () => {
      if (this.plugin.isSyncing) {
        checkSetting.setDesc(t("settings_connection_syncing"));
        return;
      }
      const db = this.plugin.db;
      const vault = this.plugin.vaultRandomID;
      const syncSuccess = await getLastSuccessSyncTimeByVault(db, vault);
      const syncFail = await getLastFailedSyncTimeByVault(db, vault);
      const checkSuccess = await getLastSuccessCheckTimeByVault(db, vault);
      const checkFail = await getLastFailedCheckTimeByVault(db, vault);
      let latestTime: number | null = null;
      let latestOutcome: "success" | "fail" | null = null;
      const consider = (
        t: number | null | undefined,
        outcome: "success" | "fail"
      ) => {
        if (
          t !== null &&
          t !== undefined &&
          (latestTime === null || t > latestTime)
        ) {
          latestTime = t;
          latestOutcome = outcome;
        }
      };
      consider(syncSuccess, "success");
      consider(syncFail, "fail");
      consider(checkSuccess, "success");
      consider(checkFail, "fail");
      let desc: string;
      if (latestTime === null || latestOutcome === null) {
        desc = t("settings_connection_never");
      } else {
        const time = (
          moment as unknown as (inp?: number) => { fromNow(): string }
        )(latestTime).fromNow();
        const outcome =
          latestOutcome === "success"
            ? t("settings_connection_success")
            : t("settings_connection_failed");
        desc = t("settings_connection_last_status", { time, outcome });
      }
      checkSetting.setDesc(desc);
    };

    checkSetting.addButton((button) => {
      button.setButtonText(t("settings_checkonnectivity_button"));
      button.onClick(async () => {
        new Notice(t("settings_checkonnectivity_checking"));
        const client = getClient(
          this.plugin.settings,
          this.app.vault.getName(),
          () => this.plugin.saveSettings()
        );
        const errors = { msg: "" };
        const res = await client.checkConnect((err: unknown) => {
          errors.msg = String(err);
        });
        const now = Date.now();
        if (res) {
          await upsertLastSuccessCheckTimeByVault(
            this.plugin.db,
            this.plugin.vaultRandomID,
            now
          );
          new Notice(t("settings_onedrive_connect_succ"));
        } else {
          await upsertLastFailedCheckTimeByVault(
            this.plugin.db,
            this.plugin.vaultRandomID,
            now
          );
          new Notice(t("settings_onedrive_connect_fail"));
          new Notice(errors.msg);
        }
        await refreshConnStatus();
      });
    });

    void refreshConnStatus();
  }

  // ② Sync options — the former "Sync" tab.
  private buildSyncPage(): SettingDefinitionItem[] {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // Option order mirrors the old addOption calls: disable first here …
    const disableEnableOptions = {
      disable: t("disable"),
      enable: t("enable"),
    };

    const skipSizeOptions: Record<string, string> = {
      "-1": t("settings_skiplargefiles_notset"),
    };
    for (const mb of [1, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      skipSizeOptions[`${mb * 1000 * 1000}`] = `${mb} MB`;
    }

    // Shared state for the protectModifyPercentage dropdown + custom-number
    // field pair (the dropdown reveals/hides the custom field and mirrors
    // its value into the text input). Both rows render in definition order
    // within the same cycle; the dropdown's onChange only fires on user
    // interaction — by then the custom field's refs are populated.
    let percentage2SettingEl: HTMLElement | undefined;
    let percentage2Text: TextComponent | undefined;

    return [
      {
        type: "group",
        heading: t("settings_section_sync_direction"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            name: t("setting_syncdirection"),
            desc: sanitizeHTMLToDom(t("setting_syncdirection_desc")),
            control: {
              type: "dropdown",
              key: "syncDirection",
              defaultValue: "bidirectional",
              options: {
                bidirectional: t("setting_syncdirection_bidirectional_desc"),
                incremental_push_only: t(
                  "setting_syncdirection_incremental_push_only_desc"
                ),
                incremental_pull_only: t(
                  "setting_syncdirection_incremental_pull_only_desc"
                ),
                incremental_push_and_delete_only: t(
                  "setting_syncdirection_incremental_push_and_delete_only_desc"
                ),
                incremental_pull_and_delete_only: t(
                  "setting_syncdirection_incremental_pull_and_delete_only_desc"
                ),
              },
            },
          },
          {
            name: t("settings_concurrency"),
            desc: t("settings_concurrency_desc"),
            control: {
              type: "dropdown",
              key: "concurrency",
              defaultValue: "5",
              options: {
                "1": "1",
                "2": "2",
                "3": "3",
                "5": "5 (Default)",
                "10": "10",
                "15": "15",
                "20": "20",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_sync_automatic"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            // The four automatic-sync rows stay imperative: each pairs its
            // dropdown with the per-setting sync toggle icon (addSyncToggle
            // decorates the Setting's nameEl) and/or has change side
            // effects (interval re-arm, sync-on-save re-register, notices).
            name: t("settings_autorun"),
            desc: t("settings_autorun_desc"),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown.addOption("-1", t("settings_autorun_notset"));
                dropdown.addOption(
                  `${1000 * 60 * 1}`,
                  t("settings_autorun_1min")
                );
                dropdown.addOption(
                  `${1000 * 60 * 5}`,
                  t("settings_autorun_5min")
                );
                dropdown.addOption(
                  `${1000 * 60 * 10}`,
                  t("settings_autorun_10min")
                );
                dropdown.addOption(
                  `${1000 * 60 * 30}`,
                  t("settings_autorun_30min")
                );

                dropdown
                  .setValue(`${this.plugin.settings.autoRunEveryMilliseconds}`)
                  .onChange(async (val: string) => {
                    const realVal = Number.parseInt(val);
                    this.plugin.settings.autoRunEveryMilliseconds = realVal;
                    await this.plugin.saveSettings();
                    if (
                      (realVal === undefined ||
                        realVal === null ||
                        realVal <= 0) &&
                      this.plugin.autoRunIntervalID !== undefined
                    ) {
                      // clear
                      window.clearInterval(this.plugin.autoRunIntervalID);
                      this.plugin.autoRunIntervalID = undefined;
                    } else if (
                      realVal !== undefined &&
                      realVal !== null &&
                      realVal > 0
                    ) {
                      const intervalID = window.setInterval(() => {
                        debugInfo("auto run from settings.ts");
                        void this.plugin.syncRun("auto").catch(console.error);
                      }, realVal);
                      this.plugin.autoRunIntervalID = intervalID;
                      this.plugin.registerInterval(intervalID);
                    }
                  });
              });

              addSyncToggle(
                setting,
                "autoRunEveryMilliseconds",
                this.plugin,
                t
              );
            },
          },
          {
            name: t("settings_runoncestartup"),
            desc: t("settings_runoncestartup_desc"),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown.addOption("-1", t("settings_runoncestartup_notset"));
                dropdown.addOption(
                  `${1000 * 1 * 1}`,
                  t("settings_runoncestartup_1sec")
                );
                dropdown.addOption(
                  `${1000 * 10 * 1}`,
                  t("settings_runoncestartup_10sec")
                );
                dropdown.addOption(
                  `${1000 * 30 * 1}`,
                  t("settings_runoncestartup_30sec")
                );
                dropdown
                  .setValue(`${this.plugin.settings.initRunAfterMilliseconds}`)
                  .onChange(async (val: string) => {
                    const realVal = Number.parseInt(val);
                    this.plugin.settings.initRunAfterMilliseconds = realVal;
                    await this.plugin.saveSettings();
                  });
              });

              addSyncToggle(
                setting,
                "initRunAfterMilliseconds",
                this.plugin,
                t
              );
            },
          },
          {
            name: t("settings_synconsave"),
            desc: t("settings_synconsave_desc"),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown.addOption("off", t("settings_synconsave_disable"));
                dropdown.addOption(
                  "throttle",
                  t("settings_synconsave_mode_throttle")
                );
                dropdown.addOption(
                  "rateLimit",
                  t("settings_synconsave_mode_ratelimit")
                );
                dropdown
                  .setValue(`${this.plugin.settings.syncOnSaveMode ?? "off"}`)
                  .onChange(async (val: string) => {
                    const mode = val as SyncOnSaveMode;
                    this.plugin.settings.syncOnSaveMode = mode;
                    // Keep the legacy field consistent for mixed-version
                    // fleets (old builds still read
                    // syncOnSaveAfterMilliseconds): throttle=1000,
                    // off/rateLimit=-1 (rateLimit has no legacy
                    // representation; old peers treat it as off — the safe
                    // default).
                    this.plugin.settings.syncOnSaveAfterMilliseconds =
                      mode === "throttle" ? 1000 : -1;
                    await this.plugin.saveSettings();
                    this.plugin.toggleSyncOnSaveIfSet();
                    // rateLimit requires periodic auto-sync as the safety
                    // net for saves dropped within the 1-min window; warn
                    // immediately if the prerequisite is unmet (the handler
                    // stays inert otherwise).
                    const periodicOn =
                      this.plugin.settings.autoRunEveryMilliseconds !==
                        undefined &&
                      this.plugin.settings.autoRunEveryMilliseconds !== null &&
                      this.plugin.settings.autoRunEveryMilliseconds > 0;
                    if (mode === "rateLimit" && !periodicOn) {
                      new Notice(
                        t("settings_synconsave_ratelimit_need_periodic"),
                        10 * 1000
                      );
                    }
                  });
              });

              addSyncToggle(setting, "syncOnSaveMode", this.plugin, t);
            },
          },
          {
            name: t("settings_defer_sync"),
            desc: t("settings_defer_sync_desc"),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown.addOption("0", t("settings_defer_sync_disabled"));
                dropdown.addOption("3000", t("settings_defer_sync_3s"));
                dropdown.addOption("5000", t("settings_defer_sync_5s"));
                dropdown.addOption("10000", t("settings_defer_sync_10s"));
                dropdown.addOption("30000", t("settings_defer_sync_30s"));
                dropdown
                  .setValue(`${this.plugin.settings.deferSyncIdleMs ?? 5000}`)
                  .onChange(async (val: string) => {
                    const realVal = Number.parseInt(val);
                    this.plugin.settings.deferSyncIdleMs = realVal;
                    await this.plugin.saveSettings();
                  });
              });

              addSyncToggle(setting, "deferSyncIdleMs", this.plugin, t);
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_obsidian_sync"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            // Blacklist notice (a bare paragraph between rows before).
            name: "",
            desc: t("settings_blacklist_notice"),
            searchable: false,
          },
          {
            // syncObsidianConfig (default ON)
            name: t("settings_obsidian_config"),
            desc: t("settings_obsidian_config_desc", {
              configDir: this.app.vault.configDir,
            }),
            control: {
              type: "dropdown",
              key: "syncObsidianConfig",
              defaultValue: "enable",
              options: disableEnableOptions,
            },
          },
          {
            // syncAppearance (keep existing)
            name: t("settings_appearance"),
            desc: t("settings_appearance_desc", {
              configDir: this.app.vault.configDir,
            }),
            control: {
              type: "dropdown",
              key: "syncAppearance",
              defaultValue: "disable",
              options: disableEnableOptions,
            },
          },
          {
            // syncBookmarks (keep existing)
            name: t("settings_bookmarks"),
            desc: t("settings_bookmarks_desc", {
              configDir: this.app.vault.configDir,
            }),
            control: {
              type: "dropdown",
              key: "syncBookmarks",
              defaultValue: "disable",
              options: disableEnableOptions,
            },
          },
          {
            // syncThirdPartyPlugins (default ON)
            name: t("settings_third_party_plugins"),
            desc: t("settings_third_party_plugins_desc", {
              configDir: this.app.vault.configDir,
            }),
            control: {
              type: "dropdown",
              key: "syncThirdPartyPlugins",
              defaultValue: "enable",
              options: disableEnableOptions,
            },
          },
          {
            // syncSelfPlugin (default ON)
            name: t("settings_self_plugin"),
            desc: t("settings_self_plugin_desc", {
              configDir: this.app.vault.configDir,
              pluginId: this.plugin.manifest.id,
            }),
            control: {
              type: "dropdown",
              key: "syncSelfPlugin",
              defaultValue: "enable",
              options: disableEnableOptions,
            },
          },
          {
            name: t("settings_syncunderscore"),
            desc: t("settings_syncunderscore_desc"),
            control: {
              type: "dropdown",
              key: "syncUnderscoreItems",
              defaultValue: "disable",
              options: disableEnableOptions,
            },
          },
          {
            name: t("settings_syncdot"),
            desc: t("settings_syncdot_desc"),
            control: {
              type: "dropdown",
              key: "syncDotItems",
              defaultValue: "disable",
              options: disableEnableOptions,
            },
          },
          {
            name: t("settings_skiplargefiles"),
            desc: t("settings_skiplargefiles_desc"),
            control: {
              type: "dropdown",
              key: "skipSizeLargerThan",
              defaultValue: "-1",
              options: skipSizeOptions,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_regex"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            name: t("settings_ignorepaths"),
            desc: t("settings_ignorepaths_desc"),
            render: (setting) => {
              setting.settingEl.addClass("rs-regex-setting");
              renderRegexListSetting({
                app: this.app,
                containerEl: setting.controlEl,
                getValues: () => this.plugin.settings.ignorePaths ?? [],
                setValues: async (next) => {
                  this.plugin.settings.ignorePaths = next;
                  await this.plugin.saveSettings();
                },
                t,
                placeholder: t("settings_regex_add_placeholder"),
              });
            },
          },
          {
            name: t("settings_onlyallowpaths"),
            desc: t("settings_onlyallowpaths_desc"),
            render: (setting) => {
              setting.settingEl.addClass("rs-regex-setting");
              renderRegexListSetting({
                app: this.app,
                containerEl: setting.controlEl,
                getValues: () => this.plugin.settings.onlyAllowPaths ?? [],
                setValues: async (next) => {
                  this.plugin.settings.onlyAllowPaths = next;
                  await this.plugin.saveSettings();
                },
                t,
                placeholder: t("settings_regex_add_placeholder"),
              });
            },
          },
          {
            // Standalone path tester — tests one path against BOTH lists
            // (ignore + allow) at once, replacing the old per-list embedded
            // test row. Reuses the .rs-regex-test-* styles so it matches the
            // lists above.
            name: t("settings_regex_test_name"),
            desc: t("settings_regex_test_desc"),
            render: (setting) => {
              setting.settingEl.addClass("rs-regex-setting");
              // Wrap the test row + result in a block container so they
              // stack vertically (block flow) instead of becoming two flex
              // items of the Setting's controlEl, which would lay the result
              // out beside the button and crimp the input width. Mirrors how
              // the chip-list settings above wrap their contents in
              // .rs-regex-block.
              const regexTestBlock = setting.controlEl.createDiv({
                cls: "rs-regex-test-block",
              });
              const regexTestRow = regexTestBlock.createDiv({
                cls: "rs-regex-test-row",
              });
              const regexTestInputEl = regexTestRow.createEl("input", {
                type: "text",
                attr: {
                  placeholder: t("settings_regex_test_path_placeholder"),
                  spellcheck: "false",
                },
                cls: "rs-regex-test-input",
              });
              const regexTestButtonEl = regexTestRow.createEl("button", {
                text: t("settings_regex_test_button"),
                cls: "rs-regex-test-button",
              });
              const regexTestResultEl = regexTestBlock.createDiv({
                cls: "rs-regex-test-result",
              });

              // Render one labeled result row (Ignore / Allow). An empty
              // list yields "no match" naturally from
              // testPathAgainstRegexList, so a single empty list shows ✗ for
              // that row while the other list is still tested.
              const renderRegexTestRow = (
                label: string,
                values: string[],
                path: string
              ) => {
                const row = regexTestResultEl.createDiv({
                  cls: "rs-regex-test-result-row",
                });
                row.createSpan({
                  cls: "rs-regex-test-result-label",
                  text: label,
                });
                const { matched, matchedRegexes } = testPathAgainstRegexList(
                  values,
                  path
                );
                if (matched) {
                  const matchEl = row.createSpan({
                    cls: "rs-regex-test-result-match",
                  });
                  matchEl.createSpan({ text: "\u2713 " });
                  matchEl.appendText(
                    t("settings_regex_test_match", { regexes: "" })
                  );
                  for (const re of matchedRegexes) {
                    matchEl.createEl("code", {
                      cls: "rs-regex-matched-regex",
                      text: re,
                    });
                    matchEl.appendText(" ");
                  }
                } else {
                  row.createSpan({
                    cls: "rs-regex-test-result-nomatch",
                    text: `\u2717 ${t("settings_regex_test_nomatch")}`,
                  });
                }
              };

              const handleRegexTest = () => {
                const path = regexTestInputEl.value.trim();
                regexTestResultEl.empty();
                if (path === "") {
                  // empty input → clear results silently, no prompt text
                  return;
                }
                const ignoreValues = this.plugin.settings.ignorePaths ?? [];
                const allowValues = this.plugin.settings.onlyAllowPaths ?? [];
                if (ignoreValues.length === 0 && allowValues.length === 0) {
                  regexTestResultEl.createSpan({
                    cls: "rs-regex-test-result-nomatch",
                    text: t("settings_regex_test_empty_list"),
                  });
                  return;
                }
                renderRegexTestRow(
                  t("settings_regex_test_label_ignore"),
                  ignoreValues,
                  path
                );
                renderRegexTestRow(
                  t("settings_regex_test_label_allow"),
                  allowValues,
                  path
                );
              };

              regexTestButtonEl.addEventListener("click", (e) => {
                e.preventDefault();
                handleRegexTest();
              });
              regexTestInputEl.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRegexTest();
                }
              });
              // Clear the result area the moment the input is emptied, so
              // stale results don't linger after the user deletes the path.
              regexTestInputEl.addEventListener("input", () => {
                if (regexTestInputEl.value.trim() === "") {
                  regexTestResultEl.empty();
                }
              });
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_sync_protection"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            name: t("settings_deletetowhere"),
            desc: t("settings_deletetowhere_desc"),
            control: {
              type: "dropdown",
              key: "deleteToWhere",
              defaultValue: "system",
              options: {
                system: t("settings_deletetowhere_system_trash"),
                obsidian: t("settings_deletetowhere_obsidian_trash"),
              },
            },
          },
          {
            name: t("settings_protectmodifypercentage"),
            desc: t("settings_protectmodifypercentage_desc"),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                for (const i of Array.from({ length: 11 }, (x, i) => i * 10)) {
                  let desc = `${i}`;
                  if (i === 0) {
                    desc = t("settings_protectmodifypercentage_000_desc");
                  } else if (i === 50) {
                    desc = t("settings_protectmodifypercentage_050_desc");
                  } else if (i === 100) {
                    desc = t("settings_protectmodifypercentage_100_desc");
                  }
                  dropdown.addOption(`${i}`, desc);
                }
                dropdown.addOption(
                  "custom",
                  t("settings_protectmodifypercentage_custom_desc")
                );

                const p = this.plugin.settings.protectModifyPercentage ?? 50;
                let initVal = "custom";
                if (p % 10 === 0) {
                  initVal = `${p}`;
                } else {
                  // show custom
                  percentage2SettingEl?.removeClass(
                    "settings-percentage-custom"
                  );
                }
                dropdown.setValue(initVal).onChange(async (val) => {
                  const k = Number.parseInt(val);
                  if (val === "custom" || Number.isNaN(k)) {
                    // do nothing until user changes something in custom field
                    percentage2SettingEl?.removeClass(
                      "settings-percentage-custom-hide"
                    );
                  } else {
                    this.plugin.settings.protectModifyPercentage = k;
                    percentage2SettingEl?.addClass(
                      "settings-percentage-custom-hide"
                    );
                    percentage2Text?.setValue(`${k}`);
                    await this.plugin.saveSettings();
                  }
                });
              });
            },
          },
          {
            name: t("settings_protectmodifypercentage_customfield"),
            desc: t("settings_protectmodifypercentage_customfield_desc"),
            render: (setting) => {
              percentage2SettingEl = setting.settingEl;
              if (
                (this.plugin.settings.protectModifyPercentage ?? 50) % 10 ===
                0
              ) {
                setting.settingEl.addClass("settings-percentage-custom-hide");
              }
              setting.addText((text) => {
                text.inputEl.type = "number";
                percentage2Text = text;
                text
                  .setPlaceholder("0 ~ 100")
                  .setValue(
                    `${this.plugin.settings.protectModifyPercentage ?? 50}`
                  )
                  .onChange(async (val) => {
                    let k = Number.parseFloat(val.trim());
                    if (Number.isNaN(k)) {
                      // do nothing!
                    } else {
                      if (k < 0) {
                        k = 0;
                      } else if (k > 100) {
                        k = 100;
                      }
                      this.plugin.settings.protectModifyPercentage = k;
                      await this.plugin.saveSettings();
                    }
                  });
              });
            },
          },
        ],
      },
    ];
  }

  // ③④ Safety — the former "Safety" tab (Conflict + Encryption sections).
  private buildSafetyPage(): SettingDefinitionItem[] {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // Shared between the conflictAction row (its desc grows the
    // smart-conflict explainer when that mode is picked) — recomputed on
    // every definition build, then kept current by the dropdown's onChange.
    let conflictActionSettingOrigDesc = t("settings_conflictaction_desc");
    if (
      (this.plugin.settings.conflictAction ?? "keep_newer") === "smart_conflict"
    ) {
      conflictActionSettingOrigDesc += t(
        "settings_conflictaction_smart_conflict_desc"
      );
    }

    // Shared between the password row (its confirm button hands the Setting
    // to PasswordModal) and the encryption-method row (the modal shows/hides
    // that row when the password is set/cleared). The encryption row renders
    // right after the password row in the same cycle, so the ref is always
    // populated before the confirm button can be clicked.
    let encryptionMethodSetting: Setting | undefined;
    let newPassword = `${this.plugin.settings.password}`;

    return [
      {
        type: "group",
        heading: t("settings_section_conflict"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            name: t("settings_conflictaction"),
            desc: sanitizeHTMLToDom(conflictActionSettingOrigDesc),
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                dropdown
                  .addOption(
                    "keep_newer",
                    t("settings_conflictaction_keep_newer")
                  )
                  .addOption(
                    "keep_larger",
                    t("settings_conflictaction_keep_larger")
                  )
                  .addOption(
                    "smart_conflict",
                    t("settings_conflictaction_smart_conflict")
                  )
                  .setValue(this.plugin.settings.conflictAction ?? "keep_newer")
                  .onChange(async (val) => {
                    this.plugin.settings.conflictAction =
                      val as ConflictActionType;
                    await this.plugin.saveSettings();

                    conflictActionSettingOrigDesc = t(
                      "settings_conflictaction_desc"
                    );
                    if (
                      (this.plugin.settings.conflictAction ?? "keep_newer") ===
                      "smart_conflict"
                    ) {
                      conflictActionSettingOrigDesc += t(
                        "settings_conflictaction_smart_conflict_desc"
                      );
                    }
                    setting.setDesc(
                      sanitizeHTMLToDom(conflictActionSettingOrigDesc)
                    );
                  });
              });
            },
          },
          {
            name: t("settings_cleardupfiles"),
            desc: sanitizeHTMLToDom(t("settings_cleardupfiles_desc")),
            render: (setting) => {
              // The clear-duplicate-files row (incl. its confirm modal)
              // lives in settingsClearDupFiles.ts (PolyForm module) and
              // builds its own Setting. Render it off-DOM, then transplant
              // its info + control elements into this definition's row —
              // keeps the single source of truth without nesting rows.
              const holder = createDiv();
              generateClearDupFilesSettingsPart(
                holder,
                t,
                this.app,
                this.plugin
              );
              const generated = holder.firstElementChild;
              if (generated !== null) {
                setting.settingEl.empty();
                while (generated.firstChild !== null) {
                  setting.settingEl.appendChild(generated.firstChild);
                }
              }
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_encryption"),
        cls: "rs-panel rs-panel-active",
        items: [
          {
            name: t("settings_password"),
            desc: t("settings_password_desc"),
            render: (setting) => {
              setting
                .addText((text) => {
                  wrapTextWithPasswordHide(text);
                  text
                    .setPlaceholder("")
                    .setValue(`${this.plugin.settings.password}`)
                    .onChange(async (value) => {
                      newPassword = value.trim();
                    });
                })
                .addButton(async (button) => {
                  button.setButtonText(t("confirm"));
                  button.onClick(async () => {
                    if (encryptionMethodSetting !== undefined) {
                      new PasswordModal(
                        this.app,
                        this.plugin,
                        newPassword,
                        encryptionMethodSetting
                      ).open();
                    }
                  });
                });
            },
          },
          {
            name: t("settings_encryptionmethod"),
            desc: sanitizeHTMLToDom(t("settings_encryptionmethod_desc")),
            render: (setting) => {
              encryptionMethodSetting = setting;
              if (this.plugin.settings.password === "") {
                setting.settingEl.addClass("settings-encryption-method-hide");
              }
              setting.addDropdown((dropdown) => {
                dropdown
                  .addOption(
                    "rclone-base64",
                    t("settings_encryptionmethod_rclone")
                  )
                  .addOption(
                    "openssl-base64",
                    t("settings_encryptionmethod_openssl")
                  )
                  .setValue(
                    this.plugin.settings.encryptionMethod ?? "rclone-base64"
                  )
                  .onChange(async (val: string) => {
                    this.plugin.settings.encryptionMethod =
                      val as CipherMethodType;
                    await this.plugin.saveSettings();
                    if (this.plugin.settings.password !== "") {
                      new EncryptionMethodModal(this.app, this.plugin).open();
                    }
                  });
              });
            },
          },
        ],
      },
    ];
  }

  // ⑤ Advanced — the former "Advanced" tab.
  private buildAdvancedPage(): SettingDefinitionItem[] {
    const t = (x: TransItemType, vars?: Record<string, string>) => {
      return this.plugin.i18n.t(x, vars);
    };

    // Option order mirrors the old addOption calls: enable first here.
    const enableDisableOptions = {
      enable: t("enable"),
      disable: t("disable"),
    };

    const panelCls = "rs-panel rs-panel-active";

    return [
      {
        type: "group",
        heading: t("settings_adv_group_statusbar"),
        cls: panelCls,
        items: [
          {
            // custom status bar items are not supported on mobile
            name: t("settings_enablestatusbar_info"),
            desc: t("settings_enablestatusbar_info_desc"),
            visible: () => !Platform.isMobileApp,
            control: {
              type: "toggle",
              key: "enableStatusBarInfo",
              defaultValue: true,
            },
          },
          {
            name: t("settings_resetstatusbar_time"),
            desc: t("settings_resetstatusbar_time_desc"),
            visible: () => !Platform.isMobileApp,
            action: () => {
              void (async () => {
                // reset last sync time
                await upsertLastSuccessSyncTimeByVault(
                  this.plugin.db,
                  this.plugin.vaultRandomID,
                  -1
                );
                await upsertLastFailedSyncTimeByVault(
                  this.plugin.db,
                  this.plugin.vaultRandomID,
                  -1
                );
                this.plugin.updateLastSyncMsg(
                  undefined,
                  "not_syncing",
                  null,
                  null
                );
                new Notice(t("settings_resetstatusbar_notice"));
              })();
            },
          },
          {
            name: t("settings_enablemobilestatusbar"),
            desc: t("settings_enablemobilestatusbar_desc"),
            visible: () => Platform.isMobile,
            control: {
              type: "dropdown",
              key: "enableMobileStatusBar",
              defaultValue: "disable",
              options: enableDisableOptions,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_renametracking"),
        cls: panelCls,
        items: [
          {
            name: t("settings_trackrenames"),
            desc: t("settings_trackrenames_desc"),
            control: {
              type: "dropdown",
              key: "trackRenames",
              defaultValue: "disable",
              options: enableDisableOptions,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_importexport"),
        cls: panelCls,
        items: [
          {
            name: t("settings_export"),
            desc: t("settings_export_desc"),
            action: () => {
              new ExportSettingsQrCodeModal(this.app, this.plugin).open();
            },
          },
          {
            name: t("settings_import"),
            desc: t("settings_import_desc"),
            render: (setting) => {
              let importSettingVal = "";
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("Obsidian://OneDrive-sync?func=...&...")
                    .setValue("")
                    .onChange((val) => {
                      importSettingVal = val;
                    })
                )
                .addButton(async (button) => {
                  button.setButtonText(t("settings_import"));
                  button.onClick(async () => {
                    if (importSettingVal !== "") {
                      try {
                        const inputParams = parseUriByHand(importSettingVal);
                        const r =
                          await this.plugin.applyImportedUriParams(inputParams);
                        new Notice(r.message);
                      } catch (e) {
                        new Notice(`${String(e)}`);
                      }

                      importSettingVal = "";
                    } else {
                      new Notice(t("settings_import_error_notice"));
                      importSettingVal = "";
                    }
                  });
                });
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_logging"),
        cls: panelCls,
        items: [
          {
            name: t("settings_debuglevel"),
            desc: t("settings_debuglevel_desc"),
            control: {
              type: "dropdown",
              key: "currLogLevel",
              defaultValue: "info",
              options: {
                info: "Info",
                debug: "Debug",
              },
            },
          },
          {
            name: t("settings_outputsettingsconsole"),
            desc: t("settings_outputsettingsconsole_desc"),
            action: () => {
              void (async () => {
                const c = messyConfigToNormal(
                  (await this.plugin.loadData()) as Parameters<
                    typeof messyConfigToNormal
                  >[0]
                );
                // User explicitly clicked "output settings to console": must
                // fire regardless of the debug level. console.debug is one
                // of the scanner-allowed methods (shows at DevTools
                // "Verbose" level).
                console.debug(c);
                new Notice(t("settings_outputsettingsconsole_notice"));
              })();
            },
          },
          {
            name: t("settings_obfuscatesettingfile"),
            desc: t("settings_obfuscatesettingfile_desc"),
            control: {
              type: "dropdown",
              key: "obfuscateSettingFile",
              defaultValue: "enable",
              options: enableDisableOptions,
            },
          },
          {
            name: t("settings_viewconsolelog"),
            desc: sanitizeHTMLToDom(t("settings_viewconsolelog_desc")),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_syncdiagnostics"),
        cls: panelCls,
        items: [
          {
            name: t("settings_syncplans"),
            desc: t("settings_syncplans_desc"),
            render: (setting) => {
              setting.settingEl.addClass("setting-need-wrapping");
              setting
                .addButton(async (button) => {
                  button.setButtonText(
                    t("settings_syncplans_button_1_only_change")
                  );
                  button.onClick(async () => {
                    await exportVaultSyncPlansToFiles(
                      this.plugin.db,
                      this.app.vault,
                      this.plugin.vaultRandomID,
                      1,
                      true
                    );
                    new Notice(t("settings_syncplans_notice"));
                  });
                })
                .addButton(async (button) => {
                  button.setButtonText(
                    t("settings_syncplans_button_5_only_change")
                  );
                  button.onClick(async () => {
                    await exportVaultSyncPlansToFiles(
                      this.plugin.db,
                      this.app.vault,
                      this.plugin.vaultRandomID,
                      5,
                      true
                    );
                    new Notice(t("settings_syncplans_notice"));
                  });
                })
                .addButton(async (button) => {
                  button.setButtonText(t("settings_syncplans_button_1"));
                  button.onClick(async () => {
                    await exportVaultSyncPlansToFiles(
                      this.plugin.db,
                      this.app.vault,
                      this.plugin.vaultRandomID,
                      1,
                      false
                    );
                    new Notice(t("settings_syncplans_notice"));
                  });
                })
                .addButton(async (button) => {
                  button.setButtonText(t("settings_syncplans_button_5"));
                  button.onClick(async () => {
                    await exportVaultSyncPlansToFiles(
                      this.plugin.db,
                      this.app.vault,
                      this.plugin.vaultRandomID,
                      5,
                      false
                    );
                    new Notice(t("settings_syncplans_notice"));
                  });
                })
                .addButton(async (button) => {
                  button.setButtonText(t("settings_syncplans_button_all"));
                  button.onClick(async () => {
                    await exportVaultSyncPlansToFiles(
                      this.plugin.db,
                      this.app.vault,
                      this.plugin.vaultRandomID,
                      -1,
                      false
                    );
                    new Notice(t("settings_syncplans_notice"));
                  });
                });
            },
          },
          {
            name: t("settings_delsyncplans"),
            desc: t("settings_delsyncplans_desc"),
            action: () => {
              void (async () => {
                await clearAllSyncPlanRecords(this.plugin.db);
                new Notice(t("settings_delsyncplans_notice"));
              })();
            },
          },
          {
            name: t("settings_delprevsync"),
            desc: t("settings_delprevsync_desc"),
            action: () => {
              void (async () => {
                await clearAllPrevSyncRecordByVault(
                  this.plugin.db,
                  this.plugin.vaultRandomID
                );
                new Notice(t("settings_delprevsync_notice"));
              })();
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_profiler"),
        cls: panelCls,
        items: [
          {
            name: t("settings_profiler_results"),
            desc: t("settings_profiler_results_desc"),
            action: () => {
              void (async () => {
                await exportVaultProfilerResultsToFiles(
                  this.plugin.db,
                  this.app.vault,
                  this.plugin.vaultRandomID
                );
                new Notice(t("settings_profiler_results_notice"));
              })();
            },
          },
          {
            name: t("settings_profiler_enableprofiler"),
            desc: t("settings_profiler_enableprofiler_desc"),
            control: {
              type: "dropdown",
              key: "profiler.enable",
              defaultValue: "disable",
              options: enableDisableOptions,
            },
          },
          {
            name: t("settings_profiler_enabledebugprint"),
            desc: t("settings_profiler_enabledebugprint_desc"),
            control: {
              type: "dropdown",
              key: "profiler.enablePrinting",
              defaultValue: "disable",
              options: enableDisableOptions,
            },
          },
          {
            name: t("settings_profiler_recordsize"),
            desc: t("settings_profiler_recordsize_desc"),
            control: {
              type: "dropdown",
              key: "profiler.recordSize",
              defaultValue: "disable",
              options: enableDisableOptions,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_section_diag"),
        cls: panelCls,
        items: [
          {
            // Interactive path diagnosis — enter one path and learn whether
            // it would be synced and, if not, the dominant reason. Reuses
            // the exact same .rs-regex-test-* styling as the Sync tab's
            // regex tester, so it looks identical (same input width, button,
            // result colors, clear-on-empty).
            name: t("settings_diag_name"),
            desc: t("settings_diag_desc"),
            render: (setting) => {
              setting.settingEl.addClass("rs-regex-setting");
              const diagBlock = setting.controlEl.createDiv({
                cls: "rs-regex-test-block",
              });
              const diagRow = diagBlock.createDiv({
                cls: "rs-regex-test-row",
              });
              const diagInputEl = diagRow.createEl("input", {
                type: "text",
                attr: {
                  placeholder: t("settings_regex_test_path_placeholder"),
                  spellcheck: "false",
                },
                cls: "rs-regex-test-input",
              });
              const diagButtonEl = diagRow.createEl("button", {
                text: t("settings_diag_button"),
                cls: "rs-regex-test-button",
              });
              const diagResultEl = diagBlock.createDiv({
                cls: "rs-regex-test-result",
              });

              const handleDiagnose = async () => {
                const raw = diagInputEl.value.trim();
                diagResultEl.empty();
                if (raw === "") {
                  // empty input → clear results silently, no prompt text
                  return;
                }
                // Normalize to the sync-system key form: slash-separated, no
                // leading /.
                let key = raw.replace(/\\/g, "/");
                if (key.startsWith("/")) {
                  key = key.slice(1);
                }
                // Auto-detect file vs folder when the path exists on disk: an
                // existing folder gets a trailing / (the sync-system folder
                // convention). If stat throws or returns nullish, leave the
                // key as-is — a trailing / in the input already means
                // folder, and no trailing slash means file.
                try {
                  const st = await this.app.vault.adapter.stat(key);
                  if (st?.type === "folder" && !key.endsWith("/")) {
                    key = `${key}/`;
                  }
                } catch {
                  // path doesn't exist or stat is unavailable; keep key
                  // unchanged
                }
                const diagnosis = diagnoseSyncSkip(
                  key,
                  this.plugin.settings,
                  this.app.vault.configDir,
                  this.plugin.manifest.id
                );
                if (!diagnosis.skipped) {
                  diagResultEl.createSpan({
                    cls: "rs-regex-test-result-match",
                    text: `\u2713 ${t("settings_diag_will_sync")}`,
                  });
                  return;
                }
                const nomatchEl = diagResultEl.createSpan({
                  cls: "rs-regex-test-result-nomatch",
                });
                nomatchEl.appendText(
                  `\u2717 ${t("settings_diag_wont_sync")} \u2014 `
                );
                const reason = diagnosis.reason;
                if (reason === undefined) {
                  return;
                }
                if (reason.code === "DENY_MATCHED") {
                  // Render the reason text (its {{pattern}} slot left
                  // empty), then show the matched ignore pattern as a
                  // styled code chip — exactly how the regex tester renders
                  // a matched regex.
                  nomatchEl.appendText(
                    t("settings_diag_reason_DENY_MATCHED", { pattern: "" })
                  );
                  nomatchEl.createEl("code", {
                    cls: "rs-regex-matched-regex",
                    text: reason.detail ?? "",
                  });
                } else if (reason.code === "ANCESTOR_SKIPPED") {
                  // An ancestor folder is skipped (e.g. .git/), so the whole
                  // subtree is never walked — the descendant won't sync.
                  // Show the folder as a code chip via createEl({text})
                  // (textContent is not HTML-parsed, so "/" stays "/";
                  // Mustache {{}} would escape it to &#x2F;). Mirrors the
                  // DENY_MATCHED chip above.
                  nomatchEl.appendText(
                    `${t("settings_diag_reason_ANCESTOR_SKIPPED")} `
                  );
                  nomatchEl.createEl("code", {
                    cls: "rs-regex-matched-regex",
                    text: reason.detail ?? "",
                  });
                } else {
                  nomatchEl.appendText(
                    t(`settings_diag_reason_${reason.code}` as TransItemType)
                  );
                }
              };

              diagButtonEl.addEventListener("click", (e) => {
                e.preventDefault();
                void handleDiagnose();
              });
              diagInputEl.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleDiagnose();
                }
              });
              // Clear the result area the moment the input is emptied, so
              // stale results don't linger after the user deletes the path.
              diagInputEl.addEventListener("input", () => {
                if (diagInputEl.value.trim() === "") {
                  diagResultEl.empty();
                }
              });
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_adv_group_dangerzone"),
        cls: panelCls,
        items: [
          {
            name: t("settings_outputbasepathvaultid"),
            desc: t("settings_outputbasepathvaultid_desc"),
            action: () => {
              new Notice(this.plugin.getVaultBasePath());
              new Notice(this.plugin.vaultRandomID);
            },
          },
          {
            name: t("settings_resetcache"),
            desc: t("settings_resetcache_desc"),
            action: () => {
              void (async () => {
                await destroyDBs();
                new Notice(t("settings_resetcache_notice"));
                this.plugin.unload();
              })();
            },
          },
        ],
      },
    ];
  }

  hide() {
    const { containerEl } = this;
    containerEl.empty();
    super.hide();
  }
}
