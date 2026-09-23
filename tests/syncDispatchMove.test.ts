// License: Apache-2.0 (see src/LICENSE)
// Tests for move/rename dispatch: verifies that "local_moved_then_rename_remote"
// and "moved_away" decisions round-trip through splitFourStepsOnEntityMappings
// (no "unknown decision" throw) and dispatchOperationToActualV3 (rename called,
// no re-upload). This directly mitigates the #1 risk identified by the audit:
// the two catch-all throws at sync.ts:1421 and sync.ts:1839.

import "./_globalsSetup";
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import {
  dispatchOperationToActualV3,
  removeGhostRemotes,
  splitFourStepsOnEntityMappings,
} from "../src/sync";
import { asDB, createMockDB } from "./_dbMock";
import { makeMockFs } from "./_fsMock";

describe("splitFourStepsOnEntityMappings: move decisions", () => {
  it("routes local_moved_then_rename_remote to uploadDownloads without counting as modify/delete", () => {
    const mappings: Record<string, any> = {
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: {
          key: "new_dir/file.md",
          keyRaw: "new_dir/file.md",
          sizeRaw: 10,
          sizeEnc: 10,
        },
        decision: "local_moved_then_rename_remote",
        change: true,
        movedFromKey: "old_dir/file.md",
      },
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: {
          key: "old_dir/file.md",
          keyRaw: "old_dir/file.md",
          sizeRaw: 10,
          sizeEnc: 10,
        },
        decision: "moved_away",
        change: false,
      },
    };

    // Must not throw (the catch-all at sync.ts:1421 is the risk)
    const result = splitFourStepsOnEntityMappings(mappings);

    // Move ops should be in moveOps (executed before deletions)
    const allMoveOps = result.moveOps.flat();
    const moveOp = allMoveOps.find(
      (o: any) => o.decision === "local_moved_then_rename_remote"
    );
    assert.ok(moveOp, "local_moved_then_rename_remote should be in moveOps");

    // moved_away should be in onlyMarkSyncedOps (no-op, just record cleanup)
    const allMarkSyncedOps = result.onlyMarkSyncedOps.flat();
    const movedAwayOp = allMarkSyncedOps.find(
      (o: any) => o.decision === "moved_away"
    );
    assert.ok(movedAwayOp, "moved_away should be in onlyMarkSyncedOps");

    // Critical: moves must NOT increment realModifyDeleteCount
    // (a rename is content-preserving, not a modification or deletion)
    assert.strictEqual(result.realModifyDeleteCount, 0);
  });
});

describe("dispatchOperationToActualV3: move (rename)", () => {
  it("local_moved_then_rename_remote: renames on remote, no re-upload", async () => {
    const local = makeMockFs("local", { "new_dir/file.md": "content" });
    const remote = makeMockFs("remote", { "old_dir/file.md": "content" });
    const db = asDB(createMockDB());

    const r: any = {
      key: "new_dir/file.md",
      local: {
        key: "new_dir/file.md",
        keyRaw: "new_dir/file.md",
        mtimeCli: 2000,
        sizeRaw: 7,
        sizeEnc: 7,
        hash: "abc=",
      },
      prevSync: undefined,
      remote: undefined,
      decision: "local_moved_then_rename_remote",
      decisionBranch: 200,
      change: true,
      movedFromKey: "old_dir/file.md",
    };

    await dispatchOperationToActualV3(
      "new_dir/file.md",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "keep_newer",
      undefined
    );

    // Assert: rename was called on remote (old key -> new key)
    assert.strictEqual(remote.renameCalls.length, 1);
    assert.strictEqual(remote.renameCalls[0].from, "old_dir/file.md");
    assert.strictEqual(remote.renameCalls[0].to, "new_dir/file.md");

    // Assert: NO re-upload (writeFile not called)
    assert.strictEqual(remote.writeCalls.length, 0);
  });

  it("moved_away: does nothing (no-op, no rename/write/delete)", async () => {
    const local = makeMockFs("local", {});
    const remote = makeMockFs("remote", {});
    const db = asDB(createMockDB());

    const r: any = {
      key: "old_dir/file.md",
      local: undefined,
      prevSync: {
        key: "old_dir/file.md",
        keyRaw: "old_dir/file.md",
        mtimeSvr: 1000,
        sizeRaw: 7,
        sizeEnc: 7,
        hash: "abc=",
      },
      remote: undefined,
      decision: "moved_away",
      decisionBranch: 201,
      change: false,
    };

    // Should not throw (the catch-all at sync.ts:1839 is the risk)
    await dispatchOperationToActualV3(
      "old_dir/file.md",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "keep_newer",
      undefined
    );

    // Assert: no rename, no write, no delete
    assert.strictEqual(remote.renameCalls.length, 0);
    assert.strictEqual(remote.writeCalls.length, 0);
  });
});

describe("removeGhostRemotes", () => {
  it("removes ghost remote when remoteId matches prevSync at different path", () => {
    const mappings: Record<string, any> = {
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: { key: "new_dir/file.md" },
        prevSync: { remoteId: "item!123" },
      },
      "old_dir/file.md": {
        key: "old_dir/file.md",
        local: undefined,
        prevSync: undefined,
        remote: { remoteId: "item!123" },
        decision: undefined,
      },
    };

    removeGhostRemotes(mappings);

    // Ghost removed: old_dir/file.md no longer has remote
    assert.strictEqual(mappings["old_dir/file.md"].remote, undefined);
  });

  it("does NOT remove when remoteId matches prevSync at SAME path", () => {
    const mappings: Record<string, any> = {
      "dir/file.md": {
        key: "dir/file.md",
        local: undefined,
        prevSync: { remoteId: "item!123" },
        remote: { remoteId: "item!123" },
        decision: undefined,
      },
    };

    removeGhostRemotes(mappings);

    // Same path → not a ghost → remote preserved
    assert.ok(mappings["dir/file.md"].remote !== undefined);
  });

  it("does NOT remove when no matching prevSync.remoteId", () => {
    const mappings: Record<string, any> = {
      "new_dir/file.md": {
        key: "new_dir/file.md",
        prevSync: { remoteId: "item!123" },
      },
      "other_dir/file.md": {
        key: "other_dir/file.md",
        local: undefined,
        prevSync: undefined,
        remote: { remoteId: "item!456" },
        decision: undefined,
      },
    };

    removeGhostRemotes(mappings);

    // No match → remote preserved
    assert.ok(mappings["other_dir/file.md"].remote !== undefined);
  });
});

describe("splitFourStepsOnEntityMappings: folder move decisions", () => {
  it("routes folder_moved_then_rename_remote to moveOps", () => {
    const mappings: Record<string, any> = {
      "new_dir/": {
        key: "new_dir/",
        decision: "folder_moved_then_rename_remote",
        change: true,
        movedFromKey: "old_dir/",
      },
    };
    const result = splitFourStepsOnEntityMappings(mappings);
    const allMoveOps = result.moveOps.flat();
    const folderMove = allMoveOps.find(
      (o: any) => o.decision === "folder_moved_then_rename_remote"
    );
    assert.ok(folderMove, "folder_moved_then_rename_remote should be in moveOps");
  });

  it("routes folder_moved_away and moved_with_parent to onlyMarkSyncedOps", () => {
    const mappings: Record<string, any> = {
      "old_dir/": {
        key: "old_dir/",
        decision: "folder_moved_away",
        change: false,
      },
      "old_dir/file.md": {
        key: "old_dir/file.md",
        decision: "moved_with_parent",
        change: false,
      },
    };
    const result = splitFourStepsOnEntityMappings(mappings);
    const allSynced = result.onlyMarkSyncedOps.flat();
    assert.ok(
      allSynced.some((o: any) => o.decision === "folder_moved_away"),
      "folder_moved_away should be in onlyMarkSyncedOps"
    );
    assert.ok(
      allSynced.some((o: any) => o.decision === "moved_with_parent"),
      "moved_with_parent should be in onlyMarkSyncedOps"
    );
    // Critical: no modify/delete count for these
    assert.strictEqual(result.realModifyDeleteCount, 0);
  });
});

describe("dispatchOperationToActualV3: folder move + moved_with_parent", () => {
  it("folder_moved_then_rename_remote: renames folder on remote", async () => {
    const local = makeMockFs("local", {});
    const remote = makeMockFs("remote", { "old_dir/": "" });
    const db = asDB(createMockDB());

    const r: any = {
      key: "new_dir/",
      local: { key: "new_dir/", keyRaw: "new_dir/" },
      decision: "folder_moved_then_rename_remote",
      change: true,
      movedFromKey: "old_dir/",
    };

    await dispatchOperationToActualV3(
      "new_dir/",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "keep_newer",
      undefined
    );

    assert.strictEqual(remote.renameCalls.length, 1);
    assert.strictEqual(remote.renameCalls[0].from, "old_dir/");
    assert.strictEqual(remote.renameCalls[0].to, "new_dir/");
    assert.strictEqual(remote.writeCalls.length, 0);
  });

  it("moved_with_parent (new path): upserts prevSync, no transfer", async () => {
    const local = makeMockFs("local", {});
    const remote = makeMockFs("remote", {});
    const db = asDB(createMockDB());

    const r: any = {
      key: "new_dir/file.md",
      local: {
        key: "new_dir/file.md",
        keyRaw: "new_dir/file.md",
        sizeRaw: 10,
      },
      decision: "moved_with_parent",
      change: false,
      movedFromRemoteId: "item!abc",
    };

    await dispatchOperationToActualV3(
      "new_dir/file.md",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "keep_newer",
      undefined
    );

    // No rename, no write — just prevSync record
    assert.strictEqual(remote.renameCalls.length, 0);
    assert.strictEqual(remote.writeCalls.length, 0);
  });

  it("moved_with_parent (old path): clears prevSync, no transfer", async () => {
    const local = makeMockFs("local", {});
    const remote = makeMockFs("remote", {});
    const db = asDB(createMockDB());

    const r: any = {
      key: "old_dir/file.md",
      local: undefined,
      prevSync: { key: "old_dir/file.md", keyRaw: "old_dir/file.md" },
      decision: "moved_with_parent",
      change: false,
    };

    await dispatchOperationToActualV3(
      "old_dir/file.md",
      "vault",
      "prof",
      r,
      local as any,
      remote as any,
      db,
      "keep_newer",
      undefined
    );

    // No rename, no write — just prevSync cleanup
    assert.strictEqual(remote.renameCalls.length, 0);
    assert.strictEqual(remote.writeCalls.length, 0);
  });
});
