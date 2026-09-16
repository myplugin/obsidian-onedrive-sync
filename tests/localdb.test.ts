// `_globalsSetup` MUST stay the first import: it installs the in-memory
// `localStorage` shim that localforage (imported by ../src/localdb) needs to
// work under plain Node.js.
import "./_globalsSetup";

import { strict as assert } from "assert";

import type { Entity } from "../src/baseTypes";
import {
  DEFAULT_DB_NAME,
  DEFAULT_DB_VERSION_NUMBER,
  DEFAULT_SYNC_PLANS_HISTORY,
  DEFAULT_TBL_FILE_CONTENT_HISTORY,
  DEFAULT_TBL_FILE_HISTORY,
  DEFAULT_TBL_LOGGER_OUTPUT,
  DEFAULT_TBL_PREV_SYNC_RECORDS,
  DEFAULT_TBL_PROFILER_RESULTS,
  DEFAULT_TBL_SIMPLE_KV_FOR_MISC,
  DEFAULT_TBL_SYNC_MAPPING,
  DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING,
  DEFAULT_TBL_VERSION,
  batchUpsertPrevSyncRecords,
  clearAllLoggerOutputRecords,
  clearAllPrevSyncRecordByVault,
  clearAllSyncMetaMappingByVault,
  clearAllSyncPlanRecords,
  clearExpiredSyncPlanRecords,
  clearFileHistoryOfEverythingByVault,
  clearPrevSyncRecordByVaultAndProfile,
  getAllPrevSyncRecordsByVaultAndProfile,
  getAllSyncMetaMappingByVault,
  getLastFailedCheckTimeByVault,
  getLastFailedSyncTimeByVault,
  getLastSuccessCheckTimeByVault,
  getLastSuccessSyncTimeByVault,
  getOnedriveAuthByVault,
  getPrevRemoteEntities,
  insertProfilerResultByVault,
  insertSyncPlanRecordByVault,
  prepareDBs,
  readAllProfilerResultsByVault,
  readAllSyncPlanRecordTextsByVault,
  savePrevRemoteEntities,
  upsertLastFailedCheckTimeByVault,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessCheckTimeByVault,
  upsertLastSuccessSyncTimeByVault,
  upsertOnedriveAuthByVault,
  upsertPluginVersionByVault,
  upsertPrevSyncRecordByVaultAndProfile,
} from "../src/localdb";
import type { InternalDBs, OnedriveAuthFields } from "../src/localdb";
import { unixTimeToStr } from "../src/misc";
import { memoryLocalStorage } from "./_globalsSetup";

/**
 * An in-memory stand-in for a localforage table (LocalForage instance),
 * including the getItems()/removeItems() prototype extensions that
 * src/localdb.ts installs via localforage-getitems/localforage-removeitems.
 */
interface MockTbl {
  store: Map<string, any>;
  setItem: (k: string, v: any) => Promise<any>;
  getItem: (k: string) => Promise<any>;
  removeItem: (k: string) => Promise<void>;
  removeItems: (ks: string[]) => Promise<void>;
  keys: () => Promise<string[]>;
  getItems: () => Promise<Record<string, any>>;
  iterate: (cb: (v: any, k: string, i: number) => any) => Promise<void>;
  clear: () => Promise<void>;
}

const createMockTbl = (): MockTbl => {
  const store = new Map<string, any>();
  return {
    store,
    setItem: async (k: string, v: any) => {
      store.set(k, v);
      return v;
    },
    getItem: async (k: string) => (store.has(k) ? store.get(k) : null),
    removeItem: async (k: string) => {
      store.delete(k);
    },
    removeItems: async (ks: string[]) => {
      for (const k of ks) {
        store.delete(k);
      }
    },
    keys: async () => Array.from(store.keys()),
    getItems: async () => {
      const res: Record<string, any> = {};
      for (const [k, v] of store) {
        res[k] = v;
      }
      return res;
    },
    iterate: async (cb: (v: any, k: string, i: number) => any) => {
      let i = 0;
      for (const [k, v] of store) {
        await cb(v, k, i);
        i += 1;
      }
    },
    clear: async () => {
      store.clear();
    },
  };
};

type MockDBs = { [K in keyof InternalDBs]: MockTbl };

const createMockDB = (): MockDBs => ({
  versionTbl: createMockTbl(),
  syncPlansTbl: createMockTbl(),
  vaultRandomIDMappingTbl: createMockTbl(),
  loggerOutputTbl: createMockTbl(),
  simpleKVForMiscTbl: createMockTbl(),
  prevSyncRecordsTbl: createMockTbl(),
  profilerResultsTbl: createMockTbl(),
  fileContentHistoryTbl: createMockTbl(),
  fileHistoryTbl: createMockTbl(),
  syncMappingTbl: createMockTbl(),
});

const asDB = (dbs: MockDBs): InternalDBs => dbs as unknown as InternalDBs;

const mkEntity = (key: string, extra: Partial<Entity> = {}): Entity => ({
  key,
  keyRaw: key,
  sizeRaw: 10,
  size: 10,
  ...extra,
});

describe("localdb: exported table name constants", () => {
  it("should have stable schema names", () => {
    assert.equal(DEFAULT_DB_VERSION_NUMBER, 20240220);
    assert.equal(DEFAULT_DB_NAME, "remotelysavedb");
    assert.equal(DEFAULT_TBL_VERSION, "schemaversion");
    assert.equal(DEFAULT_SYNC_PLANS_HISTORY, "syncplanshistory");
    assert.equal(DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING, "vaultrandomidmapping");
    assert.equal(DEFAULT_TBL_LOGGER_OUTPUT, "loggeroutput");
    assert.equal(DEFAULT_TBL_SIMPLE_KV_FOR_MISC, "simplekvformisc");
    assert.equal(DEFAULT_TBL_PREV_SYNC_RECORDS, "prevsyncrecords");
    assert.equal(DEFAULT_TBL_PROFILER_RESULTS, "profilerresults");
    assert.equal(DEFAULT_TBL_FILE_CONTENT_HISTORY, "filecontenthistory");
    assert.equal(DEFAULT_TBL_FILE_HISTORY, "filefolderoperationhistory");
    assert.equal(DEFAULT_TBL_SYNC_MAPPING, "syncmetadatahistory");
  });
});

describe("localdb: prevSyncRecords CRUD (mock tables)", () => {
  it("upsertPrevSyncRecordByVaultAndProfile should use the composite key", async () => {
    const dbs = createMockDB();
    const e = mkEntity("a.md");
    await upsertPrevSyncRecordByVaultAndProfile(asDB(dbs), "v1", "p1", e);
    assert.deepStrictEqual(Array.from(dbs.prevSyncRecordsTbl.store.keys()), [
      "v1\tp1\ta.md",
    ]);
    assert.deepStrictEqual(dbs.prevSyncRecordsTbl.store.get("v1\tp1\ta.md"), e);
  });

  it("getAllPrevSyncRecordsByVaultAndProfile should filter and skip nulls", async () => {
    const dbs = createMockDB();
    const tbl = dbs.prevSyncRecordsTbl;
    tbl.store.set("v1\tp1\ta.md", mkEntity("a.md"));
    tbl.store.set("v1\tp1\tdir/", mkEntity("dir/", { size: 0, sizeRaw: 0 }));
    tbl.store.set("v1\tp1\tnull.md", null); // deleted elsewhere, null value
    tbl.store.set("v1\tp2\tb.md", mkEntity("b.md")); // other profile
    tbl.store.set("v2\tp1\tc.md", mkEntity("c.md")); // other vault

    const got = await getAllPrevSyncRecordsByVaultAndProfile(
      asDB(dbs),
      "v1",
      "p1"
    );
    assert.equal(got.length, 2);
    const keys = got.map((x) => x.key).sort();
    assert.deepStrictEqual(keys, ["a.md", "dir/"]);
  });

  it("batchUpsertPrevSyncRecords should upsert all records", async () => {
    const dbs = createMockDB();
    const records = [mkEntity("a.md"), mkEntity("b.md"), mkEntity("dir/")];
    await batchUpsertPrevSyncRecords(asDB(dbs), "v1", "p1", records);
    assert.deepStrictEqual(
      Array.from(dbs.prevSyncRecordsTbl.store.keys()).sort(),
      ["v1\tp1\ta.md", "v1\tp1\tb.md", "v1\tp1\tdir/"]
    );
    // empty batch is a no-op
    await batchUpsertPrevSyncRecords(asDB(dbs), "v1", "p1", []);
    assert.equal(dbs.prevSyncRecordsTbl.store.size, 3);
  });

  it("clearPrevSyncRecordByVaultAndProfile should remove exactly one", async () => {
    const dbs = createMockDB();
    dbs.prevSyncRecordsTbl.store.set("v1\tp1\ta.md", mkEntity("a.md"));
    dbs.prevSyncRecordsTbl.store.set("v1\tp1\tb.md", mkEntity("b.md"));
    await clearPrevSyncRecordByVaultAndProfile(asDB(dbs), "v1", "p1", "a.md");
    assert.deepStrictEqual(Array.from(dbs.prevSyncRecordsTbl.store.keys()), [
      "v1\tp1\tb.md",
    ]);
    // removing a missing key does not throw
    await clearPrevSyncRecordByVaultAndProfile(
      asDB(dbs),
      "v1",
      "p1",
      "missing.md"
    );
    assert.equal(dbs.prevSyncRecordsTbl.store.size, 1);
  });

  it("clearAllPrevSyncRecordByVault should only remove the vault", async () => {
    const dbs = createMockDB();
    dbs.prevSyncRecordsTbl.store.set("v1\tp1\ta.md", mkEntity("a.md"));
    dbs.prevSyncRecordsTbl.store.set("v1\tp2\tb.md", mkEntity("b.md"));
    dbs.prevSyncRecordsTbl.store.set("v2\tp1\tc.md", mkEntity("c.md"));
    await clearAllPrevSyncRecordByVault(asDB(dbs), "v1");
    assert.deepStrictEqual(Array.from(dbs.prevSyncRecordsTbl.store.keys()), [
      "v2\tp1\tc.md",
    ]);
  });
});

describe("localdb: simpleKV misc entries (mock tables)", () => {
  it("should round-trip the four timestamps", async () => {
    const dbs = createMockDB();
    const db = asDB(dbs);

    assert.equal(await getLastSuccessSyncTimeByVault(db, "v1"), null);
    await upsertLastSuccessSyncTimeByVault(db, "v1", 1000);
    assert.equal(await getLastSuccessSyncTimeByVault(db, "v1"), 1000);
    assert.equal(
      dbs.simpleKVForMiscTbl.store.get("v1-lastSuccessSyncMillis"),
      1000
    );

    await upsertLastFailedSyncTimeByVault(db, "v1", 2000);
    assert.equal(await getLastFailedSyncTimeByVault(db, "v1"), 2000);
    assert.equal(
      dbs.simpleKVForMiscTbl.store.get("v1-lastFailedSyncMillis"),
      2000
    );

    await upsertLastSuccessCheckTimeByVault(db, "v1", 3000);
    assert.equal(await getLastSuccessCheckTimeByVault(db, "v1"), 3000);
    assert.equal(
      dbs.simpleKVForMiscTbl.store.get("v1-lastSuccessCheckMillis"),
      3000
    );

    await upsertLastFailedCheckTimeByVault(db, "v1", 4000);
    assert.equal(await getLastFailedCheckTimeByVault(db, "v1"), 4000);
    assert.equal(
      dbs.simpleKVForMiscTbl.store.get("v1-lastFailedCheckMillis"),
      4000
    );

    // other vaults are isolated
    assert.equal(await getLastSuccessSyncTimeByVault(db, "v2"), null);
  });

  it("upsertPluginVersionByVault should return the old version", async () => {
    const dbs = createMockDB();
    const db = asDB(dbs);
    const r1 = await upsertPluginVersionByVault(db, "v1", "1.0.0");
    assert.deepStrictEqual(r1, { oldVersion: "0.0.0", newVersion: "1.0.0" });
    const r2 = await upsertPluginVersionByVault(db, "v1", "2.0.0");
    assert.deepStrictEqual(r2, { oldVersion: "1.0.0", newVersion: "2.0.0" });
    assert.equal(dbs.simpleKVForMiscTbl.store.get("v1-pluginversion"), "2.0.0");
  });

  it("should round-trip the onedrive auth object", async () => {
    const dbs = createMockDB();
    const db = asDB(dbs);
    assert.equal(await getOnedriveAuthByVault(db, "v1"), null);
    const auth: OnedriveAuthFields = {
      accessToken: "at",
      refreshToken: "rt",
      accessTokenExpiresInSeconds: 3600,
      accessTokenExpiresAtTime: 1234567890,
      deltaLink: "dl",
      username: "user@example.com",
      credentialsShouldBeDeletedAtTime: 9999,
      password: "vault-password",
    };
    await upsertOnedriveAuthByVault(db, "v1", auth);
    assert.ok(dbs.simpleKVForMiscTbl.store.has("v1-onedriveAuth"));
    assert.deepStrictEqual(await getOnedriveAuthByVault(db, "v1"), auth);
  });

  it("getPrevRemoteEntities should normalize null to undefined", async () => {
    const dbs = createMockDB();
    const db = asDB(dbs);
    assert.equal(await getPrevRemoteEntities(db, "v1"), undefined);

    const entities: Entity[] = [
      { keyRaw: "a.md", sizeRaw: 1, key: "a.md", size: 1 },
    ];
    await savePrevRemoteEntities(db, "v1", entities);
    assert.deepStrictEqual(await getPrevRemoteEntities(db, "v1"), entities);

    await savePrevRemoteEntities(db, "v1", []);
    assert.deepStrictEqual(await getPrevRemoteEntities(db, "v1"), []);
  });
});

describe("localdb: deprecated syncMetaMapping helpers (mock tables)", () => {
  const rec = (localKey: string) => ({
    localKey: localKey,
    remoteKey: `remote-${localKey}`,
    localSize: 1,
    remoteSize: 2,
    localMtime: 3,
    remoteMtime: 4,
    remoteExtraKey: "etag",
    remoteType: "onedrive",
    keyType: "file",
    vaultRandomID: "v1",
  });

  it("getAllSyncMetaMappingByVault should filter by vault prefix", async () => {
    const dbs = createMockDB();
    dbs.syncMappingTbl.store.set("v1\tk1", rec("k1"));
    dbs.syncMappingTbl.store.set("v1\tk2", rec("k2"));
    dbs.syncMappingTbl.store.set("v2\tk3", rec("k3"));

    const got = await getAllSyncMetaMappingByVault(asDB(dbs), "v1");
    assert.equal(got.length, 2);
    assert.deepStrictEqual(got.map((x: any) => x.localKey).sort(), [
      "k1",
      "k2",
    ]);

    // missing vault -> empty
    const got2 = await getAllSyncMetaMappingByVault(asDB(dbs), "vX");
    assert.deepStrictEqual(got2, []);
  });

  it("clearAllSyncMetaMappingByVault should only remove the vault", async () => {
    const dbs = createMockDB();
    dbs.syncMappingTbl.store.set("v1\tk1", rec("k1"));
    dbs.syncMappingTbl.store.set("v2\tk3", rec("k3"));
    await clearAllSyncMetaMappingByVault(asDB(dbs), "v1");
    assert.deepStrictEqual(Array.from(dbs.syncMappingTbl.store.keys()), [
      "v2\tk3",
    ]);
  });
});

describe("localdb: sync plan records (mock tables)", () => {
  // unixTimeToStr() (used by insertSyncPlanRecordByVault) calls the
  // Obsidian-provided window.moment. Install a minimal deterministic stub.
  // This must happen in a suite hook: other test files (encryptOpenSSL)
  // replace global.window in their own beforeEach hooks when the full suite
  // runs, wiping anything installed at module load time.
  before(() => {
    if ((globalThis as any).window === undefined) {
      (globalThis as any).window = {};
    }
    const w = (globalThis as any).window;
    if (w.moment === undefined) {
      w.moment = (x: number) => ({
        format: () => new Date(x).toISOString(),
        toISOString: () => new Date(x).toISOString(),
      });
    }
  });

  it("insertSyncPlanRecordByVault should store a stringified record", async () => {
    const dbs = createMockDB();
    const plan = { "a.md": { key: "a.md", decision: "skip" } } as any;
    const before = Date.now();
    await insertSyncPlanRecordByVault(asDB(dbs), plan, "v1", "onedrive");
    const after = Date.now();

    assert.equal(dbs.syncPlansTbl.store.size, 1);
    const [key, record] = Array.from(dbs.syncPlansTbl.store.entries())[0];
    assert.ok(key.startsWith("v1\t"));
    const ts = Number.parseInt(key.split("\t")[1]);
    assert.ok(ts >= before && ts <= after);
    assert.equal(record.ts, ts);
    assert.equal(record.tsFmt, unixTimeToStr(ts));
    assert.equal(record.vaultRandomID, "v1");
    assert.equal(record.remoteType, "onedrive");
    assert.equal(record.syncPlan, JSON.stringify(plan, null, 2));
  });

  it("readAllSyncPlanRecordTextsByVault should sort desc and filter", async () => {
    const dbs = createMockDB();
    const mkRec = (ts: number, text: string) => ({
      ts: ts,
      remoteType: "onedrive",
      syncPlan: text,
      vaultRandomID: "v1",
    });
    dbs.syncPlansTbl.store.set("v1\t300", mkRec(300, "p300"));
    dbs.syncPlansTbl.store.set("v1\t100", mkRec(100, "p100"));
    dbs.syncPlansTbl.store.set("v1\t200", mkRec(200, "p200"));
    dbs.syncPlansTbl.store.set("v2\t999", {
      ...mkRec(999, "other"),
      vaultRandomID: "v2",
    });

    const texts = await readAllSyncPlanRecordTextsByVault(asDB(dbs), "v1");
    assert.deepStrictEqual(texts, ["p300", "p200", "p100"]);

    const texts2 = await readAllSyncPlanRecordTextsByVault(asDB(dbs), "v2");
    assert.deepStrictEqual(texts2, ["other"]);

    const texts3 = await readAllSyncPlanRecordTextsByVault(asDB(dbs), "vX");
    assert.deepStrictEqual(texts3, []);
  });

  it("clearAllSyncPlanRecords should clear everything", async () => {
    const dbs = createMockDB();
    dbs.syncPlansTbl.store.set("v1\t1", { ts: 1 });
    dbs.syncPlansTbl.store.set("v2\t2", { ts: 2 });
    await clearAllSyncPlanRecords(asDB(dbs));
    assert.equal(dbs.syncPlansTbl.store.size, 0);
  });

  it("clearExpiredSyncPlanRecords should remove records older than 1 day", async () => {
    const dbs = createMockDB();
    const now = Date.now();
    const oneDay = 1000 * 60 * 60 * 24;
    for (let i = 0; i < 3; ++i) {
      const ts = now - 2 * oneDay - i;
      dbs.syncPlansTbl.store.set(`v1\t${ts}`, { ts: ts });
    }
    for (let i = 0; i < 5; ++i) {
      const ts = now - i * 1000;
      dbs.syncPlansTbl.store.set(`v1\t${ts}`, { ts: ts });
    }
    await clearExpiredSyncPlanRecords(asDB(dbs));
    assert.equal(dbs.syncPlansTbl.store.size, 5);
    for (const key of Array.from(dbs.syncPlansTbl.store.keys())) {
      const ts = Number.parseInt(key.split("\t")[1]);
      assert.ok(ts > now - oneDay);
    }
  });

  it("clearExpiredSyncPlanRecords should cap fresh records at 20", async () => {
    const dbs = createMockDB();
    const now = Date.now();
    const allKeys: string[] = [];
    for (let i = 0; i < 25; ++i) {
      const ts = now - i * 60_000; // minutes apart, all fresh
      const key = `v1\t${ts}`;
      allKeys.push(key);
      dbs.syncPlansTbl.store.set(key, { ts: ts });
    }
    await clearExpiredSyncPlanRecords(asDB(dbs));
    assert.equal(dbs.syncPlansTbl.store.size, 20);
    // the 5 oldest (i = 20..24) are gone
    for (let i = 20; i < 25; ++i) {
      assert.equal(dbs.syncPlansTbl.store.has(allKeys[i]), false);
    }
    for (let i = 0; i < 20; ++i) {
      assert.equal(dbs.syncPlansTbl.store.has(allKeys[i]), true);
    }
  });
});

describe("localdb: profiler results (mock tables)", () => {
  it("insert should keep only the 5 newest per vault, read sorts desc", async () => {
    const dbs = createMockDB();
    const db = asDB(dbs);
    const origNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t++;
      for (let i = 0; i <= 6; ++i) {
        await insertProfilerResultByVault(db, `res${i}`, "v1", "onedrive");
      }
    } finally {
      Date.now = origNow;
    }
    // another vault must not be touched by the trimming
    dbs.profilerResultsTbl.store.set("v2\t1", "v2res");

    const v1Keys = Array.from(dbs.profilerResultsTbl.store.keys()).filter((x) =>
      x.startsWith("v1\t")
    );
    assert.equal(v1Keys.length, 5);
    // the newest 5 are ts 1000002..1000006 (res2..res6)
    assert.equal(dbs.profilerResultsTbl.store.has("v1\t1000000"), false);
    assert.equal(dbs.profilerResultsTbl.store.has("v1\t1000001"), false);
    assert.equal(dbs.profilerResultsTbl.store.get("v1\t1000006"), "res6");

    const vals = await readAllProfilerResultsByVault(db, "v1");
    assert.deepStrictEqual(vals, ["res6", "res5", "res4", "res3", "res2"]);
    assert.deepStrictEqual(await readAllProfilerResultsByVault(db, "v2"), [
      "v2res",
    ]);
    assert.deepStrictEqual(await readAllProfilerResultsByVault(db, "vX"), []);
  });
});

describe("localdb: logger output and file history (mock tables)", () => {
  it("clearAllLoggerOutputRecords should clear the table", async () => {
    const dbs = createMockDB();
    dbs.loggerOutputTbl.store.set("k1", "log line");
    await clearAllLoggerOutputRecords(asDB(dbs));
    assert.equal(dbs.loggerOutputTbl.store.size, 0);
  });

  it("clearFileHistoryOfEverythingByVault should only remove the vault", async () => {
    const dbs = createMockDB();
    dbs.fileHistoryTbl.store.set("v1\ta.md", { op: "upload" });
    dbs.fileHistoryTbl.store.set("v1\tb.md", { op: "download" });
    dbs.fileHistoryTbl.store.set("v2\tc.md", { op: "upload" });
    await clearFileHistoryOfEverythingByVault(asDB(dbs), "v1");
    assert.deepStrictEqual(Array.from(dbs.fileHistoryTbl.store.keys()), [
      "v2\tc.md",
    ]);
  });
});

/**
 * The tests below run the real localforage instances created by prepareDBs,
 * backed by the in-memory localStorage shim from _globalsSetup. This is the
 * only way to reach the internal (non-exported) helpers
 * `fromSyncMappingsToPrevSyncRecords` and `migrateDBs*`.
 */
describe("localdb: prepareDBs and migrations (real localforage)", () => {
  beforeEach(() => {
    memoryLocalStorage.clear();
  });

  it("should generate and persist a vaultRandomID for a new vault", async () => {
    const { db, vaultRandomID } = await prepareDBs("vaultNew", "", "prof1");
    assert.ok(vaultRandomID.length > 0);
    assert.equal(
      await db.vaultRandomIDMappingTbl.getItem(`path2id\tvaultNew`),
      vaultRandomID
    );
    assert.equal(
      await db.vaultRandomIDMappingTbl.getItem(`id2path\t${vaultRandomID}`),
      "vaultNew"
    );
    assert.equal(
      await db.versionTbl.getItem(`${vaultRandomID}\tversion`),
      DEFAULT_DB_VERSION_NUMBER
    );

    // calling again returns the same id (from the mapping table)
    const again = await prepareDBs("vaultNew", "", "prof1");
    assert.equal(again.vaultRandomID, vaultRandomID);
  });

  it("should reuse the id from an old config file", async () => {
    const { vaultRandomID } = await prepareDBs(
      "vaultOldCfg",
      "fixed-id-123",
      "prof1"
    );
    assert.equal(vaultRandomID, "fixed-id-123");
    // but an existing mapping wins over the old config id
    const again = await prepareDBs("vaultOldCfg", "other-id", "prof1");
    assert.equal(again.vaultRandomID, "fixed-id-123");
  });

  it("should generate different ids for different vault paths", async () => {
    const a = await prepareDBs("vaultA", "", "prof1");
    const b = await prepareDBs("vaultB", "", "prof1");
    assert.notEqual(a.vaultRandomID, b.vaultRandomID);
  });

  it("should migrate 20220326 -> 20240220 with no old mappings", async () => {
    const { db, vaultRandomID } = await prepareDBs(
      "vaultMigEmpty",
      "",
      "prof1"
    );
    await db.versionTbl.setItem(`${vaultRandomID}\tversion`, 20220326);
    const { db: db2 } = await prepareDBs("vaultMigEmpty", "", "prof1");
    assert.equal(
      await db2.versionTbl.getItem(`${vaultRandomID}\tversion`),
      DEFAULT_DB_VERSION_NUMBER
    );
    assert.deepStrictEqual(
      await getAllPrevSyncRecordsByVaultAndProfile(db2, vaultRandomID, "prof1"),
      []
    );
  });

  it("should convert sync mappings to prevSync records on migration", async () => {
    const { db, vaultRandomID } = await prepareDBs(
      "vaultMigMulti",
      "",
      "prof1"
    );

    const m1 = {
      localKey: "f1.md",
      remoteKey: "r1.md",
      localSize: 10,
      remoteSize: 40,
      localMtime: 111,
      remoteMtime: 222,
      remoteExtraKey: "etag1",
      remoteType: "onedrive",
      keyType: "file",
      vaultRandomID: vaultRandomID,
    };
    // empty remoteKey -> keyRaw/sizeRaw fall back to the local ones
    const m2 = {
      localKey: "dir/",
      remoteKey: "",
      localSize: 0,
      remoteSize: 0,
      localMtime: 333,
      remoteMtime: 444,
      remoteExtraKey: "",
      remoteType: "onedrive",
      keyType: "folder",
      vaultRandomID: vaultRandomID,
    };
    await db.syncMappingTbl.setItem(`${vaultRandomID}\tf1.md`, m1);
    await db.syncMappingTbl.setItem(`${vaultRandomID}\tdir/`, m2);
    // another vault's mapping must be ignored (prefix filter)
    await db.syncMappingTbl.setItem("otherVault\tx", {
      ...m1,
      localKey: "other.md",
    });
    await db.versionTbl.setItem(`${vaultRandomID}\tversion`, 20220326);

    const { db: db2 } = await prepareDBs("vaultMigMulti", "", "prof1");

    const records = await getAllPrevSyncRecordsByVaultAndProfile(
      db2,
      vaultRandomID,
      "prof1"
    );
    assert.equal(records.length, 2);
    const byKey: Record<string, Entity> = {};
    for (const r of records) {
      byKey[r.key as string] = r;
    }
    assert.deepStrictEqual(byKey["f1.md"], {
      key: "f1.md",
      keyEnc: "r1.md",
      keyRaw: "r1.md",
      mtimeCli: 111,
      mtimeSvr: 222,
      size: 10,
      sizeEnc: 40,
      sizeRaw: 40,
      etag: "etag1",
    });
    assert.deepStrictEqual(byKey["dir/"], {
      key: "dir/",
      keyEnc: "",
      keyRaw: "dir/", // fallback to localKey
      mtimeCli: 333,
      mtimeSvr: 444,
      size: 0,
      sizeEnc: 0,
      sizeRaw: 0, // fallback to localSize
      etag: "",
    });

    // version bumped
    assert.equal(
      await db2.versionTbl.getItem(`${vaultRandomID}\tversion`),
      DEFAULT_DB_VERSION_NUMBER
    );
    // old sync mappings are kept (for downgrade opportunity)
    const oldMappings = await getAllSyncMetaMappingByVault(db2, vaultRandomID);
    assert.equal(oldMappings.length, 2);

    // running prepareDBs a third time is a no-op (already at newest version)
    const { db: db3 } = await prepareDBs("vaultMigMulti", "", "prof1");
    const records3 = await getAllPrevSyncRecordsByVaultAndProfile(
      db3,
      vaultRandomID,
      "prof1"
    );
    assert.equal(records3.length, 2);
  });

  it("should reject a too-old internal db version", async () => {
    const { db, vaultRandomID } = await prepareDBs("vaultErr1", "", "p");
    await db.versionTbl.setItem(`${vaultRandomID}\tversion`, 20211114);
    await assert.rejects(prepareDBs("vaultErr1", "", "p"), /very old version/);
  });

  it("should reject an unsupported version jump", async () => {
    const { db, vaultRandomID } = await prepareDBs("vaultErr2", "", "p");
    await db.versionTbl.setItem(`${vaultRandomID}\tversion`, 20230601);
    await assert.rejects(
      prepareDBs("vaultErr2", "", "p"),
      /not supported internal db changes from 20230601 to 20240220/
    );
  });

  it("should reject a downgrade", async () => {
    const { db, vaultRandomID } = await prepareDBs("vaultErr3", "", "p");
    await db.versionTbl.setItem(`${vaultRandomID}\tversion`, 20250101);
    await assert.rejects(prepareDBs("vaultErr3", "", "p"), /downgrade/);
  });
});
