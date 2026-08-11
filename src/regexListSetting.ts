import { Notice } from "obsidian";
import type { TransItemType } from "./i18n";
import { testPathAgainstRegexList, validateRegex } from "./misc";

export interface RegexListSettingOptions {
  containerEl: HTMLElement;
  getValues: () => string[];
  setValues: (next: string[]) => Promise<void>;
  t: (k: TransItemType, vars?: any) => string;
  placeholder?: string;
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
  const { containerEl, getValues, setValues, t, placeholder } = opts;

  // chip list + add row + tester, rendered into the Setting's controlEl.
  const blockEl = containerEl.createEl("div", { cls: "rs-regex-block" });

  // chips container — cleared & re-rendered on every mutation
  const chipsEl = blockEl.createEl("div", { cls: "rs-regex-list" });

  // add row
  const addRow = blockEl.createEl("div", { cls: "rs-regex-add-row" });
  const addInputEl = addRow.createEl("input", {
    type: "text",
    attr: { placeholder: placeholder ?? "", spellcheck: "false" },
    cls: "rs-regex-add-input",
  });
  const addButtonEl = addRow.createEl("button", {
    text: t("settings_regex_add_button"),
    cls: "mod-cta rs-regex-add-button",
  });

  // tester
  const testerEl = blockEl.createEl("div", { cls: "rs-regex-tester" });
  const testRow = testerEl.createEl("div", { cls: "rs-regex-test-row" });
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
  const testResultEl = testerEl.createEl("div", {
    cls: "rs-regex-test-result",
  });

  const renderChips = () => {
    chipsEl.empty();
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
        const current = [...getValues()];
        current.splice(idx, 1);
        await setValues(current);
        renderChips();
      });
    });
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

  renderChips();
}
