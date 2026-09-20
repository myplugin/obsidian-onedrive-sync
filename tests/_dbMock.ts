// Shared in-memory DB mock, extracted VERBATIM from tests/localdb.test.ts
// (plan Task 6 Step 3) so sync-level tests can reuse it.

import type { InternalDBs } from "../src/localdb";

/**
 * An in-memory stand-in for a localforage table (LocalForage instance),
 * including the getItems()/removeItems() prototype extensions that
 * src/localdb.ts installs via localforage-getitems/localforage-removeitems.
 */
export interface MockTbl {
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

export const createMockTbl = (): MockTbl => {
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

export type MockDBs = { [K in keyof InternalDBs]: MockTbl };

export const createMockDB = (): MockDBs => ({
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

export const asDB = (dbs: MockDBs): InternalDBs =>
  dbs as unknown as InternalDBs;
