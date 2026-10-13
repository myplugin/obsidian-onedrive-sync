// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import {
  type ClassifiedDelta,
  type DriveItemToEntity,
  buildIdToKeyMap,
  classifyDeltaItems,
  mergeDeltaWithPrevState,
} from "../src/deltaMerge";
import {
  fromDriveItemToEntityWithChainFallback,
  fromDriveItemToEntityWithIdFallback,
  isApprootRootDriveItem,
} from "../src/driveItemConvert";

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
  // download/stat them 鈫?HTTP 404.
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
    const items = [{ key: "bad.md", deleted: {} }, { key: "good.md" }];
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      items,
      "vault",
      throwingConverter
    );

    // bad.md (deleted, threw) 鈫?not in deletedKeys, not in deltaEntities
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
    const { deltaEntities } = classifyDeltaItems(items, "vault", mockConverter);

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

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// END-TO-END REGRESSION: the full path that caused 404
// AggregateErrors in production. Before commit 0f73447, the
// delta merge only checked @removed and missed the `deleted`
// facet, so "ghost" entries survived in prevRemoteEntities.
// Sync then tried to stat/download those non-existent files 鈫?// HTTP 404 鈫?after 3 errors 鈫?AggregateError "too many errors".
//
// These tests exercise the COMPLETE path:
//   raw DriveItems 鈫?classifyDeltaItems 鈫?mergeDeltaWithPrevState
// and assert no ghost entries survive in the final list.
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
describe("404 regression: end-to-end delta merge path", () => {
  const converter = (item: any, _dir: string, _req?: boolean): Entity =>
    makeEntity(item.key, item.mtime, item.size);

  it("deleted-facet items do not survive in merged output", () => {
    // Previous sync knew about these 3 files.
    const prev = [
      makeEntity("keep.md", 1000),
      makeEntity("ghost1.md", 1000),
      makeEntity("ghost2.md", 1000),
    ];

    // Delta API response: keep.md was modified, ghost1/ghost2 were
    // deleted 鈥?but signaled via the `deleted` facet, NOT @removed.
    const driveItems = [
      { key: "keep.md", mtime: 2000 },
      { key: "ghost1.md", deleted: {} },
      { key: "ghost2.md", deleted: {} },
    ];

    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      driveItems,
      "vault",
      converter
    );
    const merged = mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys);

    // Ghosts must be gone 鈥?if they survive, sync will 404 on them.
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].keyRaw, "keep.md");
    assert.ok(!merged.some((e) => e.keyRaw === "ghost1.md"));
    assert.ok(!merged.some((e) => e.keyRaw === "ghost2.md"));
  });

  it("mixed @removed and deleted-facet deletions all get purged", () => {
    const prev = [
      makeEntity("live.md", 1000),
      makeEntity("removed.md", 1000),
      makeEntity("faceted.md", 1000),
      makeEntity("both.md", 1000),
    ];

    const driveItems = [
      { key: "live.md", mtime: 2000 },
      { key: "removed.md", "@removed": { reason: "deleted" } },
      { key: "faceted.md", deleted: {} },
      {
        key: "both.md",
        "@removed": { reason: "deleted" },
        deleted: {},
      },
    ];

    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      driveItems,
      "vault",
      converter
    );
    const merged = mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys);

    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].keyRaw, "live.md");
    for (const ghost of ["removed.md", "faceted.md", "both.md"]) {
      assert.ok(
        !merged.some((e) => e.keyRaw === ghost),
        `${ghost} should have been purged`
      );
    }
  });

  it("large batch: only live files survive after mass deletion", () => {
    // Simulates "batch-modify notes" scenario: many files changed,
    // some deleted via deleted facet. Verifies the merge scales.
    const prev: Entity[] = [];
    for (let i = 0; i < 50; i++) {
      prev.push(makeEntity(`note${i}.md`, 1000));
    }

    const driveItems: any[] = [];
    // notes 0-9 modified
    for (let i = 0; i < 10; i++) {
      driveItems.push({ key: `note${i}.md`, mtime: 2000 });
    }
    // notes 10-29 deleted via deleted facet (not @removed)
    for (let i = 10; i < 30; i++) {
      driveItems.push({ key: `note${i}.md`, deleted: {} });
    }
    // notes 30-49 untouched (not in delta at all)

    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      driveItems,
      "vault",
      converter
    );
    const merged = mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys);

    // 10 modified + 20 untouched = 30 survivors; 20 ghosts purged.
    assert.strictEqual(merged.length, 30);
    assert.ok(merged.some((e) => e.keyRaw === "note0.md")); // modified
    assert.ok(merged.some((e) => e.keyRaw === "note49.md")); // untouched
    assert.ok(!merged.some((e) => e.keyRaw === "note10.md")); // deleted
    assert.ok(!merged.some((e) => e.keyRaw === "note29.md")); // deleted
  });
});
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
describe("classifyDeltaItems: approot root is not a parse failure", () => {
  // Mimics the real fromDriveItemToEntity fix: the approot root folder
  // (no parentReference.path) maps to key "/" and is dropped cleanly,
  // NOT thrown/skipped as a parse failure.
  const rootAwareConverter = (
    item: any,
    remoteBaseDir: string,
    _requireMtime?: boolean
  ): Entity => {
    if (isApprootRootDriveItem(item, remoteBaseDir)) {
      return makeEntity("/");
    }
    return makeEntity(item.key, item.mtime, item.size);
  };

  it("does not warn and does not include the root in deltaEntities", () => {
    const rootItem = {
      id: "d!s1",
      name: "MyVault",
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" },
    };
    const liveItem = { key: "notes/a.md", mtime: 2000 };

    const warnSpy = (..._args: any[]) => {};
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (...args: any[]) => {
      warned = true;
      warnSpy(...args);
    };
    try {
      const { deltaEntities, deletedKeys } = classifyDeltaItems(
        [rootItem, liveItem],
        "MyVault",
        rootAwareConverter
      );
      assert.ok(!warned, "root folder must not log a parse-failure warning");
      assert.strictEqual(deltaEntities.length, 1);
      assert.strictEqual(deltaEntities[0].keyRaw, "notes/a.md");
      assert.strictEqual(deletedKeys.size, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("drops the root folder from the merged output (key '/' is filtered)", () => {
    const prev = [makeEntity("notes/a.md", 1000)];
    const rootItem = {
      name: "MyVault",
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" },
    };
    const { deltaEntities, deletedKeys } = classifyDeltaItems(
      [rootItem, { key: "notes/a.md", mtime: 2000 }],
      "MyVault",
      rootAwareConverter
    );
    const merged = mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys);

    assert.ok(!merged.some((e) => e.keyRaw === "/"), "root must not survive");
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].mtimeSvr, 2000);
  });
});

describe("classifyDeltaItems: skippedAddedOrModified self-heal signal", () => {
  // Converter that throws on items flagged `bad` — mimics the real
  // fromDriveItemToEntity throwing on unparseable delta shapes. Returns a
  // normal entity otherwise.
  const converter = (item: any, _dir: string, _req?: boolean): Entity => {
    if (item.bad) throw new Error("parse fail");
    return makeEntity(item.key, item.mtime, item.size);
  };

  it("returns skippedAddedOrModified=0 when all items parse", () => {
    const items = [
      { key: "a.md", mtime: 1000 },
      { key: "b.md", mtime: 2000 },
    ];
    const { skippedAddedOrModified } = classifyDeltaItems(
      items,
      "vault",
      converter
    );
    assert.strictEqual(skippedAddedOrModified, 0);
  });

  it("counts added/modified items whose conversion throws", () => {
    const items = [
      { key: "good.md", mtime: 1000 },
      { key: "bad1.md", mtime: 1000, bad: true },
      { key: "bad2.md", mtime: 1000, bad: true },
    ];
    const { deltaEntities, deletedKeys, skippedAddedOrModified } =
      classifyDeltaItems(items, "vault", converter);
    assert.strictEqual(skippedAddedOrModified, 2);
    assert.strictEqual(deltaEntities.length, 1); // only good.md survived
    assert.strictEqual(deletedKeys.size, 0);
  });

  it("does NOT count deleted-item throws (those self-heal via 404)", () => {
    const items = [
      { key: "live.md", mtime: 1000 },
      { key: "ghost.md", mtime: 1000, deleted: {}, bad: true },
    ];
    const { deltaEntities, deletedKeys, skippedAddedOrModified } =
      classifyDeltaItems(items, "vault", converter);
    // The deleted item threw during key extraction -> not in deletedKeys,
    // but NOT counted as skippedAddedOrModified either: deleted-item skips
    // self-heal via the 404 path in main.ts; only added/modified skips
    // trigger the deltaLink-invalidation self-heal in walk().
    assert.strictEqual(skippedAddedOrModified, 0);
    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deletedKeys.size, 0);
  });
});

describe("buildIdToKeyMap", () => {
  it("maps remoteId → keyRaw for entities that have remoteId", () => {
    const prev = [
      { keyRaw: "a.md", remoteId: "d!1" },
      { keyRaw: "sub/b.md", remoteId: "d!2" },
      { keyRaw: "no-id.md" }, // remoteId undefined → excluded
    ] as any;
    const map = buildIdToKeyMap(prev);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get("d!1"), "a.md");
    assert.strictEqual(map.get("d!2"), "sub/b.md");
    assert.ok(!map.has(undefined as any));
  });

  it("returns an empty map for prev with no remoteIds", () => {
    const map = buildIdToKeyMap([{ keyRaw: "a.md" }] as any);
    assert.strictEqual(map.size, 0);
  });
});

describe("classifyDeltaItems with idToKeyMap (real converter)", () => {
  const MTIME = "2024-01-01T00:00:00Z";
  // A non-root delta item with NO parentReference.path — the documented
  // delta shape. Its id IS in the map (modify case).
  const pathlessModified = {
    id: "d!999",
    name: "x", // irrelevant — key comes from the map
    size: 20,
    file: {},
    eTag: '"e2"',
    fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
    parentReference: { driveId: "d", id: "d!root" }, // NO path
  };

  // The id-fallback converter with the map BOUND via closure — the design
  // from plan Task 3 Step 3's note: classifyDeltaItems' 4th param stays
  // unused (documentation of intent); the fallback is performed by the
  // converter the caller passes, exactly like walk()'s lambda in Task 4.
  // (Passing the raw 4-param fallback directly would also violate
  // strictFunctionTypes against the 3-param DriveItemToEntity type.)
  const bindMap =
    (idToKeyMap?: Map<string, string>): DriveItemToEntity =>
    (item, dir, requireMtime) =>
      fromDriveItemToEntityWithIdFallback(item, dir, idToKeyMap, requireMtime);

  it("recovers a path-missing modify item via id-lookup (no warn, no skip)", () => {
    const idToKeyMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    let result: ClassifiedDelta | undefined;
    try {
      result = classifyDeltaItems(
        [pathlessModified],
        "MyVault",
        bindMap(idToKeyMap),
        idToKeyMap
      );
    } finally {
      console.warn = origWarn;
    }
    assert.ok(!warned, "must NOT warn — item recovered via id-lookup");
    assert.strictEqual(result!.deltaEntities.length, 1);
    assert.strictEqual(result!.deltaEntities[0].keyRaw, "notes/a.md");
    assert.strictEqual(result!.deltaEntities[0].etag, '"e2"');
    assert.strictEqual(result!.skippedAddedOrModified, 0);
  });

  it("still skips + self-heals when id is NOT in the map (new path-missing item)", () => {
    const idToKeyMap = new Map<string, string>(); // empty
    const { deltaEntities, skippedAddedOrModified } = classifyDeltaItems(
      [pathlessModified],
      "MyVault",
      bindMap(idToKeyMap),
      idToKeyMap
    );
    assert.strictEqual(deltaEntities.length, 0);
    assert.strictEqual(skippedAddedOrModified, 1);
  });

  it("deleted path-missing item with id in map → goes to deletedKeys (no phantom)", () => {
    const pathlessDeleted = {
      id: "d!777",
      name: "x",
      deleted: {},
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    const idToKeyMap = new Map<string, string>([["d!777", "gone.md"]]);
    const { deltaEntities, deletedKeys, skippedAddedOrModified } =
      classifyDeltaItems(
        [pathlessDeleted],
        "MyVault",
        bindMap(idToKeyMap),
        idToKeyMap
      );
    assert.strictEqual(deltaEntities.length, 0);
    assert.ok(deletedKeys.has("gone.md"));
    assert.strictEqual(skippedAddedOrModified, 0);
  });

  it("works without idToKeyMap (backward-compatible — current behavior)", () => {
    // No 4th arg + unbound converter → behaves exactly like today:
    // path-missing → throw → skip.
    const { deltaEntities, skippedAddedOrModified } = classifyDeltaItems(
      [pathlessModified],
      "MyVault",
      bindMap()
    );
    assert.strictEqual(deltaEntities.length, 0);
    assert.strictEqual(skippedAddedOrModified, 1);
  });
});

// ----------------------------------------------------------------
// parent-id-chain fallback (plan 2026-09-22): NEW path-missing delta
// items (e.g. folders created on another device) resolve via the
// parentReference.id chain instead of warn + skip + deltaLink
// invalidation churn. Fixture = the EXACT shape from the reported
// warning data (non-root folders A/B, personal drive, no path).
// ----------------------------------------------------------------
describe("classifyDeltaItems: parent-id-chain fallback", () => {
  const MTIME = "2024-01-01T00:00:00Z";
  const ROOT_ID = "00000000FACE0000!00000000000000000000000000000001";
  const DRIVE_ID = "00000000FACE0000";
  // Non-root folder A: direct child of the vault root, NO path.
  const folderA = {
    id: "00000000FACE0000!00000000000000000000000000000002",
    name: "A",
    size: 0,
    folder: {},
    fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
    parentReference: {
      driveType: "personal",
      driveId: DRIVE_ID,
      id: ROOT_ID,
    },
  };
  // Non-root folder B: child of A (parent id = A's id), NO path.
  const folderB = {
    id: "00000000FACE0000!00000000000000000000000000000003",
    name: "B",
    size: 0,
    folder: {},
    fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
    parentReference: {
      driveType: "personal",
      driveId: DRIVE_ID,
      id: folderA.id,
    },
  };

  // Same closure-binding pattern as bindMap above: ONE lookup-map instance
  // shared between the converter and classifyDeltaItems (which seeds the
  // root anchor from its 5th param and extends the map with each in-batch
  // resolution, feeding the two-pass rescan).
  const bindChain =
    (
      lookupMap: Map<string, string>,
      approotRootId?: string
    ): DriveItemToEntity =>
    (item, dir, requireMtime) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        approotRootId,
        requireMtime
      );

  const classifyWithChain = (
    items: any[],
    lookupMap: Map<string, string>,
    approotRootId?: string
  ): ClassifiedDelta =>
    classifyDeltaItems(
      items,
      "MyVault",
      bindChain(lookupMap, approotRootId),
      lookupMap,
      approotRootId
    );

  it("resolves new path-missing folders A (root child) + B (child of A)", () => {
    const lookupMap = new Map<string, string>(); // empty prev
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    let result: ClassifiedDelta;
    try {
      result = classifyWithChain([folderA, folderB], lookupMap, ROOT_ID);
    } finally {
      console.warn = origWarn;
    }
    assert.ok(!warned, "must NOT warn - both folders resolve via the chain");
    assert.strictEqual(result.skippedAddedOrModified, 0);
    assert.strictEqual(result.deltaEntities.length, 2);
    const keys = result.deltaEntities.map((e) => e.keyRaw).sort();
    assert.deepStrictEqual(keys, ["A/", "A/B/"]);
    const a = result.deltaEntities.find((e) => e.keyRaw === "A/")!;
    assert.strictEqual(a.remoteId, folderA.id);
    const b = result.deltaEntities.find((e) => e.keyRaw === "A/B/")!;
    assert.strictEqual(b.remoteId, folderB.id);
  });

  it("resolves the same batch in REVERSE order (order-independent rescan)", () => {
    const lookupMap = new Map<string, string>();
    const result = classifyWithChain([folderB, folderA], lookupMap, ROOT_ID);
    assert.strictEqual(result.skippedAddedOrModified, 0);
    const keys = result.deltaEntities.map((e) => e.keyRaw).sort();
    assert.deepStrictEqual(keys, ["A/", "A/B/"]);
  });

  it("resolves a 3-level batch in worst order (deepest child first)", () => {
    // c.md (child of B) cannot resolve until B and A have resolved on the
    // rescan passes - proves the rescan repeats until no progress.
    const fileC = {
      id: "00000000FACE0000!sc000000000000000000000000000c",
      name: "c.md",
      size: 5,
      file: {},
      fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
      parentReference: {
        driveType: "personal",
        driveId: DRIVE_ID,
        id: folderB.id,
      },
    };
    const lookupMap = new Map<string, string>();
    const result = classifyWithChain(
      [fileC, folderB, folderA],
      lookupMap,
      ROOT_ID
    );
    assert.strictEqual(result.skippedAddedOrModified, 0);
    const keys = result.deltaEntities.map((e) => e.keyRaw).sort();
    assert.deepStrictEqual(keys, ["A/", "A/B/", "A/B/c.md"]);
  });

  it("unreachable parent chain -> both items skip + self-heal signal", () => {
    const orphanA = {
      ...folderA,
      parentReference: {
        driveType: "personal",
        driveId: DRIVE_ID,
        id: "UNKNOWN!deadbeef", // neither the root nor in the map
      },
    };
    // folderB's parent is orphanA.id - A itself is unresolvable, so B is
    // too (contractually correct degradation).
    const lookupMap = new Map<string, string>();
    let warnCount = 0;
    const origWarn = console.warn;
    console.warn = () => {
      warnCount += 1;
    };
    let result: ClassifiedDelta;
    try {
      result = classifyWithChain([orphanA, folderB], lookupMap, ROOT_ID);
    } finally {
      console.warn = origWarn;
    }
    assert.strictEqual(result.deltaEntities.length, 0);
    assert.strictEqual(result.skippedAddedOrModified, 2);
    assert.strictEqual(warnCount, 2);
  });

  it("deleted path-missing item with root parent -> deletedKeys (no phantom)", () => {
    const deletedFolder = {
      id: "00000000FACE0000!sdel00000000000000000000000000",
      name: "Old",
      size: 0,
      folder: {},
      deleted: {},
      parentReference: {
        driveType: "personal",
        driveId: DRIVE_ID,
        id: ROOT_ID,
      }, // no path
    };
    const prev = [
      makeEntity("Old/"),
      makeEntity("Old/note.md"),
      makeEntity("keep.md"),
    ];
    const lookupMap = new Map<string, string>();
    const { deltaEntities, deletedKeys, skippedAddedOrModified } =
      classifyWithChain([deletedFolder], lookupMap, ROOT_ID);
    assert.strictEqual(deltaEntities.length, 0);
    assert.ok(deletedKeys.has("Old/"));
    assert.strictEqual(skippedAddedOrModified, 0);
    const merged = mergeDeltaWithPrevState(prev, deltaEntities, deletedKeys);
    assert.ok(
      !merged.some((e) => e.keyRaw === "Old/"),
      "deleted folder must not survive as a phantom"
    );
  });

  it("behavior preserved: path-bearing items still use the main path", () => {
    const withPath = {
      id: "d!555",
      name: "a.md",
      size: 10,
      file: {},
      eTag: '"e9"',
      fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
      parentReference: { path: "/drive/root:/Apps/remotely-save/MyVault" },
    };
    const lookupMap = new Map<string, string>();
    const result = classifyWithChain([withPath], lookupMap, ROOT_ID);
    assert.strictEqual(result.deltaEntities.length, 1);
    assert.strictEqual(result.deltaEntities[0].keyRaw, "a.md");
    assert.strictEqual(result.deltaEntities[0].etag, '"e9"');
    assert.strictEqual(result.skippedAddedOrModified, 0);
  });

  it("modify case still recovers via own-id lookup (id-fallback equivalence)", () => {
    const pathlessModified = {
      id: "d!999",
      name: "x",
      size: 20,
      file: {},
      eTag: '"e2"',
      fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    const lookupMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    const result = classifyWithChain([pathlessModified], lookupMap, ROOT_ID);
    assert.strictEqual(result.deltaEntities.length, 1);
    assert.strictEqual(result.deltaEntities[0].keyRaw, "notes/a.md");
    assert.strictEqual(result.deltaEntities[0].etag, '"e2"');
    assert.strictEqual(result.skippedAddedOrModified, 0);
  });
});

describe("full-enum fallback (empty lookupMap + approotRootId anchor)", () => {
  // Characterization: the full-enum branch has NO prevRemoteEntities, so the
  // lookupMap starts empty (only the approotRootId -> "/" anchor). A
  // path-missing delta item whose parentReference.id === approotRootId is a
  // direct child of the vault root and MUST resolve via the baseline branch
  // of deriveKeyFromParentChain (key = name, folder -> trailing "/").
  it("resolves a path-missing direct child of the vault root via the anchor", () => {
    const approotRootId = "00000000FACE0000!00000000000000000000000000000001";
    const lookupMap = new Map<string, string>();
    lookupMap.set(approotRootId, "/");
    const converter = (item: any, dir: string, requireMtime?: boolean) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        approotRootId,
        requireMtime
      );
    const child = {
      id: "00000000FACE0000!00000000000000000000000000000005",
      name: "sub",
      size: 0,
      folder: {},
      parentReference: {
        driveType: "personal",
        driveId: "00000000FACE0000",
        id: approotRootId,
      },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    const { deltaEntities } = classifyDeltaItems(
      [child],
      "MyVault",
      converter,
      lookupMap,
      approotRootId
    );
    assert.strictEqual(deltaEntities.length, 1);
    assert.strictEqual(deltaEntities[0].keyRaw, "sub/");
  });

  // A deeper child whose parent ALSO appears in the same delta batch (and
  // resolves) must resolve on classifyDeltaItems' rescan pass — the in-batch
  // parent->child chain, with no prev at all.
  it("resolves a deeper child after its parent resolves in-batch (no prev)", () => {
    const approotRootId = "ROOT!id";
    const lookupMap = new Map<string, string>();
    lookupMap.set(approotRootId, "/");
    const converter = (item: any, dir: string, requireMtime?: boolean) =>
      fromDriveItemToEntityWithChainFallback(
        item,
        dir,
        lookupMap,
        approotRootId,
        requireMtime
      );
    const parent = {
      id: "P!id",
      name: "pdir",
      size: 0,
      folder: {},
      parentReference: { id: approotRootId },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    const child = {
      id: "C!id",
      name: "cfile.md",
      size: 5,
      file: {},
      parentReference: { id: "P!id" },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    // child listed BEFORE parent — rescan must still resolve both
    const { deltaEntities } = classifyDeltaItems(
      [child, parent],
      "MyVault",
      converter,
      lookupMap,
      approotRootId
    );
    const keys = deltaEntities.map((e) => e.keyRaw).sort();
    // The deeper child resolves UNDER its parent (in-batch chain): pdir/ +
    // cfile.md -> "pdir/cfile.md" (matches the 3-level test above which
    // yields "A/B/c.md", not a root-relative "c.md").
    assert.deepStrictEqual(keys, ["pdir/", "pdir/cfile.md"]);
  });

  // Out-of-scope items (stat returned a path that doesn't map to the vault)
  // must propagate OUT_OF_SCOPE — NOT be swallowed as PATH_MISSING — so the
  // stat-retry catch can drop them.
  it("re-throws ONEDRIVE_PATH_OUT_OF_SCOPE (does not swallow as PATH_MISSING) for a non-vault path", () => {
    const lookupMap = new Map<string, string>();
    const outOfScopeStat = {
      id: "X!id",
      name: "x.md",
      parentReference: { path: "/drive/special/approot" },
      fileSystemInfo: {
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        createdDateTime: "2024-01-01T00:00:00Z",
      },
    };
    try {
      fromDriveItemToEntityWithChainFallback(
        outOfScopeStat as any,
        "MyVault",
        lookupMap,
        "ROOT!id",
        false
      );
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });
});
