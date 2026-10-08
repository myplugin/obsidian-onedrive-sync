// Characterization tests for the dirty-buffer guard routing inside
// dispatchOperationToActualV3 (and the handleConflictModifiedSmartConflict
// it delegates to) in src/sync.ts. The guard keeps a sync from clobbering
// a file that is open in an Obsidian editor with unsaved changes:
// - download/pull decisions write the remote (or merged) content to a
//   .dup conflict copy instead of overwriting the live local file;
// - remote-deleted decisions skip the local deletion entirely;
// - smart-conflict decisions skip mergeFile / tryDuplicateFile and write
//   ONE .dup copy (merged content when mergeable, raw remote otherwise);
// - ALL prev-sync record updates are skipped so a later run re-decides
//   from the unchanged state once the user saves the buffer;
// - dirtyOpenHandledPaths prevents a second .dup write within one run.
//
// `_globalsSetup` MUST stay the first import (repo test convention):
// src/sync.ts -> src/localdb.ts -> localforage needs the localStorage shim
// under plain Node.js.
import "./_globalsSetup";
// `_obsidianStub` is defensive here: src/sync.ts itself does NOT value-import
// obsidian today, but its wide import graph may grow one; the stub makes
// require("obsidian") crash-proof either way.
import "./_obsidianStub";

import { strict as assert } from "assert";
import { after, before, describe, it } from "mocha";
import {
  dispatchOperationToActualV3,
  handleConflictModifiedSmartConflict,
} from "../src/sync";
import { asDB, createMockDB } from "./_dbMock";
import { makeMockFs, str2ab } from "./_fsMock";

// Keep the exported handler referenced: the smart-conflict scenarios below
// exercise it through dispatchOperationToActualV3 (which delegates to it
// verbatim, threading isFileDirtyOpen + dirtyOpenHandledPaths through).
assert.equal(typeof handleConflictModifiedSmartConflict, "function");

function ab2str(ab: ArrayBuffer): string {
  return Buffer.from(ab).toString("utf-8");
}

describe("dispatchOperationToActualV3: dirty-buffer guard", () => {
  // The guard logs via console.debug (remote-deleted branch, src/sync.ts)
  // and so does writeDupCopyForDirtyOpen; keep the test output clean.
  const origDebug = console.debug;
  before(() => {
    console.debug = () => {};
  });
  after(() => {
    console.debug = origDebug;
  });

  it("download (remote_is_modified_then_pull) + dirty-open: writes .dup, no local overwrite, no prevSync upsert", async () => {
    const DIRTY_KEY = "a.md";
    const local = makeMockFs("local", { "a.md": "local-v" });
    const remote = makeMockFs("remote", { "a.md": "remote-v" });
    const db = asDB(createMockDB());
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: undefined,
      remote: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 5000,
        sizeRaw: 8,
        etag: '"vR"',
      },
      decision: "remote_is_modified_then_pull",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      new Set<string>()
    );

    // the live local file was NOT overwritten with the remote content
    assert.strictEqual(ab2str(local.files.get("a.md")!), "local-v");
    // the remote content went to the .dup conflict copy instead
    assert.ok(local.files.has("a.dup.md"));
    assert.strictEqual(ab2str(local.files.get("a.dup.md")!), "remote-v");
    // the .dup copy is the ONLY local write
    assert.strictEqual(local.writeCalls.length, 1);
    assert.strictEqual(local.writeCalls[0].key, "a.dup.md");
    // NO prev-sync upsert: a later run retries the download once the
    // editor buffer is saved
    const rec = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
    assert.strictEqual(rec, null);
  });

  it("download + dirty-open + already handled this run: no second dup write (anti-loop)", async () => {
    const DIRTY_KEY = "a.md";
    const local = makeMockFs("local", { "a.md": "local-v" });
    const remote = makeMockFs("remote", { "a.md": "remote-v" });
    const db = asDB(createMockDB());
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: undefined,
      remote: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 5000,
        sizeRaw: 8,
        etag: '"vR"',
      },
      decision: "remote_is_modified_then_pull",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      // pre-seeded: this path was already handled earlier in the same run
      new Set<string>(["a.md"])
    );

    // nothing written at all: no dup, no overwrite
    assert.strictEqual(local.writeCalls.length, 0);
    assert.strictEqual(ab2str(local.files.get("a.md")!), "local-v");
    assert.ok(!local.files.has("a.dup.md"));
  });

  it("remote_is_deleted_thus_also_delete_local + dirty-open: skips local rm, keeps prevSync", async () => {
    const DIRTY_KEY = "a.md";
    const local = makeMockFs("local", { "a.md": "local-v" });
    const remote = makeMockFs("remote", {});
    const db = asDB(createMockDB());
    await db.prevSyncRecordsTbl.setItem("vault\tprof\ta.md", { etag: '"v"' });
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 1000,
        sizeRaw: 7,
        etag: '"v"',
      },
      remote: undefined,
      decision: "remote_is_deleted_thus_also_delete_local",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      new Set<string>()
    );

    // the local file was NOT removed (that IS the protection here; no
    // .dup copy is written for the delete branch)
    assert.ok(local.files.has("a.md"));
    assert.strictEqual(local.writeCalls.length, 0);
    // the prev-sync record was NOT cleared: the next run re-decides this
    // path from the unchanged state
    const rec: any = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
    assert.notStrictEqual(rec, null);
    assert.strictEqual(rec.etag, '"v"');
  });

  it("remote_is_deleted + dirty-open + already handled: no-op", async () => {
    const DIRTY_KEY = "a.md";
    const local = makeMockFs("local", { "a.md": "local-v" });
    const remote = makeMockFs("remote", {});
    const db = asDB(createMockDB());
    await db.prevSyncRecordsTbl.setItem("vault\tprof\ta.md", { etag: '"v"' });
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 1000,
        sizeRaw: 7,
        etag: '"v"',
      },
      remote: undefined,
      decision: "remote_is_deleted_thus_also_delete_local",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      // pre-seeded: already handled earlier in the same run
      new Set<string>(["a.md"])
    );

    // pure no-op: local file kept, prev-sync record kept
    assert.ok(local.files.has("a.md"));
    const rec: any = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
    assert.notStrictEqual(rec, null);
    assert.strictEqual(rec.etag, '"v"');
  });

  it("conflict_modified_then_smart_conflict + dirty-open + mergeable: writes merged .dup, no mergeFile write to live file, no prevSync upsert", async () => {
    const DIRTY_KEY = "a.md";
    const local = makeMockFs("local", { "a.md": "left-edit" });
    const remote = makeMockFs("remote", { "a.md": "right-edit" });
    const db = asDB(createMockDB());
    // pre-seed the file-content-history base (key format is
    // `${vaultRandomID}\t${profileID}\t${key}`) so the guard's merge
    // path has a three-way base to work from
    await db.fileContentHistoryTbl.setItem("vault\tprof\ta.md", str2ab("base"));
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 9 },
      prevSync: undefined,
      remote: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 5000,
        sizeRaw: 10,
        etag: '"vR"',
      },
      decision: "conflict_modified_then_smart_conflict",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      new Set<string>()
    );

    // mergeFile did NOT write the merged result over the live local file
    assert.strictEqual(ab2str(local.files.get("a.md")!), "left-edit");
    // ...nor to the remote (mergeFile writes both sides)
    assert.strictEqual(remote.writeCalls.length, 0);
    // the MERGED content went to the .dup conflict copy instead (the
    // guard passes opts.content, so fsEncrypt.readFile is never called)
    assert.ok(local.files.has("a.dup.md"));
    const dupText = ab2str(local.files.get("a.dup.md")!);
    assert.ok(dupText.includes("left-edit"), "dup holds the local side");
    assert.ok(dupText.includes("right-edit"), "dup holds the remote side");
    // the .dup copy is the ONLY local write
    assert.strictEqual(local.writeCalls.length, 1);
    assert.strictEqual(local.writeCalls[0].key, "a.dup.md");
    // the handler skipped ALL prev-sync record updates
    const rec = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
    assert.strictEqual(rec, null);
  });

  it("conflict_modified_then_smart_conflict + dirty-open + non-mergeable (.bin): writes raw remote .dup, no tryDuplicateFile rename", async () => {
    const DIRTY_KEY = "b.bin";
    const local = makeMockFs("local", { "b.bin": "local-b" });
    const remote = makeMockFs("remote", { "b.bin": "remote-b" });
    const db = asDB(createMockDB());
    const r: any = {
      key: "b.bin",
      local: { key: "b.bin", keyRaw: "b.bin", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: undefined,
      remote: {
        key: "b.bin",
        keyRaw: "b.bin",
        mtimeSvr: 5000,
        sizeRaw: 8,
        etag: '"vR"',
      },
      decision: "conflict_modified_then_smart_conflict",
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
      "smart_conflict",
      [],
      (p) => p === DIRTY_KEY,
      new Set<string>()
    );

    // tryDuplicateFile never ran: no rename of the live local file
    assert.strictEqual(local.renameCalls.length, 0);
    assert.strictEqual(ab2str(local.files.get("b.bin")!), "local-b");
    // the RAW remote content went to the .dup conflict copy
    assert.ok(local.files.has("b.dup.bin"));
    assert.strictEqual(ab2str(local.files.get("b.dup.bin")!), "remote-b");
    // the .dup copy is the ONLY local write
    assert.strictEqual(local.writeCalls.length, 1);
  });

  it("guard off (isFileDirtyOpen undefined): normal download overwrites local (regression)", async () => {
    const local = makeMockFs("local", { "a.md": "local-v" });
    const remote = makeMockFs("remote", { "a.md": "remote-v" });
    const db = asDB(createMockDB());
    const r: any = {
      key: "a.md",
      local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 7 },
      prevSync: undefined,
      remote: {
        key: "a.md",
        keyRaw: "a.md",
        mtimeSvr: 5000,
        sizeRaw: 8,
        etag: '"vR"',
      },
      decision: "remote_is_modified_then_pull",
      conflictAction: "smart_conflict",
    };

    // 8-arg call: no conflictsEncountered, no isFileDirtyOpen, no
    // dirtyOpenHandledPaths -> guard is completely off
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

    // normal download: the live local file IS overwritten
    assert.strictEqual(ab2str(local.files.get("a.md")!), "remote-v");
    assert.ok(local.writeCalls.find((w) => w.key === "a.md"));
    // the prev-sync record IS upserted as usual
    const rec = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
    assert.notStrictEqual(rec, null);
  });
});
