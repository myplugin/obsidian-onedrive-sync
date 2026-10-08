// `_globalsSetup` MUST stay the first import (repo test convention).
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/fsOnedrive: it installs the
// require-time intercept for the types-only `obsidian` package (see its docs).
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { _buildRenameRequest } from "../src/fsOnedrive";

describe("onedrive RENAME request builder", () => {
  it("same-directory rename: name is the new basename only, no parent change", () => {
    const r = _buildRenameRequest("folder/old.md", "folder/new.md", "MyVault");
    assert.strictEqual(r.name, "new.md");
    assert.strictEqual(r.parentChanged, false);
  });
  it("root-level rename: name is the new basename only, no parent change", () => {
    const r = _buildRenameRequest("old.md", "new.md", "MyVault");
    assert.strictEqual(r.name, "new.md");
    assert.strictEqual(r.parentChanged, false);
  });
  it("cross-directory move: name is basename, parentChanged=true, newParentKey ends with /", () => {
    const r = _buildRenameRequest(
      "old_dir/file.md",
      "new_dir/file.md",
      "MyVault"
    );
    assert.strictEqual(r.name, "file.md");
    assert.strictEqual(r.parentChanged, true);
    assert.strictEqual(r.newParentKey, "new_dir/");
  });
  it("url is the Graph path of the OLD item (the PATCH target)", () => {
    const r = _buildRenameRequest("folder/old.md", "folder/new.md", "MyVault");
    assert.strictEqual(r.url, "/me/drive/special/approot:/MyVault/folder/old.md");
  });
  it("folder rename: trailing slash stripped from the basename", () => {
    const r = _buildRenameRequest("old_folder/", "new_folder/", "MyVault");
    assert.strictEqual(r.name, "new_folder");
    assert.strictEqual(r.parentChanged, false);
  });
});
