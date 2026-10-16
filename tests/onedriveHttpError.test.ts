// `_globalsSetup` MUST stay the first import (repo test convention): it
// installs the browser-like globals some src modules touch at load time.
import "./_globalsSetup";
// `_obsidianStub` MUST be imported before ../src/fsOnedrive: it installs the
// require-time intercept for the types-only `obsidian` package (see its docs).
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import {
  FakeFsOnedrive,
  classifyOneDriveWriteError,
  isHandledHttpStatus,
  isTransientNetworkError,
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

describe("isTransientNetworkError", () => {
  it("treats a generic fetch failure as transient", () => {
    assert.strictEqual(
      isTransientNetworkError(new Error("TypeError: Failed to fetch")),
      true
    );
  });

  it("treats an HTTP/2 stream reset (statusless) as transient", () => {
    assert.strictEqual(
      isTransientNetworkError(
        new Error("net::ERR_HTTP2_PROTOCOL_ERROR 200 (OK)")
      ),
      true
    );
  });

  it("treats a connection reset as transient", () => {
    assert.strictEqual(
      isTransientNetworkError(new Error("ERR_CONNECTION_RESET")),
      true
    );
  });

  it("treats an incomplete chunked encoding reset as transient", () => {
    assert.strictEqual(
      isTransientNetworkError(
        new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING 200 (OK)")
      ),
      true
    );
  });

  it("does not treat an HTTP-status error as a network error", () => {
    assert.strictEqual(
      isTransientNetworkError(new Error("Request failed, status 404")),
      false
    );
  });

  it("does not treat a status-bearing object as a network error", () => {
    assert.strictEqual(isTransientNetworkError({ status: 500 }), false);
  });

  it("does not treat undefined as a network error", () => {
    assert.strictEqual(isTransientNetworkError(undefined), false);
  });

  // Regression: the `net::ERR_` catch-all used to match net::ERR_TIMED_OUT,
  // so _retryOnTransientError retried the deltaLink query 3× — each attempt
  // waiting the full timeout window — turning the graceful full-enumeration
  // fallback into a multi-minute hang. Timeouts must NOT be retried.
  it("does NOT treat a timeout as transient (slow to fire, fall back fast)", () => {
    assert.strictEqual(
      isTransientNetworkError(new Error("net::ERR_TIMED_OUT")),
      false
    );
    assert.strictEqual(
      isTransientNetworkError(new Error("net::ERR_CONNECTION_TIMED_OUT")),
      false
    );
    assert.strictEqual(
      isTransientNetworkError(new Error("ERR_TIMED_OUT")),
      false
    );
  });
});

describe("_retryOnTransientError retries statusless network errors", () => {
  it("retries a net::ERR_HTTP2_PROTOCOL_ERROR until it succeeds", async function () {
    // The wrapper's exponential backoff waits 1s + 2s; allow more than the
    // mocha default 2s so the retry-happens assertion can run.
    this.timeout(10000);
    const fs = Object.create(FakeFsOnedrive.prototype) as any;
    let calls = 0;
    const result = await fs._retryOnTransientError(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("net::ERR_HTTP2_PROTOCOL_ERROR 200 (OK)");
      }
      return "ok";
    });
    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 3);
  });
});

describe("_retryOnTransientError does not retry a 412 precondition", () => {
  it("rethrows REMOTE_ETAG_MISMATCH immediately without retrying", async () => {
    const fs = Object.create(FakeFsOnedrive.prototype) as any;
    let calls = 0;
    await assert.rejects(
      fs._retryOnTransientError(async () => {
        calls += 1;
        throw remoteEtagMismatchError(
          "Lab/.obsidian/plugins/copilot/data.json"
        );
      }),
      /Remote etag mismatch/
    );
    assert.strictEqual(calls, 1);
  });
});

describe("_retryOnTransientError does not retry a timeout", () => {
  it("rethrows net::ERR_TIMED_OUT immediately (single attempt, no backoff)", async () => {
    // Regression guard: before the fix, net::ERR_TIMED_OUT matched the
    // `net::ERR_` catch-all and was retried 3×, each attempt waiting the
    // full timeout window. walk()'s deltaLink query then stalled for minutes
    // before the full-enumeration fallback. It must now throw after one call.
    const fs = Object.create(FakeFsOnedrive.prototype) as any;
    let calls = 0;
    await assert.rejects(
      fs._retryOnTransientError(async () => {
        calls += 1;
        throw new Error("net::ERR_TIMED_OUT");
      }),
      /ERR_TIMED_OUT/
    );
    assert.strictEqual(calls, 1);
  });
});

describe("isHandledHttpStatus", () => {
  it("treats 404/412 races and 429/5xx transient as handled", () => {
    for (const s of [404, 412, 429, 500, 502, 503, 504]) {
      assert.strictEqual(isHandledHttpStatus(s), true, `status ${s}`);
    }
  });

  it("does not treat genuine failures or success as handled", () => {
    for (const s of [200, 400, 401, 403, 409, 507, undefined]) {
      assert.strictEqual(isHandledHttpStatus(s), false, `status ${s}`);
    }
  });
});
