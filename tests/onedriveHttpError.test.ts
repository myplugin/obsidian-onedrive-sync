// `_globalsSetup` MUST stay the first import (repo test convention): it
// installs the browser-like globals some src modules touch at load time.
import "./_globalsSetup";

import { strict as assert } from "assert";
import Module from "node:module";
import { describe, it } from "mocha";

// ── obsidian runtime stub ──────────────────────────────────────────────
// The `obsidian` npm package is types-only ("main": "", no runtime JS), so
// require("obsidian") throws MODULE_NOT_FOUND under plain Node. Every other
// src module tested in this repo is obsidian-free at runtime (type-only
// imports); src/fsOnedrive.ts is the first that is not: it value-imports
// request/requestUrl from obsidian, and value-imports src/baseTypes.ts,
// which evaluates Platform.isAndroidApp + requireApiVersion() at module top
// level (VALID_REQURL). Intercept CJS module loading with a minimal stub
// covering exactly those load-time members. request/requestUrl throw: the
// pure functions under test never call them.
const obsidianStub = {
  Platform: { isAndroidApp: false, isMobileApp: false, isDesktopApp: true },
  requireApiVersion: () => true,
  request: () => {
    throw new Error("obsidian.request is not available in tests");
  },
  requestUrl: () => {
    throw new Error("obsidian.requestUrl is not available in tests");
  },
};
const originalModuleLoad = (Module as any)._load;
(Module as any)._load = function (
  this: any,
  request: string,
  parent: any,
  isMain: boolean
) {
  if (request === "obsidian") {
    return obsidianStub;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

// fsOnedrive MUST be loaded via require() AFTER the stub is installed: a
// static `import ... from "../src/fsOnedrive"` is hoisted above every
// statement in the transpiled output and would crash with MODULE_NOT_FOUND.
const {
  remoteEtagMismatchError,
  classifyOneDriveWriteError,
} = require("../src/fsOnedrive");

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
