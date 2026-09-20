// `_globalsSetup` MUST stay the first import (repo test convention).
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/fsOnedrive: it installs the
// require-time intercept for the types-only `obsidian` package (see its docs).
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { _buildCreateUploadSessionBody } from "../src/fsOnedrive";

describe("createUploadSession body builder", () => {
  it("no expectedEtag: body has conflictBehavior only", () => {
    const b = _buildCreateUploadSessionBody(undefined, undefined, undefined);
    assert.strictEqual(b.item["@microsoft.graph.conflictBehavior"], "replace");
    // If-Match is a header (sent by _postJson), not part of the body;
    // here we only verify the body structure.
    assert.ok(!("If-Match" in b));
  });
  it("with mtime: body includes fileSystemInfo", () => {
    const b = _buildCreateUploadSessionBody(
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00Z",
      undefined
    );
    assert.deepEqual(b.item.fileSystemInfo, {
      lastModifiedDateTime: "2024-01-01T00:00:00Z",
      createdDateTime: "2024-01-01T00:00:00Z",
    });
  });
});
