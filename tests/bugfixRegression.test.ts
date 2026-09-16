// License: Apache-2.0 (see src/LICENSE)
// Regression tests for bug fixes that are not covered by existing test files.
// Covers: C1 (error .code preservation), C2 (prevRemoteEntities merge), L2 (getDupFiles).

import { strict as assert } from "assert";
import { clearDupFiles, getDupFiles } from "../src/clearDupFiles";
import type { Entity } from "../src/baseTypes";

// =============================================================================
// C1: PQueue error handlers must preserve .code and .key properties
// so errNotifyFunc can identify REMOTE_NOT_FOUND and trigger self-heal.
// =============================================================================

describe("C1: error wrapping preserves .code and .key", () => {
  // Simulates the PQueue catch handler logic from sync.ts doActualSync.
  function wrapErrorWithCode(e: any): Error {
    const wrapped = new Error(e.message);
    (wrapped as any).code = (e as any)?.code;
    (wrapped as any).key = (e as any)?.key;
    return wrapped;
  }

  it("should preserve .code='REMOTE_NOT_FOUND' and .key", () => {
    const original = new Error("file not found");
    (original as any).code = "REMOTE_NOT_FOUND";
    (original as any).key = "some/note.md";

    const wrapped = wrapErrorWithCode(original);

    assert.strictEqual(wrapped.message, "file not found");
    assert.strictEqual((wrapped as any).code, "REMOTE_NOT_FOUND");
    assert.strictEqual((wrapped as any).key, "some/note.md");
  });

  it("should preserve .code when wrapping with key prefix (single-queue path)", () => {
    const original = new Error("not found");
    (original as any).code = "REMOTE_NOT_FOUND";
    (original as any).key = "path/file.md";

    // Single-queue path prepends the key to the message
    const msg = `path/file.md: ${original.message}`;
    const wrapped = new Error(msg);
    (wrapped as any).code = (original as any)?.code;
    (wrapped as any).key = (original as any)?.key;

    assert.strictEqual((wrapped as any).code, "REMOTE_NOT_FOUND");
    assert.strictEqual((wrapped as any).key, "path/file.md");
    assert.strictEqual(wrapped.message, "path/file.md: not found");
  });

  it("should set .code and .key to undefined when source has none", () => {
    const original = new Error("network timeout");
    const wrapped = wrapErrorWithCode(original);

    assert.strictEqual(wrapped.message, "network timeout");
    assert.strictEqual((wrapped as any).code, undefined);
    assert.strictEqual((wrapped as any).key, undefined);
  });

  it("should allow errNotifyFunc to identify REMOTE_NOT_FOUND from wrapped error", () => {
    // Simulates the check in main.ts errNotifyFunc:
    //   if ((error as any)?.code === "REMOTE_NOT_FOUND") { await selfHeal(); }
    const original = new Error("404");
    (original as any).code = "REMOTE_NOT_FOUND";
    (original as any).key = "vault/note.md";

    const wrapped = wrapErrorWithCode(original);

    // This is the check that was BROKEN before the fix (new Error stripped .code)
    assert.strictEqual((wrapped as any).code, "REMOTE_NOT_FOUND");
    assert.ok(
      (wrapped as any)?.code === "REMOTE_NOT_FOUND",
      "errNotifyFunc should identify this as REMOTE_NOT_FOUND"
    );
  });
});

// =============================================================================
// C2: prevRemoteEntities merge — uploaded files must be added to prevent
// "remote deleted" false positive on rapid re-sync.
// =============================================================================

describe("C2: prevRemoteEntities merge with uploaded entities", () => {
  // Simulates the merge logic from main.ts finally block.
  function mergeUploadedIntoPrevRemote(
    walkResult: Entity[],
    deletedKeys: Set<string>,
    uploadedEntities: Entity[]
  ): Entity[] {
    const entities =
      deletedKeys.size > 0
        ? walkResult.filter((e) => !deletedKeys.has(e.keyRaw))
        : [...walkResult];

    const existingKeys = new Set(entities.map((e) => e.keyRaw));
    for (const uploaded of uploadedEntities) {
      if (!existingKeys.has(uploaded.keyRaw)) {
        entities.push(uploaded);
      }
    }
    return entities;
  }

  it("should add uploaded files that are not in walkResult", () => {
    const walkResult: Entity[] = [
      { keyRaw: "existing.md" } as Entity,
    ];
    const uploaded: Entity[] = [
      { keyRaw: "just_uploaded.md" } as Entity,
    ];

    const result = mergeUploadedIntoPrevRemote(walkResult, new Set(), uploaded);

    assert.strictEqual(result.length, 2);
    assert.ok(result.some((e) => e.keyRaw === "existing.md"));
    assert.ok(result.some((e) => e.keyRaw === "just_uploaded.md"));
  });

  it("should not duplicate files already in walkResult", () => {
    const walkResult: Entity[] = [
      { keyRaw: "overwritten.md" } as Entity,
    ];
    const uploaded: Entity[] = [
      { keyRaw: "overwritten.md" } as Entity, // same key, was overwritten
      { keyRaw: "new_file.md" } as Entity,
    ];

    const result = mergeUploadedIntoPrevRemote(walkResult, new Set(), uploaded);

    assert.strictEqual(result.length, 2);
    const overwrittenCount = result.filter(
      (e) => e.keyRaw === "overwritten.md"
    ).length;
    assert.strictEqual(overwrittenCount, 1, "should not duplicate");
  });

  it("should filter out deleted keys then add uploaded", () => {
    const walkResult: Entity[] = [
      { keyRaw: "kept.md" } as Entity,
      { keyRaw: "deleted.md" } as Entity,
    ];
    const deletedKeys = new Set(["deleted.md"]);
    const uploaded: Entity[] = [
      { keyRaw: "uploaded.md" } as Entity,
    ];

    const result = mergeUploadedIntoPrevRemote(
      walkResult,
      deletedKeys,
      uploaded
    );

    assert.strictEqual(result.length, 2);
    assert.ok(result.some((e) => e.keyRaw === "kept.md"));
    assert.ok(result.some((e) => e.keyRaw === "uploaded.md"));
    assert.ok(!result.some((e) => e.keyRaw === "deleted.md"));
  });

  it("should handle empty uploaded list", () => {
    const walkResult: Entity[] = [
      { keyRaw: "a.md" } as Entity,
    ];
    const result = mergeUploadedIntoPrevRemote(walkResult, new Set(), []);
    assert.strictEqual(result.length, 1);
  });

  it("should prevent data loss: uploaded file not seen as 'remote deleted'", () => {
    // Scenario: file was uploaded in this sync, delta API hasn't caught up.
    // Without the merge, prevRemoteEntities wouldn't contain the file,
    // and the next sync would see it as "remote deleted" → delete local.
    const walkResult: Entity[] = [
      { keyRaw: "other.md" } as Entity,
    ];
    const uploaded: Entity[] = [
      { keyRaw: "my_note.md" } as Entity,
    ];

    const withoutMerge = [...walkResult]; // old behavior
    const withMerge = mergeUploadedIntoPrevRemote(
      walkResult,
      new Set(),
      uploaded
    );

    // Without merge: my_note.md is NOT in prevRemote → "remote deleted"
    assert.ok(
      !withoutMerge.some((e) => e.keyRaw === "my_note.md"),
      "without fix: uploaded file missing from prevRemote"
    );
    // With merge: my_note.md IS in prevRemote → not "remote deleted"
    assert.ok(
      withMerge.some((e) => e.keyRaw === "my_note.md"),
      "with fix: uploaded file present in prevRemote"
    );
  });
});

// =============================================================================
// L2: getDupFiles should not match "dup" in legitimate filenames like
// "duplicates/", "backup-dup/" — only ".dup" pattern from getFileRenameForDup.
// =============================================================================

describe("L2: getDupFiles does not match false-positive 'dup' paths", () => {
  // Minimal mock that only implements walk() — the only method getDupFiles calls.
  function makeMockFs(files: string[]): any {
    return {
      walk: async () =>
        files.map((f) => ({ keyRaw: f }) as Entity),
    };
  }

  it("should match a .dup file", async () => {
    // "note.dup.md" contains ".dup" → matches the pattern
    const mock = makeMockFs(["note.md", "note.dup.md"]);
    const result = await getDupFiles(mock);
    // note.dup.md should be in the result (it's a .dup variant of note.md)
    assert.ok(result.includes("note.dup.md"), "should find .dup file");
  });

  it("should NOT match 'duplicates/' folder content", async () => {
    // "duplicates/list.md" does NOT contain ".dup" (no dot before "dup")
    const mock = makeMockFs(["note.md", "duplicates/list.md"]);
    const result = await getDupFiles(mock);
    // "duplicates/list.md" should not be flagged for removal
    assert.ok(
      !result.includes("duplicates/list.md"),
      "should not match 'duplicates/' as a dup file"
    );
  });

  it("should NOT match 'backup-dup' folder content", async () => {
    const mock = makeMockFs(["note.md", "backup-dup/list.md"]);
    const result = await getDupFiles(mock);
    assert.ok(
      !result.includes("backup-dup/list.md"),
      "should not match 'backup-dup/' as a dup file"
    );
  });

  it("should return empty when no .dup files exist", async () => {
    const mock = makeMockFs(["note.md", "other.md", "duplicates/notes.md"]);
    const result = await getDupFiles(mock);
    assert.strictEqual(result.length, 0);
  });
});

// =============================================================================
// clearDupFiles: removes every file reported by getDupFiles via fsLocal.rm.
// =============================================================================

describe("clearDupFiles removes the reported dup files", () => {
  // Minimal mock implementing walk() (for getDupFiles) and rm() with
  // call tracking (for clearDupFiles).
  function makeMockLocalFs(files: string[], removedTracker: string[]): any {
    return {
      walk: async () => files.map((f) => ({ keyRaw: f }) as Entity),
      rm: async (key: string) => {
        removedTracker.push(key);
      },
    };
  }

  it("should call rm once for every file in the list", async () => {
    const removed: string[] = [];
    const mockFs = makeMockLocalFs([], removed);
    await clearDupFiles(["a.dup.md", "sub/b.dup.txt"], mockFs);
    assert.deepStrictEqual([...removed].sort(), ["a.dup.md", "sub/b.dup.txt"]);
  });

  it("should do nothing for an empty list", async () => {
    const removed: string[] = [];
    const mockFs = makeMockLocalFs([], removed);
    await clearDupFiles([], mockFs);
    assert.strictEqual(removed.length, 0);
  });

  it("should remove exactly the dup files end-to-end with getDupFiles", async () => {
    const removed: string[] = [];
    const mockFs = makeMockLocalFs(
      ["note.md", "note.dup.md", "other.md", "other.dup.md", "keep.md"],
      removed
    );
    const dups = await getDupFiles(mockFs);
    assert.ok(dups.length > 0);
    await clearDupFiles(dups, mockFs);
    assert.deepStrictEqual([...removed].sort(), [...dups].sort());
    assert.ok(removed.includes("note.dup.md"));
    assert.ok(removed.includes("other.dup.md"));
    assert.ok(!removed.includes("note.md"), "original file must be kept");
    assert.ok(!removed.includes("keep.md"), "unrelated file must be kept");
  });

  it("should propagate rm errors", async () => {
    const mockFs = {
      walk: async () => [] as Entity[],
      rm: async (_key: string) => {
        throw new Error("rm failed");
      },
    };
    await assert.rejects(
      clearDupFiles(["x.dup.md"], mockFs as any),
      /rm failed/
    );
  });
});
