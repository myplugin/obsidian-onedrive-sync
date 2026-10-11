import { strict as assert } from "assert";
// `_obsidianStub` MUST be imported before ../src/baseTypes: baseTypes value-
// imports `obsidian` at module top level (its VALID_REQURL constant).
import "./_obsidianStub";
import {
  DEFAULT_DEBUG_FOLDER,
  LEGACY_DEBUG_FOLDER,
  isDebugFolderPath,
} from "../src/baseTypes";

describe("isDebugFolderPath", () => {
  it("should treat the current debug folder and its descendants as debug paths", () => {
    assert.ok(isDebugFolderPath("_onedrive_sync_debug/"));
    assert.ok(isDebugFolderPath("_onedrive_sync_debug/a.json"));
    assert.ok(isDebugFolderPath(`${DEFAULT_DEBUG_FOLDER}a.json`));
  });

  it("should treat the legacy debug folder and its descendants as debug paths", () => {
    assert.ok(isDebugFolderPath("_debug_remotely_save/"));
    assert.ok(isDebugFolderPath("_debug_remotely_save/a.json"));
    assert.ok(isDebugFolderPath(`${LEGACY_DEBUG_FOLDER}a.json`));
  });

  it("should not treat normal paths as debug paths", () => {
    assert.ok(!isDebugFolderPath("normal.md"));
    // `_debug_remotely_saveX` does NOT start with `_debug_remotely_save/`.
    assert.ok(!isDebugFolderPath("_debug_remotely_saveX/a.md"));
    assert.ok(!isDebugFolderPath(""));
    assert.ok(!isDebugFolderPath("/"));
  });
});
