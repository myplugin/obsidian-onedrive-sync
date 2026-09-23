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
  moment,
  requireApiVersion,
} from "obsidian";
import type { TextComponent } from "obsidian";
import type {
  CipherMethodType,
  ConflictActionType,
  QRExportType,
  SUPPORTED_SERVICES_TYPE_WITH_REMOTE_BASE_DIR,
  SyncDirectionType,
  SyncOnSaveMode,
} from "./baseTypes";

import cloneDeep from "lodash/cloneDeep";
import { API_VER_ENSURE_REQURL_OK, VALID_REQURL } from "./baseTypes";
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
import {
  exportQrCodeUri,
  importQrCodeUri,
  parseUriByHand,
} from "./importExport";
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
import type RemotelySavePlugin from "./main"; // unavoidable
import {
  changeMobileStatusBar,
  checkHasSpecialCharForDir,
  stringToFragment,
} from "./misc";
import { DEFAULT_PROFILER_CONFIG } from "./profiler";
import { renderRegexListSetting } from "./regexListSetting";
import { generateClearDupFilesSettingsPart } from "./settingsClearDupFiles";
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

    const t = (x: TransItemType, vars?: any) => {
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

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // contentEl.setText("Add Or change password.");
    contentEl.createEl("h2", { text: t("modal_encryptionmethod_title") });
    t("modal_encryptionmethod_shortdesc")
      .split("\n")
      .forEach((val, idx) => {
        contentEl.createEl("p", {
          text: stringToFragment(val),
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

    const t = (x: TransItemType, vars?: any) => {
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
            (this.plugin.settings as any)[this.service].remoteBaseDir = "";
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
            (this.plugin.settings as any)[this.service].remoteBaseDir =
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

    const t = (x: TransItemType, vars?: any) => {
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
            text: stringToFragment(val),
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
    const t = (x: TransItemType, vars?: any) => {
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
            );
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
  exportType: QRExportType;
  constructor(app: App, plugin: RemotelySavePlugin, exportType: QRExportType) {
    super(app);
    this.plugin = plugin;
    this.exportType = exportType;
  }

  async onOpen() {
    const { contentEl } = this;

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    const { rawUri, imgUri } = await exportQrCodeUri(
      this.plugin.settings,
      this.app.vault.getName(),
      this.plugin.manifest.version,
      this.exportType
    );

    const div1 = contentEl.createDiv();
    t("modal_qr_shortdesc")
      .split("\n")
      .forEach((val) => {
        div1.createEl("p", {
          text: val,
        });
      });

    const div2 = contentEl.createDiv();
    div2.createEl(
      "button",
      {
        text: t("modal_qr_button"),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(rawUri);
          new Notice(t("modal_qr_button_notice"));
        };
      }
    );

    const div3 = contentEl.createDiv();
    div3.createEl(
      "img",
      {
        cls: "qrcode-img",
      },
      async (el) => {
        el.src = imgUri;
      }
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

const getEyesElements = () => {
  const eyeEl = createElement(Eye);
  const eyeOffEl = createElement(EyeOff);
  return {
    eye: eyeEl.outerHTML,
    eyeOff: eyeOffEl.outerHTML,
  };
};

export const wrapTextWithPasswordHide = (text: TextComponent) => {
  const { eye, eyeOff } = getEyesElements();
  const hider = text.inputEl.insertAdjacentElement("afterend", createSpan())!;
  // the init type of hider is "hidden" === eyeOff === password
  hider.innerHTML = eyeOff;
  hider.addEventListener("click", (e) => {
    const isText = text.inputEl.getAttribute("type") === "text";
    hider.innerHTML = isText ? eyeOff : eye;
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

  display(): void {
    const { containerEl } = this;
    containerEl.style.setProperty("overflow-wrap", "break-word");
    containerEl.empty();
    containerEl.createEl("h1", { text: "Remotely Save (OneDrive)" });

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    const tabBar = containerEl.createDiv({ cls: "rs-tab-bar" });
    const panelsHost = containerEl.createDiv({ cls: "rs-panels" });

    const accountPanel = panelsHost.createDiv({
      cls: "rs-panel rs-panel-active",
    });
    const syncPanel = panelsHost.createDiv({ cls: "rs-panel" });
    const safetyPanel = panelsHost.createDiv({ cls: "rs-panel" });
    const advancedPanel = panelsHost.createDiv({ cls: "rs-panel" });

    const accountTab = this.createTabButton(
      tabBar,
      t("settings_section_account"),
      true
    );
    const syncTab = this.createTabButton(
      tabBar,
      t("settings_section_sync"),
      false
    );
    const safetyTab = this.createTabButton(
      tabBar,
      t("settings_section_safety"),
      false
    );
    const advancedTab = this.createTabButton(
      tabBar,
      t("settings_section_advanced"),
      false
    );

    const tabs = [accountTab, syncTab, safetyTab, advancedTab];
    const panels = [accountPanel, syncPanel, safetyPanel, advancedPanel];
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        tabs.forEach((tb, j) => {
          tb.toggleClass("rs-tab-active", i === j);
          panels[j].toggleClass("rs-panel-active", i === j);
        });
      });
    });

    this.generateAccountSection(accountPanel);
    this.generateSyncOptionsSection(syncPanel);

    safetyPanel.createEl("h3", {
      text: t("settings_section_conflict"),
      cls: "rs-subheading",
    });
    this.generateConflictSection(safetyPanel);
    safetyPanel.createEl("h3", {
      text: t("settings_section_encryption"),
      cls: "rs-subheading",
    });
    this.generateEncryptionSection(safetyPanel);

    this.generateAdvancedSection(advancedPanel);
  }

  private createTabButton(
    tabBar: HTMLElement,
    label: string,
    active: boolean
  ): HTMLElement {
    const tab = tabBar.createDiv({
      cls: active ? "rs-tab rs-tab-active" : "rs-tab",
    });
    tab.setText(label);
    return tab;
  }

  // ① 账户与连接
  private generateAccountSection(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // ── collapsible disclaimer callout ──
    const initiallyOpen = this.plugin.settings.disclaimerAcknowledged !== true;
    const disclaimerDiv = containerEl.createEl("div", {
      cls: initiallyOpen ? "rs-disclaimer rs-disclaimer-open" : "rs-disclaimer",
    });

    const header = disclaimerDiv.createDiv({ cls: "rs-disclaimer-header" });
    const chevron = header.createSpan({ cls: "rs-disclaimer-chevron" });
    chevron.innerHTML = createElement(ChevronRight).outerHTML;
    header.createSpan({
      cls: "rs-disclaimer-title",
      text: t("settings_disclaimer_title"),
    });
    header.createSpan({
      cls: "rs-disclaimer-summary",
      text: t("settings_disclaimer_summary"),
    });

    const body = disclaimerDiv.createDiv({ cls: "rs-disclaimer-body" });

    const warnIcon = createElement(AlertTriangle).outerHTML;
    for (const c of [
      t("settings_onedrive_disclaimer1"),
      t("settings_onedrive_disclaimer2"),
    ]) {
      const p = body.createEl("p", { cls: "rs-disclaimer-warn" });
      p.createSpan({ cls: "rs-disclaimer-icon" }).innerHTML = warnIcon;
      p.createSpan({ text: c });
    }

    const folderP = body.createEl("p", { cls: "rs-disclaimer-info" });
    folderP.createSpan({ cls: "rs-disclaimer-icon" }).innerHTML =
      createElement(Info).outerHTML;
    folderP.createSpan({
      text: t("settings_onedrive_folder", {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.onedrive.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    });

    const nobizP = body.createEl("p", { cls: "rs-disclaimer-info" });
    nobizP.createSpan({ cls: "rs-disclaimer-icon" }).innerHTML =
      createElement(Info).outerHTML;
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

    let newOnedriveRemoteBaseDir =
      this.plugin.settings.onedrive.remoteBaseDir || "";
    new Setting(containerEl)
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
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

    new Setting(containerEl)
      .setName(t("settings_onedrive_emptyfile"))
      .setDesc(t("settings_onedrive_emptyfile_desc"))
      .addDropdown(async (dropdown) => {
        dropdown
          .addOption("skip", t("settings_onedrive_emptyfile_skip"))
          .addOption("error", t("settings_onedrive_emptyfile_error"))
          .setValue(this.plugin.settings.onedrive.emptyFile)
          .onChange(async (val) => {
            this.plugin.settings.onedrive.emptyFile = val as any;
            await this.plugin.saveSettings();
          });
      });

    const checkSetting = new Setting(containerEl)
      .setName(t("settings_checkonnectivity"))
      .setDesc(t("settings_checkonnectivity_desc"));

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
        const time = (moment as any)(latestTime).fromNow();
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
        const res = await client.checkConnect((err: any) => {
          errors.msg = `${err}`;
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

  // ② 同步选项
  private generateSyncOptionsSection(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    containerEl.createEl("h3", {
      text: t("settings_section_sync_direction"),
      cls: "rs-subheading",
    });

    new Setting(containerEl)
      .setName(t("setting_syncdirection"))
      .setDesc(stringToFragment(t("setting_syncdirection_desc")))
      .addDropdown((dropdown) => {
        dropdown.addOption(
          "bidirectional",
          t("setting_syncdirection_bidirectional_desc")
        );
        dropdown.addOption(
          "incremental_push_only",
          t("setting_syncdirection_incremental_push_only_desc")
        );
        dropdown.addOption(
          "incremental_pull_only",
          t("setting_syncdirection_incremental_pull_only_desc")
        );
        dropdown.addOption(
          "incremental_push_and_delete_only",
          t("setting_syncdirection_incremental_push_and_delete_only_desc")
        );
        dropdown.addOption(
          "incremental_pull_and_delete_only",
          t("setting_syncdirection_incremental_pull_and_delete_only_desc")
        );

        dropdown
          .setValue(this.plugin.settings.syncDirection ?? "bidirectional")
          .onChange(async (val) => {
            this.plugin.settings.syncDirection = val as SyncDirectionType;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_concurrency"))
      .setDesc(t("settings_concurrency_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("1", "1");
        dropdown.addOption("2", "2");
        dropdown.addOption("3", "3");
        dropdown.addOption("5", "5 (default)");
        dropdown.addOption("10", "10");
        dropdown.addOption("15", "15");
        dropdown.addOption("20", "20");

        dropdown
          .setValue(`${this.plugin.settings.concurrency}`)
          .onChange(async (val) => {
            const realVal = Number.parseInt(val);
            this.plugin.settings.concurrency = realVal;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", {
      text: t("settings_section_sync_automatic"),
      cls: "rs-subheading",
    });

    const autoRunSetting = new Setting(containerEl)
      .setName(t("settings_autorun"))
      .setDesc(t("settings_autorun_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_autorun_notset"));
        dropdown.addOption(`${1000 * 60 * 1}`, t("settings_autorun_1min"));
        dropdown.addOption(`${1000 * 60 * 5}`, t("settings_autorun_5min"));
        dropdown.addOption(`${1000 * 60 * 10}`, t("settings_autorun_10min"));
        dropdown.addOption(`${1000 * 60 * 30}`, t("settings_autorun_30min"));

        dropdown
          .setValue(`${this.plugin.settings.autoRunEveryMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = Number.parseInt(val);
            this.plugin.settings.autoRunEveryMilliseconds = realVal;
            await this.plugin.saveSettings();
            if (
              (realVal === undefined || realVal === null || realVal <= 0) &&
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
                console.info("auto run from settings.ts");
                this.plugin.syncRun("auto");
              }, realVal);
              this.plugin.autoRunIntervalID = intervalID;
              this.plugin.registerInterval(intervalID);
            }
          });
      });

    addSyncToggle(autoRunSetting, "autoRunEveryMilliseconds", this.plugin, t);

    const runOnceSetting = new Setting(containerEl)
      .setName(t("settings_runoncestartup"))
      .setDesc(t("settings_runoncestartup_desc"))
      .addDropdown((dropdown) => {
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

    addSyncToggle(runOnceSetting, "initRunAfterMilliseconds", this.plugin, t);

    const syncOnSaveSetting = new Setting(containerEl)
      .setName(t("settings_synconsave"))
      .setDesc(t("settings_synconsave_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("off", t("settings_synconsave_disable"));
        dropdown.addOption("throttle", t("settings_synconsave_mode_throttle"));
        dropdown.addOption(
          "rateLimit",
          t("settings_synconsave_mode_ratelimit")
        );
        dropdown
          .setValue(`${this.plugin.settings.syncOnSaveMode ?? "off"}`)
          .onChange(async (val: string) => {
            const mode = val as SyncOnSaveMode;
            this.plugin.settings.syncOnSaveMode = mode;
            // Keep the legacy field consistent for mixed-version fleets (old
            // builds still read syncOnSaveAfterMilliseconds): throttle=1000,
            // off/rateLimit=-1 (rateLimit has no legacy representation; old
            // peers treat it as off — the safe default).
            this.plugin.settings.syncOnSaveAfterMilliseconds =
              mode === "throttle" ? 1000 : -1;
            await this.plugin.saveSettings();
            this.plugin.toggleSyncOnSaveIfSet();
            // rateLimit requires periodic auto-sync as the safety net for
            // saves dropped within the 1-min window; warn immediately if
            // the prerequisite is unmet (the handler stays inert otherwise).
            const periodicOn =
              this.plugin.settings.autoRunEveryMilliseconds !== undefined &&
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

    addSyncToggle(syncOnSaveSetting, "syncOnSaveMode", this.plugin, t);

    containerEl.createEl("h3", {
      text: t("settings_section_obsidian_sync"),
      cls: "rs-subheading",
    });

    // Blacklist notice
    containerEl.createEl("p", {
      text: t("settings_blacklist_notice"),
      cls: "setting-item-description",
    });

    // syncObsidianConfig (default ON)
    new Setting(containerEl)
      .setName(t("settings_obsidian_config"))
      .setDesc(
        t("settings_obsidian_config_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncObsidianConfig ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncObsidianConfig = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncAppearance (keep existing)
    new Setting(containerEl)
      .setName(t("settings_appearance"))
      .setDesc(
        t("settings_appearance_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncAppearance ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncAppearance = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncBookmarks (keep existing)
    new Setting(containerEl)
      .setName(t("settings_bookmarks"))
      .setDesc(
        t("settings_bookmarks_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));

        dropdown
          .setValue(
            `${this.plugin.settings.syncBookmarks ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncBookmarks = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncThirdPartyPlugins (default ON)
    new Setting(containerEl)
      .setName(t("settings_third_party_plugins"))
      .setDesc(
        t("settings_third_party_plugins_desc", {
          configDir: this.app.vault.configDir,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncThirdPartyPlugins ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncThirdPartyPlugins = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    // syncSelfPlugin (default ON)
    new Setting(containerEl)
      .setName(t("settings_self_plugin"))
      .setDesc(
        t("settings_self_plugin_desc", {
          configDir: this.app.vault.configDir,
          pluginId: this.plugin.manifest.id,
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncSelfPlugin ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncSelfPlugin = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_syncunderscore"))
      .setDesc(t("settings_syncunderscore_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncUnderscoreItems ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncUnderscoreItems = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_syncdot"))
      .setDesc(t("settings_syncdot_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("disable", t("disable"));
        dropdown.addOption("enable", t("enable"));
        dropdown
          .setValue(
            `${this.plugin.settings.syncDotItems ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            this.plugin.settings.syncDotItems = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_skiplargefiles"))
      .setDesc(t("settings_skiplargefiles_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("-1", t("settings_skiplargefiles_notset"));

        const mbs = [1, 5, 10, 20, 50, 100, 200, 500, 1000];
        for (const mb of mbs) {
          dropdown.addOption(`${mb * 1000 * 1000}`, `${mb} MB`);
        }
        dropdown
          .setValue(`${this.plugin.settings.skipSizeLargerThan}`)
          .onChange(async (val) => {
            this.plugin.settings.skipSizeLargerThan = Number.parseInt(val);
            await this.plugin.saveSettings();
          });
      });

    const ignorePathsSetting = new Setting(containerEl)
      .setName(t("settings_ignorepaths"))
      .setDesc(t("settings_ignorepaths_desc"));
    ignorePathsSetting.settingEl.addClass("rs-regex-setting");
    renderRegexListSetting({
      app: this.app,
      containerEl: ignorePathsSetting.controlEl,
      getValues: () => this.plugin.settings.ignorePaths ?? [],
      setValues: async (next) => {
        this.plugin.settings.ignorePaths = next;
        await this.plugin.saveSettings();
      },
      t,
      placeholder: t("settings_regex_add_placeholder"),
    });

    const onlyAllowPathsSetting = new Setting(containerEl)
      .setName(t("settings_onlyallowpaths"))
      .setDesc(t("settings_onlyallowpaths_desc"));
    onlyAllowPathsSetting.settingEl.addClass("rs-regex-setting");
    renderRegexListSetting({
      app: this.app,
      containerEl: onlyAllowPathsSetting.controlEl,
      getValues: () => this.plugin.settings.onlyAllowPaths ?? [],
      setValues: async (next) => {
        this.plugin.settings.onlyAllowPaths = next;
        await this.plugin.saveSettings();
      },
      t,
      placeholder: t("settings_regex_add_placeholder"),
    });

    containerEl.createEl("h3", {
      text: t("settings_section_sync_protection"),
      cls: "rs-subheading",
    });

    new Setting(containerEl)
      .setName(t("settings_deletetowhere"))
      .setDesc(t("settings_deletetowhere_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("system", t("settings_deletetowhere_system_trash"));
        dropdown.addOption(
          "obsidian",
          t("settings_deletetowhere_obsidian_trash")
        );
        dropdown
          .setValue(this.plugin.settings.deleteToWhere ?? "system")
          .onChange(async (val) => {
            this.plugin.settings.deleteToWhere = val as "system" | "obsidian";
            await this.plugin.saveSettings();
          });
      });

    const percentage1 = new Setting(containerEl)
      .setName(t("settings_protectmodifypercentage"))
      .setDesc(t("settings_protectmodifypercentage_desc"));

    const percentage2 = new Setting(containerEl)
      .setName(t("settings_protectmodifypercentage_customfield"))
      .setDesc(t("settings_protectmodifypercentage_customfield_desc"));
    if ((this.plugin.settings.protectModifyPercentage ?? 50) % 10 === 0) {
      percentage2.settingEl.addClass("settings-percentage-custom-hide");
    }
    let percentage2Text: TextComponent | undefined = undefined;
    percentage2.addText((text) => {
      text.inputEl.type = "number";
      percentage2Text = text;
      text
        .setPlaceholder("0 ~ 100")
        .setValue(`${this.plugin.settings.protectModifyPercentage ?? 50}`)
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

    percentage1.addDropdown((dropdown) => {
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
        percentage2.settingEl.removeClass("settings-percentage-custom");
      }
      dropdown.setValue(initVal).onChange(async (val) => {
        const k = Number.parseInt(val);
        if (val === "custom" || Number.isNaN(k)) {
          // do nothing until user changes something in custom field
          percentage2.settingEl.removeClass("settings-percentage-custom-hide");
        } else {
          this.plugin.settings.protectModifyPercentage = k;
          percentage2.settingEl.addClass("settings-percentage-custom-hide");
          percentage2Text?.setValue(`${k}`);
          await this.plugin.saveSettings();
        }
      });
    });
  }

  // ③ 冲突处理
  private generateConflictSection(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    let conflictActionSettingOrigDesc = t("settings_conflictaction_desc");
    if (
      (this.plugin.settings.conflictAction ?? "keep_newer") === "smart_conflict"
    ) {
      conflictActionSettingOrigDesc += t(
        "settings_conflictaction_smart_conflict_desc"
      );
    }
    const conflictActionSetting = new Setting(containerEl)
      .setName(t("settings_conflictaction"))
      .setDesc(stringToFragment(conflictActionSettingOrigDesc));
    conflictActionSetting.addDropdown((dropdown) => {
      dropdown
        .addOption("keep_newer", t("settings_conflictaction_keep_newer"))
        .addOption("keep_larger", t("settings_conflictaction_keep_larger"))
        .addOption(
          "smart_conflict",
          t("settings_conflictaction_smart_conflict")
        )
        .setValue(this.plugin.settings.conflictAction ?? "keep_newer")
        .onChange(async (val) => {
          this.plugin.settings.conflictAction = val as ConflictActionType;
          await this.plugin.saveSettings();

          conflictActionSettingOrigDesc = t("settings_conflictaction_desc");
          if (
            (this.plugin.settings.conflictAction ?? "keep_newer") ===
            "smart_conflict"
          ) {
            conflictActionSettingOrigDesc += t(
              "settings_conflictaction_smart_conflict_desc"
            );
          }
          conflictActionSetting.setDesc(
            stringToFragment(conflictActionSettingOrigDesc)
          );
        });
    });

    generateClearDupFilesSettingsPart(containerEl, t, this.app, this.plugin);
  }

  // ④ 加密
  private generateEncryptionSection(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    const passwordSetting = new Setting(containerEl);
    const encryptionMethodSetting = new Setting(containerEl);

    let newPassword = `${this.plugin.settings.password}`;
    passwordSetting
      .setName(t("settings_password"))
      .setDesc(t("settings_password_desc"))
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
          new PasswordModal(
            this.app,
            this.plugin,
            newPassword,
            encryptionMethodSetting
          ).open();
        });
      });

    if (this.plugin.settings.password === "") {
      encryptionMethodSetting.settingEl.addClass(
        "settings-encryption-method-hide"
      );
    }
    encryptionMethodSetting
      .setName(t("settings_encryptionmethod"))
      .setDesc(stringToFragment(t("settings_encryptionmethod_desc")))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("rclone-base64", t("settings_encryptionmethod_rclone"))
          .addOption("openssl-base64", t("settings_encryptionmethod_openssl"))
          .setValue(this.plugin.settings.encryptionMethod ?? "rclone-base64")
          .onChange(async (val: string) => {
            this.plugin.settings.encryptionMethod = val as CipherMethodType;
            await this.plugin.saveSettings();
            if (this.plugin.settings.password !== "") {
              new EncryptionMethodModal(this.app, this.plugin).open();
            }
          });
      });
  }

  // ⑤ 高级
  private generateAdvancedSection(containerEl: HTMLElement): void {
    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars);
    };

    // status bar
    // custom status bar items is not supported on mobile
    if (!Platform.isMobileApp) {
      new Setting(containerEl)
        .setName(t("settings_enablestatusbar_info"))
        .setDesc(t("settings_enablestatusbar_info_desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.enableStatusBarInfo ?? false)
            .onChange(async (val) => {
              this.plugin.settings.enableStatusBarInfo = val;
              await this.plugin.saveSettings();
              new Notice(t("settings_enablestatusbar_reloadrequired_notice"));
            });
        });

      new Setting(containerEl)
        .setName(t("settings_resetstatusbar_time"))
        .setDesc(t("settings_resetstatusbar_time_desc"))
        .addButton((button) => {
          button.setButtonText(t("settings_resetstatusbar_button"));
          button.onClick(async () => {
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
            this.plugin.updateLastSyncMsg(undefined, "not_syncing", null, null);
            new Notice(t("settings_resetstatusbar_notice"));
          });
        });
    }

    if (Platform.isMobile) {
      new Setting(containerEl)
        .setName(t("settings_enablemobilestatusbar"))
        .setDesc(t("settings_enablemobilestatusbar_desc"))
        .addDropdown(async (dropdown) => {
          dropdown
            .addOption("enable", t("enable"))
            .addOption("disable", t("disable"));

          dropdown
            .setValue(
              `${
                this.plugin.settings.enableMobileStatusBar
                  ? "enable"
                  : "disable"
              }`
            )
            .onChange(async (val) => {
              if (val === "enable") {
                this.plugin.settings.enableMobileStatusBar = true;
                this.plugin.appContainerObserver =
                  changeMobileStatusBar("enable");
              } else {
                this.plugin.settings.enableMobileStatusBar = false;
                changeMobileStatusBar(
                  "disable",
                  this.plugin.appContainerObserver
                );
                this.plugin.appContainerObserver?.disconnect();
                this.plugin.appContainerObserver = undefined;
              }
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t("settings_trackrenames"))
      .setDesc(t("settings_trackrenames_desc"))
      .addDropdown(async (dropdown) => {
        dropdown
          .addOption("enable", t("enable"))
          .addOption("disable", t("disable"));

        dropdown
          .setValue(
            `${this.plugin.settings.trackRenames ? "enable" : "disable"}`
          )
          .onChange(async (val) => {
            if (val === "enable") {
              this.plugin.settings.trackRenames = true;
            } else {
              this.plugin.settings.trackRenames = false;
            }
            await this.plugin.saveSettings();
          });
      });

    //////////////////////////////////////////////////
    // below for import and export functions
    //////////////////////////////////////////////////

    const importExportDivSetting1 = new Setting(containerEl)
      .setName(t("settings_export"))
      .setDesc(t("settings_export_desc"));
    importExportDivSetting1.settingEl.addClass("setting-need-wrapping");
    importExportDivSetting1
      .addButton(async (button) => {
        button.setButtonText(t("settings_export_basic_and_advanced_button"));
        button.onClick(async () => {
          new ExportSettingsQrCodeModal(
            this.app,
            this.plugin,
            "basic_and_advanced"
          ).open();
        });
      })
      .addButton(async (button) => {
        button.setButtonText(t("settings_export_onedrive_button"));
        button.onClick(async () => {
          new ExportSettingsQrCodeModal(
            this.app,
            this.plugin,
            "onedrive"
          ).open();
        });
      });

    let importSettingVal = "";
    new Setting(containerEl)
      .setName(t("settings_import"))
      .setDesc(t("settings_import_desc"))
      .addText((text) =>
        text
          .setPlaceholder("obsidian://remotely-save?func=settings&...")
          .setValue("")
          .onChange((val) => {
            importSettingVal = val;
          })
      )
      .addButton(async (button) => {
        button.setButtonText(t("confirm"));
        button.onClick(async () => {
          if (importSettingVal !== "") {
            // console.debug(importSettingVal);
            try {
              const inputParams = parseUriByHand(importSettingVal);
              const parsed = importQrCodeUri(
                inputParams,
                this.app.vault.getName()
              );
              if (parsed.status === "error") {
                new Notice(parsed.message);
              } else {
                const copied = cloneDeep(parsed.result);
                // new Notice(JSON.stringify(copied))
                this.plugin.settings = Object.assign(
                  {},
                  this.plugin.settings,
                  copied
                );
                this.plugin.saveSettings();
                new Notice(
                  t("protocol_saveqr", {
                    manifestName: this.plugin.manifest.name,
                  })
                );
              }
            } catch (e) {
              new Notice(`${e}`);
            }

            importSettingVal = "";
          } else {
            new Notice(t("settings_import_error_notice"));
            importSettingVal = "";
          }
        });
      });

    //////////////////////////////////////////////////
    // below for debug
    //////////////////////////////////////////////////

    new Setting(containerEl)
      .setName(t("settings_debuglevel"))
      .setDesc(t("settings_debuglevel_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption("info", "info");
        dropdown.addOption("debug", "debug");
        dropdown
          .setValue(this.plugin.settings.currLogLevel ?? "info")
          .onChange(async (val: string) => {
            this.plugin.settings.currLogLevel = val;
            await this.plugin.saveSettings();
            console.info(`the log level is changed to ${val}`);
          });
      });

    new Setting(containerEl)
      .setName(t("settings_outputsettingsconsole"))
      .setDesc(t("settings_outputsettingsconsole_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_outputsettingsconsole_button"));
        button.onClick(async () => {
          const c = messyConfigToNormal(await this.plugin.loadData());
          console.info(c);
          new Notice(t("settings_outputsettingsconsole_notice"));
        });
      });

    new Setting(containerEl)
      .setName(t("settings_obfuscatesettingfile"))
      .setDesc(t("settings_obfuscatesettingfile_desc"))
      .addDropdown(async (dropdown) => {
        dropdown
          .addOption("enable", t("enable"))
          .addOption("disable", t("disable"));

        dropdown
          .setValue(
            `${
              this.plugin.settings.obfuscateSettingFile ? "enable" : "disable"
            }`
          )
          .onChange(async (val) => {
            if (val === "enable") {
              this.plugin.settings.obfuscateSettingFile = true;
            } else {
              this.plugin.settings.obfuscateSettingFile = false;
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_viewconsolelog"))
      .setDesc(stringToFragment(t("settings_viewconsolelog_desc")));

    const debugDivExportSyncPlans = new Setting(containerEl)
      .setName(t("settings_syncplans"))
      .setDesc(t("settings_syncplans_desc"));
    debugDivExportSyncPlans.settingEl.addClass("setting-need-wrapping");
    debugDivExportSyncPlans
      .addButton(async (button) => {
        button.setButtonText(t("settings_syncplans_button_1_only_change"));
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
        button.setButtonText(t("settings_syncplans_button_5_only_change"));
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

    new Setting(containerEl)
      .setName(t("settings_delsyncplans"))
      .setDesc(t("settings_delsyncplans_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_delsyncplans_button"));
        button.onClick(async () => {
          await clearAllSyncPlanRecords(this.plugin.db);
          new Notice(t("settings_delsyncplans_notice"));
        });
      });

    new Setting(containerEl)
      .setName(t("settings_delprevsync"))
      .setDesc(t("settings_delprevsync_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_delprevsync_button"));
        button.onClick(async () => {
          await clearAllPrevSyncRecordByVault(
            this.plugin.db,
            this.plugin.vaultRandomID
          );
          new Notice(t("settings_delprevsync_notice"));
        });
      });

    new Setting(containerEl)
      .setName(t("settings_profiler_results"))
      .setDesc(t("settings_profiler_results_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_profiler_results_button_all"));
        button.onClick(async () => {
          await exportVaultProfilerResultsToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID
          );
          new Notice(t("settings_profiler_results_notice"));
        });
      });

    new Setting(containerEl)
      .setName(t("settings_profiler_enableprofiler"))
      .setDesc(t("settings_profiler_enableprofiler_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("enable", t("enable"));
        dropdown.addOption("disable", t("disable"));
        dropdown
          .setValue(
            `${this.plugin.settings.profiler?.enable ? "enable" : "disable"}`
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG;
            }
            this.plugin.settings.profiler.enable = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_profiler_enabledebugprint"))
      .setDesc(t("settings_profiler_enabledebugprint_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("enable", t("enable"));
        dropdown.addOption("disable", t("disable"));
        dropdown
          .setValue(
            `${this.plugin.settings.profiler?.enablePrinting ? "enable" : "disable"}`
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG;
            }
            this.plugin.settings.profiler.enablePrinting = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_profiler_recordsize"))
      .setDesc(t("settings_profiler_recordsize_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("enable", t("enable"));
        dropdown.addOption("disable", t("disable"));
        dropdown
          .setValue(
            `${this.plugin.settings.profiler?.recordSize ? "enable" : "disable"}`
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG;
            }
            this.plugin.settings.profiler.recordSize = val === "enable";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_outputbasepathvaultid"))
      .setDesc(t("settings_outputbasepathvaultid_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_outputbasepathvaultid_button"));
        button.onClick(async () => {
          new Notice(this.plugin.getVaultBasePath());
          new Notice(this.plugin.vaultRandomID);
        });
      });

    new Setting(containerEl)
      .setName(t("settings_resetcache"))
      .setDesc(t("settings_resetcache_desc"))
      .addButton(async (button) => {
        button.setButtonText(t("settings_resetcache_button"));
        button.onClick(async () => {
          await destroyDBs();
          new Notice(t("settings_resetcache_notice"));
          this.plugin.unload();
        });
      });
  }

  hide() {
    const { containerEl } = this;
    containerEl.empty();
    super.hide();
  }
}
