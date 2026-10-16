import { strict as assert } from "assert";
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/syncDiagnose: it pulls in
// ../src/baseTypes, which value-imports `obsidian` at module top level.
import "./_obsidianStub";
import type { RemotelySavePluginSettings } from "../src/baseTypes";
import { diagnoseSyncSkip } from "../src/syncDiagnose";

const makeSettings = (): RemotelySavePluginSettings =>
  ({
    onlyAllowPaths: [],
    ignorePaths: [],
    syncObsidianConfig: true,
    syncAppearance: false,
    syncBookmarks: false,
    syncThirdPartyPlugins: true,
    syncSelfPlugin: true,
    syncDotItems: false,
    syncUnderscoreItems: false,
  }) as any;

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "onedrive-vault-sync";

describe("diagnoseSyncSkip debug folder", () => {
  it("should skip the current debug export folder with DEBUG_FOLDER", () => {
    const diag = diagnoseSyncSkip(
      "_onedrive_sync_debug/",
      makeSettings(),
      CONFIG_DIR,
      SELF_PLUGIN_ID
    );
    assert.strictEqual(diag.skipped, true);
    assert.strictEqual(diag.reason?.code, "DEBUG_FOLDER");
  });

  it("should skip the legacy debug export folder with DEBUG_FOLDER", () => {
    const diag = diagnoseSyncSkip(
      "_debug_remotely_save/",
      makeSettings(),
      CONFIG_DIR,
      SELF_PLUGIN_ID
    );
    assert.strictEqual(diag.skipped, true);
    assert.strictEqual(diag.reason?.code, "DEBUG_FOLDER");
  });

  it("should skip a descendant of the debug folder (via ancestor pruning)", () => {
    const diag = diagnoseSyncSkip(
      "_onedrive_sync_debug/a.json",
      makeSettings(),
      CONFIG_DIR,
      SELF_PLUGIN_ID
    );
    assert.strictEqual(diag.skipped, true);
  });

  it("should not skip a normal note", () => {
    const diag = diagnoseSyncSkip(
      "note.md",
      makeSettings(),
      CONFIG_DIR,
      SELF_PLUGIN_ID
    );
    assert.strictEqual(diag.skipped, false);
  });
});
