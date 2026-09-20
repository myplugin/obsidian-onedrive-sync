// `_globalsSetup` MUST stay the first import (repo test convention): it
// installs the browser-like globals some src modules touch at load time.
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/fsOnedrive: it installs the
// require-time intercept for the types-only `obsidian` package (see its docs).
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import {
  classifyOneDriveWriteError,
  remoteEtagMismatchError,
} from "../src/fsOnedrive";

describe("onedrive write-error classification", () => {
  it("remoteEtagMismatchError sets code+key", () => {
    const e = remoteEtagMismatchError("vault/a.md");
    assert.strictEqual((e as any).code, "REMOTE_ETAG_MISMATCH");
    assert.strictEqual((e as any).key, "vault/a.md");
    assert.match(e.message, /a\.md/);
  });

  it("classify: fetch 412 Error message → REMOTE_ETAG_MISMATCH", () => {
    const e = new Error(
      'OneDrive PUT failed: 412 https://graph/... {"error":{...}}'
    );
    assert.strictEqual(classifyOneDriveWriteError(e), "REMOTE_ETAG_MISMATCH");
  });

  it("classify: {status:412} object → REMOTE_ETAG_MISMATCH", () => {
    assert.strictEqual(
      classifyOneDriveWriteError({ status: 412 }),
      "REMOTE_ETAG_MISMATCH"
    );
  });

  it("classify: Obsidian request 412 ('Request failed, status 412') → REMOTE_ETAG_MISMATCH", () => {
    const e = new Error("Request failed, status 412");
    assert.strictEqual(classifyOneDriveWriteError(e), "REMOTE_ETAG_MISMATCH");
  });

  it("classify: 404 → REMOTE_NOT_FOUND", () => {
    assert.strictEqual(
      classifyOneDriveWriteError({ status: 404 }),
      "REMOTE_NOT_FOUND"
    );
    assert.strictEqual(
      classifyOneDriveWriteError(new Error("status 404")),
      "REMOTE_NOT_FOUND"
    );
  });

  it("classify: 429/500/other → null (not a write-conflict signal)", () => {
    assert.strictEqual(classifyOneDriveWriteError({ status: 429 }), null);
    assert.strictEqual(classifyOneDriveWriteError(new Error("boom")), null);
    assert.strictEqual(classifyOneDriveWriteError(undefined), null);
  });
});
