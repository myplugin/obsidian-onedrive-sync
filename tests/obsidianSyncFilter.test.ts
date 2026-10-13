import { strict as assert } from "assert";
import { checkIsSkipItemOrNotByName } from "../src/skipFilter";

const CF = ".obsidian";
const PID = "onedrive-vault-sync";

function skip(
  key: string,
  syncObsidianConfig = false,
  syncAppearance = false,
  syncBookmarks = false,
  syncThirdPartyPlugins = false,
  syncSelfPlugin = false
): boolean {
  return checkIsSkipItemOrNotByName(
    key,
    false,
    false,
    false,
    CF,
    [],
    [],
    syncObsidianConfig,
    syncAppearance,
    syncBookmarks,
    syncThirdPartyPlugins,
    syncSelfPlugin,
    PID
  ).finalIsIgnored;
}

const ALL_ON = [true, true, true, true, true] as const;

describe("Obsidian sync: blacklist (always excluded)", () => {
  it("#1 workspace.json always skipped", () => {
    assert.ok(skip(`${CF}/workspace.json`, ...ALL_ON));
  });
  it("#2 workspace-mobile.json always skipped", () => {
    assert.ok(skip(`${CF}/workspace-mobile.json`, ...ALL_ON));
  });
  it("#3 workspaces.json always skipped", () => {
    assert.ok(skip(`${CF}/workspaces.json`, ...ALL_ON));
  });
  it("#4 core-plugins-migration.json always skipped", () => {
    assert.ok(skip(`${CF}/core-plugins-migration.json`, ...ALL_ON));
  });
});

describe("Obsidian sync: self plugin", () => {
  it("#5 self data.json always skipped", () => {
    assert.ok(
      skip(`${CF}/plugins/${PID}/data.json`, false, false, false, false, true)
    );
  });
  it("#6 self main.js synced when syncSelfPlugin on", () => {
    assert.ok(
      !skip(`${CF}/plugins/${PID}/main.js`, false, false, false, false, true)
    );
  });
  it("#7 self main.js skipped when syncSelfPlugin off", () => {
    assert.ok(
      skip(`${CF}/plugins/${PID}/main.js`, false, false, false, false, false)
    );
  });
  it("#8 self styles.css synced", () => {
    assert.ok(
      !skip(`${CF}/plugins/${PID}/styles.css`, false, false, false, false, true)
    );
  });
  it("#9 self synced_settings.json synced", () => {
    assert.ok(
      !skip(
        `${CF}/plugins/${PID}/synced_settings.json`,
        false,
        false,
        false,
        false,
        true
      )
    );
  });
  it("#10 self .gitignore synced", () => {
    assert.ok(
      !skip(`${CF}/plugins/${PID}/.gitignore`, false, false, false, false, true)
    );
  });
  it("#30 self unknown file skipped", () => {
    assert.ok(
      skip(`${CF}/plugins/${PID}/unknown.txt`, false, false, false, false, true)
    );
  });
});

describe("Obsidian sync: third-party plugins", () => {
  it("#11 other plugin main.js synced", () => {
    assert.ok(
      !skip(`${CF}/plugins/dataview/main.js`, false, false, false, true, false)
    );
  });
  it("#12 other plugin main.js skipped when off", () => {
    assert.ok(
      skip(`${CF}/plugins/dataview/main.js`, false, false, false, false, false)
    );
  });
  it("#13 other plugin data.json synced", () => {
    assert.ok(
      !skip(`${CF}/plugins/copilot/data.json`, false, false, false, true, false)
    );
  });
  it("#14 other plugin manifest.json synced", () => {
    assert.ok(
      !skip(
        `${CF}/plugins/dataview/manifest.json`,
        false,
        false,
        false,
        true,
        false
      )
    );
  });
});

describe("Obsidian sync: core config", () => {
  it("#15 app.json synced when on", () => {
    assert.ok(!skip(`${CF}/app.json`, true, false, false, false, false));
  });
  it("#16 app.json skipped when off", () => {
    assert.ok(skip(`${CF}/app.json`, false, false, false, false, false));
  });
  it("#17 core-plugins.json synced", () => {
    assert.ok(
      !skip(`${CF}/core-plugins.json`, true, false, false, false, false)
    );
  });
  it("#18 community-plugins.json synced", () => {
    assert.ok(
      !skip(`${CF}/community-plugins.json`, true, false, false, false, false)
    );
  });
  it("#19 snippets synced", () => {
    assert.ok(!skip(`${CF}/snippets/h1.css`, true, false, false, false, false));
  });
  it("#20 snippets skipped when off", () => {
    assert.ok(skip(`${CF}/snippets/h1.css`, false, false, false, false, false));
  });
  it("#21 themes synced", () => {
    assert.ok(
      !skip(`${CF}/themes/PLN/theme.css`, true, false, false, false, false)
    );
  });
  it("#22 icons synced", () => {
    assert.ok(
      !skip(
        `${CF}/icons/tabl-icons/CodeCircle.svg`,
        true,
        false,
        false,
        false,
        false
      )
    );
  });
});

describe("Obsidian sync: independent sub-toggles", () => {
  it("#23 appearance.json skipped when syncAppearance off", () => {
    assert.ok(skip(`${CF}/appearance.json`, true, false, false, false, false));
  });
  it("#24 appearance.json synced when syncAppearance on (independent)", () => {
    assert.ok(!skip(`${CF}/appearance.json`, false, true, false, false, false));
  });
  it("#25 bookmarks.json skipped when syncBookmarks off", () => {
    assert.ok(skip(`${CF}/bookmarks.json`, true, false, false, false, false));
  });
  it("#26 bookmarks.json synced when syncBookmarks on (independent)", () => {
    assert.ok(!skip(`${CF}/bookmarks.json`, false, false, true, false, false));
  });
});

describe("Obsidian sync: directory and non-config files", () => {
  it("#27 .obsidian/ itself not skipped when any toggle on", () => {
    assert.ok(!skip(`${CF}/`, false, false, false, false, true));
  });
  it("#28 .obsidian/ itself skipped when all off", () => {
    assert.ok(skip(`${CF}/`, false, false, false, false, false));
  });
  it("#29 non-config file unaffected", () => {
    assert.ok(!skip("notes/test.md", false, false, false, false, false));
  });
});

describe("Obsidian sync: toggle independence", () => {
  it("#31 third-party off blocks other plugin even if self+config on", () => {
    assert.ok(
      skip(`${CF}/plugins/dataview/main.js`, true, false, false, false, true)
    );
  });
  it("#32 config off blocks app.json even if self+thirdparty on", () => {
    assert.ok(skip(`${CF}/app.json`, false, false, false, true, true));
  });
});

describe("Obsidian sync: folder routing (keptFolder fix)", () => {
  it("self plugin folder not skipped when syncSelfPlugin on", () => {
    assert.ok(!skip(`${CF}/plugins/${PID}/`, false, false, false, false, true));
  });
  it("self plugin folder skipped when syncSelfPlugin off", () => {
    assert.ok(skip(`${CF}/plugins/${PID}/`, false, false, false, false, false));
  });
  it("plugins/ dir not skipped when only syncSelfPlugin on", () => {
    assert.ok(!skip(`${CF}/plugins/`, false, false, false, false, true));
  });
  it("plugins/ dir not skipped when only syncThirdPartyPlugins on", () => {
    assert.ok(!skip(`${CF}/plugins/`, false, false, false, true, false));
  });
  it("plugins/ dir skipped when both plugin toggles off", () => {
    assert.ok(skip(`${CF}/plugins/`, false, false, false, false, false));
  });
});
