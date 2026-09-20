// `_globalsSetup` MUST stay the first import (repo test convention).
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/fsOnedrive: it installs the
// require-time intercept for the types-only `obsidian` package (see its docs).
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { _buildPutRequest } from "../src/fsOnedrive";

describe("onedrive PUT request builder", () => {
  it("without ifMatch: no If-Match header", () => {
    const r = _buildPutRequest("https://graph/x:/content", new ArrayBuffer(1));
    assert.ok(!("If-Match" in r.headers));
  });
  it("with ifMatch: sets If-Match header verbatim", () => {
    const r = _buildPutRequest(
      "https://graph/x:/content",
      new ArrayBuffer(1),
      '"v1"'
    );
    assert.strictEqual(r.headers["If-Match"], '"v1"');
  });
});
