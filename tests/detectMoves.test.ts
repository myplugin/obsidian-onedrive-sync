// License: Apache-2.0 (see src/LICENSE)
// Tests for matchMoves — the pure move-detection logic that runs after
// ensembleMixedEnties and before getSyncPlanInplace. matchMoves is a PURE
// function: no I/O, no side effects beyond mutating the input map (stamping
// move decisions on matched pairs). Local file hashes must be pre-populated
// on Entity.hash before calling — in production, detectMoves() computes
// them via quickXorHash; here we inject them directly.

import "./_globalsSetup";
import "./_obsidianStub";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import type { MixedEntity } from "../src/baseTypes";
import { matchFolderMoves, matchMoves } from "../src/sync";

function makeEntity(opts: {
  key: string;
  hash?: string;
  size?: number;
}): any {
  return {
    key: opts.key,
    keyRaw: opts.key,
    size: opts.size ?? 10,
    sizeRaw: opts.size ?? 10,
    sizeEnc: opts.size ?? 10,
    hash: opts.hash,
    mtimeCli: 1000,
    mtimeSvr: 1000,
  };
}

describe("matchMoves", () => {
  it("matches a moved file by hash+size and stamps move decisions", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "abc=",
          size: 10,
        }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 10 }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(
      mappings["new_dir/file.md"].decision,
      "local_moved_then_rename_remote"
    );
    assert.strictEqual(mappings["old_dir/file.md"].decision, "moved_away");
    assert.strictEqual(
      mappings["new_dir/file.md"].movedFromKey,
      "old_dir/file.md"
    );
  });

  it("does NOT match when hash differs", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "aaa=",
          size: 10,
        }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "bbb=", size: 10 }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(mappings["new_dir/file.md"].decision, undefined);
    assert.strictEqual(mappings["old_dir/file.md"].decision, undefined);
  });

  it("does NOT match when size differs (same hash)", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "abc=",
          size: 10,
        }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 20 }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(mappings["new_dir/file.md"].decision, undefined);
    assert.strictEqual(mappings["old_dir/file.md"].decision, undefined);
  });

  it("does nothing when trackRenames=false", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "abc=",
          size: 10,
        }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 10 }),
      },
    };

    matchMoves(mappings, false);

    assert.strictEqual(mappings["new_dir/file.md"].decision, undefined);
    assert.strictEqual(mappings["old_dir/file.md"].decision, undefined);
  });

  it("skips folders (keys ending with /)", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/": {
        key: "old_dir/",
        prevSync: makeEntity({ key: "old_dir/", hash: undefined, size: 0 }),
      },
      "new_dir/": {
        key: "new_dir/",
        local: makeEntity({ key: "new_dir/", hash: undefined, size: 0 }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(mappings["new_dir/"].decision, undefined);
    assert.strictEqual(mappings["old_dir/"].decision, undefined);
  });

  it("does NOT match pure deletes (no created counterpart)", () => {
    // A pure delete: file existed in prevSync, deleted locally, no new file appeared
    const mappings: Record<string, MixedEntity> = {
      "deleted_file.md": {
        key: "deleted_file.md",
        prevSync: makeEntity({
          key: "deleted_file.md",
          hash: "abc=",
          size: 10,
        }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(mappings["deleted_file.md"].decision, undefined);
  });

  it("matches multiple pairs correctly and does not cross-match", () => {
    const mappings: Record<string, MixedEntity> = {
      "old/a.md": {
        key: "old/a.md",
        prevSync: makeEntity({ key: "old/a.md", hash: "hashA=", size: 10 }),
      },
      "old/b.md": {
        key: "old/b.md",
        prevSync: makeEntity({ key: "old/b.md", hash: "hashB=", size: 20 }),
      },
      "new/a.md": {
        key: "new/a.md",
        local: makeEntity({ key: "new/a.md", hash: "hashA=", size: 10 }),
      },
      "new/b.md": {
        key: "new/b.md",
        local: makeEntity({ key: "new/b.md", hash: "hashB=", size: 20 }),
      },
    };

    matchMoves(mappings, true);

    assert.strictEqual(
      mappings["new/a.md"].decision,
      "local_moved_then_rename_remote"
    );
    assert.strictEqual(mappings["new/a.md"].movedFromKey, "old/a.md");
    assert.strictEqual(mappings["old/a.md"].decision, "moved_away");
    assert.strictEqual(
      mappings["new/b.md"].decision,
      "local_moved_then_rename_remote"
    );
    assert.strictEqual(mappings["new/b.md"].movedFromKey, "old/b.md");
    assert.strictEqual(mappings["old/b.md"].decision, "moved_away");
  });

  it("does not match when source hash is undefined (encrypted prevSync)", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: undefined,
          size: 10,
        }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 10 }),
      },
    };

    matchMoves(mappings, true);

    // Source hash undefined → cannot match → no move detected
    assert.strictEqual(mappings["new_dir/file.md"].decision, undefined);
    assert.strictEqual(mappings["old_dir/file.md"].decision, undefined);
  });
});

describe("matchFolderMoves", () => {
  // Helper: build a post-matchMoves state where files have already been
  // matched (decision = "moved_away" on old path, "local_moved_then_rename_remote"
  // on new path with movedFromKey set).
  function buildMovedState(): Record<string, MixedEntity> {
    return {
      "old_dir/": {
        key: "old_dir/",
        remote: makeEntity({ key: "old_dir/", hash: undefined, size: 0 }),
      },
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "abc=",
          size: 10,
        }),
        decision: "moved_away",
        decisionBranch: 201,
        change: false,
      },
      "new_dir/": {
        key: "new_dir/",
        local: makeEntity({ key: "new_dir/", hash: undefined, size: 0 }),
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 10 }),
        decision: "local_moved_then_rename_remote",
        decisionBranch: 200,
        change: true,
        movedFromKey: "old_dir/file.md",
      },
    };
  }

  it("detects folder move from file moves and converts files to moved_with_parent", () => {
    const mappings = buildMovedState();
    matchFolderMoves(mappings);

    assert.strictEqual(mappings["old_dir/"].decision, "folder_moved_away");
    assert.strictEqual(
      mappings["new_dir/"].decision,
      "folder_moved_then_rename_remote"
    );
    assert.strictEqual(mappings["new_dir/"].movedFromKey, "old_dir/");
    assert.strictEqual(
      mappings["old_dir/file.md"].decision,
      "moved_with_parent"
    );
    assert.strictEqual(
      mappings["new_dir/file.md"].decision,
      "moved_with_parent"
    );
  });

  it("does NOT do folder move when not all old-path files are matched", () => {
    const mappings = buildMovedState();
    // Add an unmatched old-path file (decision undefined = not moved)
    mappings["old_dir/unmatched.md"] = {
      key: "old_dir/unmatched.md",
      prevSync: makeEntity({
        key: "old_dir/unmatched.md",
        hash: "zzz=",
        size: 99,
      }),
      // decision is undefined → not matched as a move
    };

    matchFolderMoves(mappings);

    // Folder move should NOT have happened — decisions unchanged
    assert.strictEqual(mappings["old_dir/"].decision, undefined);
    assert.strictEqual(mappings["new_dir/"].decision, undefined);
    assert.strictEqual(mappings["old_dir/file.md"].decision, "moved_away");
    assert.strictEqual(
      mappings["new_dir/file.md"].decision,
      "local_moved_then_rename_remote"
    );
  });

  it("does nothing when there are no file moves", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/": {
        key: "old_dir/",
        remote: makeEntity({ key: "old_dir/", hash: undefined, size: 0 }),
      },
      "new_dir/": {
        key: "new_dir/",
        local: makeEntity({ key: "new_dir/", hash: undefined, size: 0 }),
      },
    };

    matchFolderMoves(mappings);

    // No file moves → no folder pairs → no changes
    assert.strictEqual(mappings["old_dir/"].decision, undefined);
    assert.strictEqual(mappings["new_dir/"].decision, undefined);
  });

  it("does NOT do folder move when folders are not in the map", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/file.md": {
        key: "old_dir/file.md",
        prevSync: makeEntity({
          key: "old_dir/file.md",
          hash: "abc=",
          size: 10,
        }),
        decision: "moved_away",
        decisionBranch: 201,
        change: false,
      },
      "new_dir/file.md": {
        key: "new_dir/file.md",
        local: makeEntity({ key: "new_dir/file.md", hash: "abc=", size: 10 }),
        decision: "local_moved_then_rename_remote",
        decisionBranch: 200,
        change: true,
        movedFromKey: "old_dir/file.md",
      },
      // NO "old_dir/" or "new_dir/" folder entries
    };

    matchFolderMoves(mappings);

    // Folders not in map → no folder pair → no changes
    assert.strictEqual(mappings["old_dir/file.md"].decision, "moved_away");
    assert.strictEqual(
      mappings["new_dir/file.md"].decision,
      "local_moved_then_rename_remote"
    );
  });

  it("marks new-path subfolders as moved_with_parent only if old-path equivalent exists", () => {
    const mappings: Record<string, MixedEntity> = {
      "old_dir/": {
        key: "old_dir/",
        remote: makeEntity({ key: "old_dir/", size: 0 }),
      },
      "old_dir/sub/": {
        key: "old_dir/sub/",
        remote: makeEntity({ key: "old_dir/sub/", size: 0 }),
      },
      "old_dir/sub/file.md": {
        key: "old_dir/sub/file.md",
        prevSync: makeEntity({
          key: "old_dir/sub/file.md",
          hash: "abc=",
          size: 10,
        }),
        decision: "moved_away",
        decisionBranch: 201,
        change: false,
      },
      "new_dir/": {
        key: "new_dir/",
        local: makeEntity({ key: "new_dir/", size: 0 }),
      },
      "new_dir/sub/": {
        key: "new_dir/sub/",
        local: makeEntity({ key: "new_dir/sub/", size: 0 }),
      },
      "new_dir/sub/file.md": {
        key: "new_dir/sub/file.md",
        local: makeEntity({
          key: "new_dir/sub/file.md",
          hash: "abc=",
          size: 10,
        }),
        decision: "local_moved_then_rename_remote",
        decisionBranch: 200,
        change: true,
        movedFromKey: "old_dir/sub/file.md",
      },
      // A NEW subfolder (no old-path equivalent) — should NOT be marked
      "new_dir/newsub/": {
        key: "new_dir/newsub/",
        local: makeEntity({ key: "new_dir/newsub/", size: 0 }),
      },
    };

    matchFolderMoves(mappings);

    // The root folder pair is old_dir/sub/ → new_dir/sub/ (from file moves)
    assert.strictEqual(mappings["old_dir/sub/"].decision, "folder_moved_away");
    assert.strictEqual(
      mappings["new_dir/sub/"].decision,
      "folder_moved_then_rename_remote"
    );
    // new_dir/newsub/ has no old-path equivalent → NOT marked (will be created normally)
    assert.strictEqual(mappings["new_dir/newsub/"].decision, undefined);
  });
});
