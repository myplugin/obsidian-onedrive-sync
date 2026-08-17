// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import { mergeDeltaWithPrevState } from "../src/deltaMerge";

function makeEntity(key: string, mtime?: number, size?: number): Entity {
  return {
    key: key,
    keyRaw: key,
    mtimeSvr: mtime ?? 1000,
    mtimeCli: mtime ?? 1000,
    size: size ?? 100,
    sizeRaw: size ?? 100,
  };
}

describe("deltaMerge", () => {
  it("should return delta entities when prev is empty (initial sync)", () => {
    const prev: Entity[] = [];
    const delta = [makeEntity("a.md"), makeEntity("b.md")];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 2);
    assert.ok(result.some((e) => e.keyRaw === "a.md"));
    assert.ok(result.some((e) => e.keyRaw === "b.md"));
  });

  it("should return empty when prev and delta are empty", () => {
    const result = mergeDeltaWithPrevState([], [], new Set());
    assert.strictEqual(result.length, 0);
  });

  it("should add new items from delta to prev", () => {
    const prev = [makeEntity("a.md")];
    const delta = [makeEntity("b.md")];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 2);
    assert.ok(result.some((e) => e.keyRaw === "a.md"));
    assert.ok(result.some((e) => e.keyRaw === "b.md"));
  });

  it("should update modified items from delta", () => {
    const prev = [makeEntity("a.md", 1000, 100)];
    const delta = [makeEntity("a.md", 2000, 200)];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].mtimeSvr, 2000);
    assert.strictEqual(result[0].size, 200);
  });

  it("should remove items marked as deleted", () => {
    const prev = [makeEntity("a.md"), makeEntity("b.md")];
    const delta: Entity[] = [];
    const deleted = new Set<string>(["b.md"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 1);
    assert.ok(result.some((e) => e.keyRaw === "a.md"));
    assert.ok(!result.some((e) => e.keyRaw === "b.md"));
  });

  it("should handle add + modify + delete together", () => {
    const prev = [
      makeEntity("a.md", 1000),
      makeEntity("b.md", 1000),
      makeEntity("c.md", 1000),
    ];
    const delta = [makeEntity("a.md", 2000), makeEntity("d.md", 3000)];
    const deleted = new Set<string>(["c.md"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 3);
    const a = result.find((e) => e.keyRaw === "a.md");
    const b = result.find((e) => e.keyRaw === "b.md");
    const c = result.find((e) => e.keyRaw === "c.md");
    const d = result.find((e) => e.keyRaw === "d.md");

    assert.ok(a);
    assert.strictEqual(a!.mtimeSvr, 2000); // updated
    assert.ok(b); // unchanged
    assert.ok(!c); // deleted
    assert.ok(d); // added
  });

  it("should handle folder entities (keys ending with /)", () => {
    const prev = [makeEntity("folder/"), makeEntity("folder/a.md")];
    const delta = [makeEntity("folder2/")];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 3);
  });

  it("should delete a folder by key", () => {
    const prev = [makeEntity("folder/"), makeEntity("folder/a.md")];
    const delta: Entity[] = [];
    const deleted = new Set<string>(["folder/"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    // Only the folder key is deleted from the map; its children remain
    // (the OneDrive delta API only marks the folder itself as @removed,
    // not each child). The sync algorithm detects the missing folder and
    // treats children as effectively deleted.
    assert.strictEqual(result.length, 1);
    assert.ok(result.some((e) => e.keyRaw === "folder/a.md"));
  });

  it("should skip root entity (keyRaw === '/')", () => {
    const prev = [makeEntity("a.md")];
    const delta = [makeEntity("/"), makeEntity("b.md")];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 2);
    assert.ok(!result.some((e) => e.keyRaw === "/"));
  });

  it("should skip entities with empty keyRaw", () => {
    const prev = [makeEntity("a.md")];
    const emptyEntity: Entity = { keyRaw: "", sizeRaw: 0 };
    const delta = [emptyEntity, makeEntity("b.md")];
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 2);
    assert.ok(!result.some((e) => e.keyRaw === ""));
  });

  it("should handle full re-enumeration after deltaLink expiry", () => {
    // When the deltaLink expires, Graph API returns ALL current items
    // plus @removed entries for items deleted since the last sync.
    // The merge must produce the correct current state.
    const prev = [makeEntity("a.md"), makeEntity("deleted.md")];
    const delta = [makeEntity("a.md", 2000), makeEntity("b.md")];
    const deleted = new Set<string>(["deleted.md"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 2);
    assert.ok(result.some((e) => e.keyRaw === "a.md"));
    assert.ok(result.some((e) => e.keyRaw === "b.md"));
    assert.ok(!result.some((e) => e.keyRaw === "deleted.md"));
  });

  it("should not duplicate items when delta includes unchanged items", () => {
    const prev = [makeEntity("a.md", 1000)];
    const delta = [makeEntity("a.md", 1000)]; // same data
    const deleted = new Set<string>();

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 1);
  });

  it("should handle deleting a non-existent key gracefully", () => {
    const prev = [makeEntity("a.md")];
    const delta: Entity[] = [];
    const deleted = new Set<string>(["never-existed.md"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 1); // no crash, prev item still there
  });

  it("should handle nested folder paths", () => {
    const prev = [
      makeEntity("a/b/c.md"),
      makeEntity("a/b/d.md"),
      makeEntity("x/y.md"),
    ];
    const delta = [makeEntity("a/b/e.md", 5000)];
    const deleted = new Set<string>(["x/y.md"]);

    const result = mergeDeltaWithPrevState(prev, delta, deleted);

    assert.strictEqual(result.length, 3);
    assert.ok(result.some((e) => e.keyRaw === "a/b/c.md"));
    assert.ok(result.some((e) => e.keyRaw === "a/b/d.md"));
    assert.ok(result.some((e) => e.keyRaw === "a/b/e.md"));
    assert.ok(!result.some((e) => e.keyRaw === "x/y.md"));
  });
});
