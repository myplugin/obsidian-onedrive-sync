import { ChevronRight, createElement } from "lucide";
import { type App, Modal, Notice, Platform } from "obsidian";
import type { TransItemType } from "./i18n";
import { testPathAgainstRegexList, validateRegex } from "./misc";

export interface RegexListSettingOptions {
  app: App;
  containerEl: HTMLElement;
  getValues: () => string[];
  setValues: (next: string[]) => Promise<void>;
  t: (k: TransItemType, vars?: any) => string;
  placeholder?: string;
}

/**
 * A themed, in-page confirm dialog for deleting a regex. Uses Obsidian's
 * Modal base (NOT window.confirm — that minimizes the settings window and
 * pops an OS-level dialog, terrible UX). Inherits the current theme and
 * stacks on top of the settings UI without dismissing it. Returns true on
 * confirm, false on cancel/Esc/backdrop.
 */
function confirmDeleteRegex(
  app: App,
  t: (k: TransItemType, vars?: any) => string,
  regex: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let resolved = false;
    const finish = (val: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
      modal.close();
    };
    modal.titleEl.setText(t("settings_regex_delete_confirm"));
    const codeEl = modal.contentEl.createEl("pre", {
      cls: "rs-regex-delete-code",
    });
    codeEl.createEl("code", { text: regex });
    const btnRow = modal.contentEl.createDiv({
      cls: "rs-regex-delete-buttons",
    });
    const cancelBtn = btnRow.createEl("button", { text: t("goback") });
    cancelBtn.addEventListener("click", () => finish(false));
    const deleteBtn = btnRow.createEl("button", {
      text: t("settings_regex_delete_button"),
      cls: "mod-warning",
    });
    deleteBtn.addEventListener("click", () => finish(true));
    // Esc / backdrop click counts as cancel.
    modal.onClose = () => finish(false);
    modal.open();
    deleteBtn.focus();
  });
}

/**
 * Render a chip-list editor for a string[] of regexes, with an inline add
 * row (multi-paste aware) and a per-list path tester. Used by the
 * ignorePaths / onlyAllowPaths settings. All mutations flow through
 * `setValues` (caller persists); validation state is derived from the raw
 * strings on every render so it never drifts from stored data.
 *
 * Render INTO a `Setting`'s controlEl — the caller wraps this in a
 * `new Setting().setName().setDesc()` so the row inherits Obsidian's
 * standard `.setting-item` styling (background, padding, divider). A CSS
 * override (`.rs-regex-setting` on the settingEl) flips that `.setting-item`
 * to flex-column so name/desc sit on top and this control fills the width
 * below, avoiding the default left-right split's empty space.
 */
export function renderRegexListSetting(opts: RegexListSettingOptions): void {
  const { app, containerEl, getValues, setValues, t, placeholder } = opts;

  // chip list (with a row-end collapse toggle) + collapsible add/test
  // panel, rendered into the Setting's controlEl.
  const blockEl = containerEl.createEl("div", { cls: "rs-regex-block" });
  // On mobile, render chips as stacked full-width rows (one regex per line,
  // full text visible) instead of the PC chip capsule — the flex-wrap chip
  // layout is fragile on narrow viewports. See the .rs-regex-mobile CSS.
  if (Platform.isMobile) {
    blockEl.addClass("rs-regex-mobile");
  }

  // chips container — renderChips re-anchors the collapse toggle to the
  // end of this list (appendChild moves it after every chip), so it sits
  // inline at the row end, reading as a peer of the chips (same 20px
  // footprint as a chip's × delete). renderChips swaps only chip
  // children, never the toggle, so it survives every re-render and stays
  // at the row end.
  const chipsEl = blockEl.createEl("div", { cls: "rs-regex-list" });

  // collapse toggle — Add and Test are both low-frequency, so they are
  // collapsed by default and revealed on demand via this small icon at
  // the row end. Mirrors the rs-disclaimer callout's ChevronRight
  // disclosure (rotate 90° on expand) for one consistent
  // collapsible-section language across the plugin.
  const toggleBtnEl = chipsEl.createEl("button", {
    cls: "rs-regex-collapse-toggle",
    attr: {
      type: "button",
      "aria-expanded": "false",
      "aria-label": t("settings_regex_manage_aria"),
      title: t("settings_regex_manage_aria"),
    },
  });
  const caretEl = toggleBtnEl.createEl("span", {
    cls: "rs-regex-collapse-caret",
  });
  caretEl.innerHTML = createElement(ChevronRight).outerHTML;

  // collapsible panel — holds the add row and the test row (both
  // low-frequency), collapsed by default; the toggle above reveals it.
  const panelEl = blockEl.createEl("div", {
    cls: "rs-regex-panel rs-is-collapsed",
  });

  // add row
  const addRow = panelEl.createEl("div", { cls: "rs-regex-add-row" });
  const addInputEl = addRow.createEl("input", {
    type: "text",
    attr: { placeholder: placeholder ?? "", spellcheck: "false" },
    cls: "rs-regex-add-input",
  });
  const addButtonEl = addRow.createEl("button", {
    text: t("settings_regex_add_button"),
    cls: "mod-cta rs-regex-add-button",
  });

  // test row — sits below the add row, separated by a subtle dashed
  // divider (see .rs-regex-panel .rs-regex-test-row in styles.css).
  const testRow = panelEl.createEl("div", { cls: "rs-regex-test-row" });
  const testInputEl = testRow.createEl("input", {
    type: "text",
    attr: {
      placeholder: t("settings_regex_test_path_placeholder"),
      spellcheck: "false",
    },
    cls: "rs-regex-test-input",
  });
  const testButtonEl = testRow.createEl("button", {
    text: t("settings_regex_test_button"),
    cls: "rs-regex-test-button",
  });
  const testResultEl = panelEl.createEl("div", {
    cls: "rs-regex-test-result",
  });

  const renderChips = () => {
    // Swap out only stale chips; the collapse-toggle must survive
    // re-renders and stay inline with the chips.
    chipsEl.querySelectorAll(".rs-regex-chip").forEach((c) => c.remove());
    const values = getValues();
    values.forEach((value, index) => {
      const chip = chipsEl.createEl("span", { cls: "rs-regex-chip" });

      const validation = validateRegex(value);
      if (!validation.ok) {
        chip.addClass("rs-regex-chip-invalid");
        const tip = t("settings_regex_invalid_tooltip", {
          error: validation.error,
        });
        chip.createEl("span", {
          cls: "rs-regex-chip-warning",
          text: "\u26a0",
          attr: { title: tip, "aria-label": tip },
        });
      }

      chip.createEl("span", { cls: "rs-regex-chip-text", text: value });

      const delBtn = chip.createEl("button", {
        cls: "rs-regex-chip-delete",
        text: "\u00d7",
        attr: { "aria-label": "remove" },
      });
      const idx = index;
      delBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        // themed in-page second confirmation (NOT window.confirm — that
        // minimizes the settings window and pops an OS dialog). Prevents
        // accidental deletion when the × is tapped.
        const ok = await confirmDeleteRegex(app, t, value);
        if (!ok) return;
        const current = [...getValues()];
        current.splice(idx, 1);
        await setValues(current);
        renderChips();
      });
    });
    // re-anchor the toggle as the last child so it always sits at the
    // row end, after every chip. appendChild on an already-attached node
    // is a move, so its listeners survive.
    chipsEl.appendChild(toggleBtnEl);
  };

  const handleAdd = async () => {
    const raw = addInputEl.value;
    if (raw === "") return;
    // multi-paste: a pasted block with newlines splits into several regexes
    const pieces = raw.split("\n");
    const current = [...getValues()];
    let addedAny = false;
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed === "") continue;
      if (current.includes(trimmed)) {
        new Notice(t("settings_regex_already_exists"));
        continue;
      }
      // invalid regex is still appended; it renders red via renderChips
      current.push(trimmed);
      addedAny = true;
    }
    if (addedAny) {
      addInputEl.value = "";
      await setValues(current);
      renderChips();
    }
  };

  addButtonEl.addEventListener("click", (e) => {
    e.preventDefault();
    void handleAdd();
  });
  addInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleAdd();
    }
  });

  const handleTest = () => {
    const path = testInputEl.value.trim();
    testResultEl.empty();
    if (path === "") {
      testResultEl.createEl("span", {
        cls: "rs-regex-test-result-nomatch",
        text: t("settings_regex_test_empty_path"),
      });
      return;
    }
    const values = getValues();
    if (values.length === 0) {
      testResultEl.createEl("span", {
        cls: "rs-regex-test-result-nomatch",
        text: t("settings_regex_test_empty_list"),
      });
      return;
    }
    const { matched, matchedRegexes } = testPathAgainstRegexList(values, path);
    if (matched) {
      const matchEl = testResultEl.createEl("span", {
        cls: "rs-regex-test-result-match",
      });
      matchEl.createEl("span", { text: "\u2713 " });
      // localized prefix, e.g. "Matched: " (the {{regexes}} slot rendered empty)
      matchEl.appendText(t("settings_regex_test_match", { regexes: "" }));
      for (const re of matchedRegexes) {
        matchEl.createEl("code", {
          cls: "rs-regex-matched-regex",
          text: re,
        });
        matchEl.appendText(" ");
      }
    } else {
      testResultEl.createEl("span", {
        cls: "rs-regex-test-result-nomatch",
        text: `\u2717 ${t("settings_regex_test_nomatch")}`,
      });
    }
  };

  testButtonEl.addEventListener("click", (e) => {
    e.preventDefault();
    handleTest();
  });
  testInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTest();
    }
  });

  toggleBtnEl.addEventListener("click", (e) => {
    e.preventDefault();
    const collapsed = panelEl.hasClass("rs-is-collapsed");
    if (collapsed) {
      panelEl.removeClass("rs-is-collapsed");
      toggleBtnEl.addClass("rs-is-expanded");
      toggleBtnEl.setAttribute("aria-expanded", "true");
    } else {
      panelEl.addClass("rs-is-collapsed");
      toggleBtnEl.removeClass("rs-is-expanded");
      toggleBtnEl.setAttribute("aria-expanded", "false");
    }
  });

  renderChips();
}
