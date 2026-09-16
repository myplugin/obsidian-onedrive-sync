import { strict as assert } from "assert";

import type { Entity } from "../src/baseTypes";
import {
  clearAllFileContentHistoryByVault,
  clearFileContentHistoryByVaultAndProfile,
  getFileContentHistoryByVaultAndProfile,
  upsertFileContentHistoryByVaultAndProfile,
} from "../src/fileContentHistory";
import type { InternalDBs } from "../src/localdb";

/**
 * In-memory stand-in for the localforage table used by fileContentHistory.ts,
 * including keys()/removeItems() used by clearAllFileContentHistoryByVault.
 */
const createMockDb = () => {
  const store: Record<string, any> = {};
  const tbl = {
    setItem: async (key: string, value: any) => {
      store[key] = value;
      return value;
    },
    getItem: async (key: string) =>
      Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
    removeItem: async (key: string) => {
      delete store[key];
    },
    removeItems: async (keys: string[]) => {
      for (const key of keys) {
        delete store[key];
      }
    },
    keys: async () => Object.keys(store),
  };
  const db = { fileContentHistoryTbl: tbl } as unknown as InternalDBs;
  return { db, store };
};

const mkEntity = (key: string): Entity => ({
  key,
  keyRaw: key,
  sizeRaw: 0,
  size: 0,
});

const str2ab = (s: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
};

describe("fileContentHistory", () => {
  it("upsert then get should round-trip the content", async () => {
    const { db, store } = createMockDb();
    const content = str2ab("previous file content");
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      content
    );
    // the composite key is vaultRandomID \t profileID \t key
    assert.deepStrictEqual(Object.keys(store), ["v1\tp1\ta.md"]);

    const got = await getFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md")
    );
    assert.ok(got !== null && got !== undefined);
    assert.deepStrictEqual(
      new Uint8Array(got as ArrayBuffer),
      new Uint8Array(content)
    );
    assert.equal(
      new TextDecoder().decode(got as ArrayBuffer),
      "previous file content"
    );
  });

  it("get should return null for a missing entry", async () => {
    const { db } = createMockDb();
    const got = await getFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("missing.md")
    );
    assert.equal(got, null);
  });

  it("upsert should overwrite an existing entry", async () => {
    const { db, store } = createMockDb();
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      str2ab("v1 content")
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      str2ab("v2 content")
    );
    assert.equal(Object.keys(store).length, 1);
    const got = await getFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md")
    );
    assert.equal(new TextDecoder().decode(got as ArrayBuffer), "v2 content");
  });

  it("should isolate entries by vault, profile and key", async () => {
    const { db, store } = createMockDb();
    const c1 = str2ab("content-1");
    const c2 = str2ab("content-2");
    const c3 = str2ab("content-3");
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      c1
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p2",
      mkEntity("a.md"),
      c2
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v2",
      "p1",
      mkEntity("a.md"),
      c3
    );
    assert.deepStrictEqual(Object.keys(store).sort(), [
      "v1\tp1\ta.md",
      "v1\tp2\ta.md",
      "v2\tp1\ta.md",
    ]);
    const got1 = await getFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md")
    );
    const got2 = await getFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p2",
      mkEntity("a.md")
    );
    assert.equal(new TextDecoder().decode(got1 as ArrayBuffer), "content-1");
    assert.equal(new TextDecoder().decode(got2 as ArrayBuffer), "content-2");
  });

  it("should support folder-like keys", async () => {
    const { db, store } = createMockDb();
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("dir/sub file.md"),
      str2ab("x")
    );
    assert.deepStrictEqual(Object.keys(store), ["v1\tp1\tdir/sub file.md"]);
  });

  it("clearFileContentHistoryByVaultAndProfile should remove exactly one entry", async () => {
    const { db, store } = createMockDb();
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      str2ab("a")
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("b.md"),
      str2ab("b")
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p2",
      mkEntity("a.md"),
      str2ab("a2")
    );

    await clearFileContentHistoryByVaultAndProfile(db, "v1", "p1", "a.md");
    assert.deepStrictEqual(Object.keys(store).sort(), [
      "v1\tp1\tb.md",
      "v1\tp2\ta.md",
    ]);
    assert.equal(
      await getFileContentHistoryByVaultAndProfile(
        db,
        "v1",
        "p1",
        mkEntity("a.md")
      ),
      null
    );

    // clearing a missing entry does not throw
    await clearFileContentHistoryByVaultAndProfile(db, "v1", "p1", "nope.md");
    assert.equal(Object.keys(store).length, 2);
  });

  it("clearAllFileContentHistoryByVault should remove all profiles of the vault only", async () => {
    const { db, store } = createMockDb();
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p1",
      mkEntity("a.md"),
      str2ab("a")
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v1",
      "p2",
      mkEntity("b.md"),
      str2ab("b")
    );
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v2",
      "p1",
      mkEntity("c.md"),
      str2ab("c")
    );

    await clearAllFileContentHistoryByVault(db, "v1");
    assert.deepStrictEqual(Object.keys(store), ["v2\tp1\tc.md"]);
  });

  it("clearAllFileContentHistoryByVault should tolerate empty/no-match stores", async () => {
    const { db, store } = createMockDb();
    // empty store
    await clearAllFileContentHistoryByVault(db, "v1");
    assert.equal(Object.keys(store).length, 0);

    // store with only other vaults
    await upsertFileContentHistoryByVaultAndProfile(
      db,
      "v2",
      "p1",
      mkEntity("c.md"),
      str2ab("c")
    );
    await clearAllFileContentHistoryByVault(db, "v1");
    assert.deepStrictEqual(Object.keys(store), ["v2\tp1\tc.md"]);
  });
});
