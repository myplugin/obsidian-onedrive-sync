// `_globalsSetup` MUST stay the first import (repo test convention):
// src/sync.ts -> src/localdb.ts -> localforage needs the localStorage shim
// under plain Node.js.
import "./_globalsSetup";
// `_obsidianStub` is defensive here: src/sync.ts itself does NOT value-import
// obsidian today (verified: syncExported.test.ts imports it stub-free), but
// its wide import graph may grow one; the stub makes require("obsidian")
// crash-proof either way.
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { dispatchOperationToActualV3 } from "../src/sync";
import { asDB, createMockDB } from "./_dbMock";
import { makeMockFs, str2ab } from "./_fsMock";

/**
 * Replace the mock remote's writeFile with a faithful model of the OneDrive
 * If-Match guard (Tasks 4/5): a write carrying `expectedEtag` is ATOMICALLY
 * REJECTED with a coded REMOTE_ETAG_MISMATCH error and NOTHING is written;
 * a write without `expectedEtag` (merge/dup write-backs) succeeds normally.
 */
function installEtagGuard(remote: ReturnType<typeof makeMockFs>) {
  const origWriteFile = remote.writeFile.bind(remote);
  (remote as any).writeFile = async (
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expectedEtag?: string
  ) => {
    if (expectedEtag !== undefined) {
      const e = new Error("mismatch");
      (e as any).code = "REMOTE_ETAG_MISMATCH";
      (e as any).key = key;
      throw e;
    }
    return origWriteFile(key, content, mtime, ctime);
  };
}

describe("dispatchOperationToActualV3: 412 re-route", () => {
  it("push throws REMOTE_ETAG_MISMATCH -> routes to mergeFile path", async () => {
    // fsLocal: local has a.md (B-version, this device's edit)
    const local = makeMockFs("local", { "a.md": "B-version" });
    // fsEncrypt(remote): has a.md (A-version, the other device's edit);
    // writeFile rejects the If-Match push with REMOTE_ETAG_MISMATCH, while
    // readFile still serves A-version for mergeFile's right-hand content.
    const remote = makeMockFs("remote", { "a.md": "A-version" });
    installEtagGuard(remote);
    const db = asDB(createMockDB());
    // pre-seed the fileContentHistory base (base = P-version); key format is
    // `${vaultRandomID}\t${profileID}\t${key}` (src/fileContentHistory.ts)
    await db.fileContentHistoryTbl.setItem(
      "vault\tprof\ta.md",
      str2ab("P-version")
    );

    const r: any = {
      key: "a.md",
      local: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeCli: 2000,
        sizeRaw: 9,
        etag: undefined,
      },
      prevSync: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 1000,
        sizeRaw: 8,
        etag: '"vP"',
      },
      remote: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 1500,
        sizeRaw: 9,
        etag: '"vA"',
      },
      decision: "local_is_modified_then_push",
      conflictAction: "smart_conflict",
    };
    await dispatchOperationToActualV3(
      "a.md",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "smart_conflict"
    );
    // the decision was re-routed to the visible-conflict path
    assert.strictEqual(r.decision, "conflict_modified_then_smart_conflict");
    // B-version was NOT silently lost: mergeFile wrote the merged result
    // back to BOTH sides
    assert.ok(
      (remote as any).__writes.find((w: any) => w.key === "a.md"),
      "merged result written back to remote"
    );
    assert.ok(
      (local as any).__writes.find((w: any) => w.key === "a.md"),
      "merged result written back to local"
    );
    // 412 = atomic rejection: the ONLY remote write is the merge write-back;
    // the rejected push wrote nothing
    assert.strictEqual(
      (remote as any).__writes.length,
      1,
      "the 412'd push must not have written anything to remote"
    );
  });

  it("push throws REMOTE_ETAG_MISMATCH (non-mergeable) -> routes to tryDuplicateFile path", async () => {
    // non-mergeable key (.bin) -> isMergable false -> tryDuplicateFile
    const local = makeMockFs("local", { "b.bin": "B-version-longer" });
    const remote = makeMockFs("remote", { "b.bin": "A" });
    installEtagGuard(remote);
    const db = asDB(createMockDB());

    const r: any = {
      key: "b.bin",
      local: {
        key: "b.bin",
        keyRaw: "b.bin",
        mtimeCli: 2000,
        sizeRaw: 16,
        etag: undefined,
      },
      prevSync: {
        key: "b.bin",
        keyRaw: "b.bin",
        mtimeSvr: 1000,
        sizeRaw: 8,
        etag: '"vP"',
      },
      remote: {
        key: "b.bin",
        keyRaw: "b.bin",
        mtimeSvr: 1500,
        sizeRaw: 1,
        etag: '"vA"',
      },
      decision: "local_is_modified_then_push",
      conflictAction: "smart_conflict",
    };
    await dispatchOperationToActualV3(
      "b.bin",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "smart_conflict"
    );
    assert.strictEqual(r.decision, "conflict_modified_then_smart_conflict");
    // tryDuplicateFile ran: local b.bin renamed to b.dup.bin, the dup
    // uploaded to remote, and the remote's b.bin downloaded to local —
    // neither side's version was clobbered
    assert.ok(
      (local as any).renameCalls.find(
        (c: any) => c.from === "b.bin" && c.to === "b.dup.bin"
      ),
      "local original renamed to .dup"
    );
    assert.ok(
      (remote as any).__writes.find((w: any) => w.key === "b.dup.bin"),
      "dup uploaded to remote"
    );
    assert.ok(
      (local as any).__writes.find((w: any) => w.key === "b.bin"),
      "remote version downloaded to local"
    );
    // 412 = atomic rejection: the only remote write is the dup upload
    assert.strictEqual(
      (remote as any).__writes.length,
      1,
      "the 412'd push must not have written anything to remote"
    );
  });
});
