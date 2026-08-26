// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import { classifyDeltaItems, mergeDeltaWithPrevState } from "../src/deltaMerge";

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

describe("classifyDeltaItems", () => {
  // Mock fromDriveItemToEntity: treats item.key as the entity keyRaw.
  // Real converter parses parentReference.path; for classification tests
  // we only care that the right branch (deleted vs added) is taken and
  // the converter is invoked with the right requireMtime flag.
  const mockConverter = (
    item: any,
    _remoteBaseDir: string,
    _requireMtime?: boolean
  ): Entity => {
    return makeEntity(item.key, item.mtime, item.size);
  };

  it("classifies @removed items as deleted", () => {
    const items = [
      { key: "a.md", mtime: 1000 },
      { key: "b.md", mtime: 1000, "@removed": { reason: "deleted" } },
    ];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "a.md");
    assert.strictEqual(deletedKeys.size, 1);
    assert.ok(deletedKeys.has("b.md"));
  });

  // REGRESSION: this is the exact bug that caused the reported 404
  // AggregateError. Graph sometimes signals deletion via the `deleted`
  // facet on the DriveItem WITHOUT the @removed annotation. The previous
  // implementation only checked `@removed`, so these items were treated
  // as live files, kept in prevRemoteEntities, and sync later tried to
  // download/stat them → HTTP 404.
  it("classifies items with the `deleted` facet (no @removed) as deleted", () => {
    const items = [
      { key: "a.md", mtime: 1000 },
      { key: "ghost.md", mtime: 1000, deleted: {} },
    ];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "a.md");
    assert.ok(deletedKeys.has("ghost.md"));
    assert.ok(!deltaEntities.some((e) => e.keyRaw === "ghost.md"));
  });

  it("classifies items with both markers as deleted", () => {
    const items = [
      {
        key: "x.md",
        "@removed": { reason: "deleted" },
        deleted: {},
      },
    ];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deltaEntities.length, 0);
    assert.ok(deletedKeys.has("x.md"));
  });

  it("passes requireMtime=false to the converter for deleted items", () => {
    // Deleted delta items often lack fileSystemInfo; the converter must
    // be told not to require mtime, else it throws and the deletion is
    // silently dropped (re-introducing the stale-entry bug).
    let seenRequireMtime: boolean | undefined;
    const trackingConverter = (
      _item: any,
      _remoteBaseDir: string,
      requireMtime?: boolean
    ): Entity => {
      seenRequireMtime = requireMtime;
      return makeEntity("ghost.md");
    };
    const items = [{ key: "ghost.md", deleted: {} }];
    classifyDeltaItems(items, "vault", trackingConverter);

    assert.strictEqual(seenRequireMtime, false);
  });

  it("passes requireMtime=undefined (default true) for added items", () => {
    let seenRequireMtime: boolean | undefined;
    const trackingConverter = (
      _item: any,
      _remoteBaseDir: string,
      requireMtime?: boolean
    ): Entity => {
      seenRequireMtime = requireMtime;
      return makeEntity("live.md");
    };
    const items = [{ key: "live.md", mtime: 1000 }];
    classifyDeltaItems(items, "vault", trackingConverter);

    assert.strictEqual(seenRequireMtime, undefined);
  });

  it("skips deleted items whose converter throws", () => {
    const throwingConverter = (
      item: any,
      _remoteBaseDir: string,
      _requireMtime?: boolean
    ): Entity => {
      if (item.key === "bad.md") throw new Error("parse fail");
      return makeEntity(item.key);
    };
    const items = [
      { key: "bad.md", deleted: {} },
      { key: "good.md" },
    ];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      throwingConverter
    );

    // bad.md (deleted, threw) → not in deletedKeys, not in deltaEntities
    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "good.md");
    assert.strictEqual(deletedKeys.size, 0);
  });

  it("skips added items whose converter throws", () => {
    const throwingConverter = (
      item: any,
      _remoteBaseDir: string,
      _requireMtime?: boolean
    ): Entity => {
      if (item.key === "bad.md") throw new Error("parse fail");
      return makeEntity(item.key);
    };
    const items = [
      { key: "bad.md", mtime: 1000 },
      { key: "good.md", mtime: 1000 },
    ];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      throwingConverter
    );

    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "good.md");
    assert.strictEqual(deletedKeys.size, 0);
  });

  it("excludes root key from deletedKeys", () => {
    const items = [{ key: "/", deleted: {} }];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deletedKeys.size, 0);
  });

  it("excludes empty keyRaw from deletedKeys", () => {
    const items = [{ key: "", deleted: {} }];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deletedKeys.size, 0);
  });

  it("excludes root entity from deltaEntities", () => {
    const items = [{ key: "/" }];
    const { deltaEntities } = classifyDeltaItems(
      items,
      "vault",
      mockConverter
    );

    assert.strictEqual(deltaEntities.length, 0);
  });

  it("returns empty results for empty input", () => {
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      [],
      "vault",
      mockConverter
    );

    assert.strictEqual(deltaEntities.length, 0);
    assert.strictEqual(deletedKeys.size, 0);
  });
});
