// Headless CLI state-DB adapter (Phase B Milestone 2.5).
//
// `FileForage` is a JSON-file-backed stand-in for a localforage table
// (LocalForage instance), including the getItems()/removeItems() prototype
// extensions that src/localdb.ts installs via localforage-getitems /
// localforage-removeitems. The in-memory Map is the source of truth while the
// process runs; writes are debounced to a per-table JSON file so rapid
// setItem bursts don't cause write amplification, and `flush()` force-writes
// for clean shutdown + tests.
//
// `NodeDb implements InternalDBs` wires up one FileForage per table, using the
// EXACT store-name strings src/localdb.ts passes to localforage.createInstance
// (imported as the DEFAULT_TBL_* constants) so a future shared-state migration
// between the Obsidian IndexedDB backend and this file backend stays possible.
//
// Q5 design (DECIDED): single JSON file per table — vault-scale state is
// small and there is no native dependency (no better-sqlite3 / lmdb). The
// debounced persist avoids write-amplification on rapid setItem bursts.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { InternalDBs, LocalForage } from "../src/localdb";
import {
  DEFAULT_TBL_FILE_CONTENT_HISTORY,
  DEFAULT_TBL_FILE_HISTORY,
  DEFAULT_TBL_LOGGER_OUTPUT,
  DEFAULT_TBL_PREV_SYNC_RECORDS,
  DEFAULT_TBL_PROFILER_RESULTS,
  DEFAULT_TBL_SIMPLE_KV_FOR_MISC,
  DEFAULT_TBL_SYNC_MAPPING,
  DEFAULT_TBL_VERSION,
  DEFAULT_SYNC_PLANS_HISTORY,
  DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING,
} from "../src/localdb";

/** Debounce window (ms) for coalescing rapid setItem/removeItem bursts. */
const PERSIST_DEBOUNCE_MS = 80;

/**
 * JSON-file-backed localforage-table stand-in. One file per table:
 * `${baseDir}/${storeName}.json` holds a single JSON object (key → value).
 *
 * Semantics mirror the LocalForage shape src/localdb.ts relies on:
 *  - getItem returns `null` for a missing key (localdb normalizes null →
 *    undefined downstream where it matters, e.g. getPrevRemoteEntities).
 *  - getItems()/removeItems() are real methods (localforage-getitems /
 *    localforage-removeitems prototype extensions) — localdb calls them
 *    directly, and typecheck will NOT catch a missing/misspelled method because
 *    they're declared on a `typeof localforage` prototype, so they MUST be
 *    present with the exact signatures from tests/_dbMock.ts.
 */
export class FileForage {
  private readonly storeName: string;
  private readonly baseDir: string;
  private readonly filePath: string;
  private readonly map = new Map<string, unknown>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(storeName: string, baseDir: string) {
    this.storeName = storeName;
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, `${storeName}.json`);
  }

  /** Lazily read the JSON file into the in-memory Map (once per instance). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
    this.loaded = true;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const txt = await fs.readFile(this.filePath, "utf8");
      if (txt && txt.trim().length > 0) {
        const obj = JSON.parse(txt) as Record<string, unknown>;
        for (const k of Object.getOwnPropertyNames(obj)) {
          this.map.set(k, obj[k]);
        }
      }
    } catch {
      // Missing / empty / corrupt file → start empty. Never throw: a fresh
      // vault (no prior sync state) must not crash the CLI on first run.
    }
  }

  /** Mark the table dirty and schedule a debounced persist. */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) {
        this.dirty = false;
        void this.persistToDisk();
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistToDisk(): Promise<void> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.map) obj[k] = v;
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(obj), "utf8");
  }

  /** Force-write any pending changes (for clean shutdown + tests). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      await this.persistToDisk();
    }
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    await this.ensureLoaded();
    return this.map.has(key) ? (this.map.get(key) as T) : null;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<T> {
    await this.ensureLoaded();
    this.map.set(key, value);
    this.schedulePersist();
    return value;
  }

  async removeItem(key: string): Promise<void> {
    await this.ensureLoaded();
    this.map.delete(key);
    this.schedulePersist();
  }

  /**
   * localforage-getitems extension. With no argument (or null/undefined)
   * returns ALL items as a key → value record; with an array, returns only
   * the given keys (missing keys simply omitted). Mirrors _dbMock.getItems.
   */
  async getItems(keys?: string[] | null): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const res: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [k, v] of this.map) res[k] = v;
    } else {
      for (const k of keys) {
        if (this.map.has(k)) res[k] = this.map.get(k);
      }
    }
    return res;
  }

  /**
   * localforage-removeitems extension. With no argument (or null/undefined)
   * clears ALL items; with an array, removes only the given keys. Mirrors
   * _dbMock.removeItems (localdb calls `removeItems(keys)` and
   * `removeItems(undefined)`-style via .clear() elsewhere).
   */
  async removeItems(keys?: string[] | null): Promise<void> {
    await this.ensureLoaded();
    if (keys === undefined || keys === null) {
      this.map.clear();
    } else {
      for (const k of keys) this.map.delete(k);
    }
    this.schedulePersist();
  }

  async keys(): Promise<string[]> {
    await this.ensureLoaded();
    return Array.from(this.map.keys());
  }

  async iterate<T = unknown>(
    cb: (value: T, key: string, iterationNumber: number) => unknown | Promise<unknown>,
  ): Promise<void> {
    await this.ensureLoaded();
    let i = 0;
    for (const [k, v] of this.map) {
      await cb(v as T, k, i);
      i += 1;
    }
  }

  async length(): Promise<number> {
    await this.ensureLoaded();
    return this.map.size;
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.map.clear();
    this.schedulePersist();
  }
}

/**
 * `NodeDb implements InternalDBs` — one FileForage per table. storeNames are
 * the EXACT strings src/localdb.ts passes to localforage.createInstance
 * (imported as DEFAULT_TBL_* constants) so the file backend and the IndexedDB
 * backend name the same logical tables — a prerequisite for any future
 * shared-state migration between Obsidian (IndexedDB) and the CLI (files).
 */
export class NodeDb implements InternalDBs {
  versionTbl: LocalForage;
  syncPlansTbl: LocalForage;
  vaultRandomIDMappingTbl: LocalForage;
  loggerOutputTbl: LocalForage;
  simpleKVForMiscTbl: LocalForage;
  prevSyncRecordsTbl: LocalForage;
  profilerResultsTbl: LocalForage;
  fileContentHistoryTbl: LocalForage;
  fileHistoryTbl: LocalForage;
  syncMappingTbl: LocalForage;

  /** The actual FileForage instances (for flushAll / direct access). */
  private readonly tables: FileForage[] = [];

  constructor(baseDir: string) {
    this.versionTbl = this.mk(DEFAULT_TBL_VERSION, baseDir);
    this.syncPlansTbl = this.mk(DEFAULT_SYNC_PLANS_HISTORY, baseDir);
    this.vaultRandomIDMappingTbl = this.mk(
      DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING,
      baseDir,
    );
    this.loggerOutputTbl = this.mk(DEFAULT_TBL_LOGGER_OUTPUT, baseDir);
    this.simpleKVForMiscTbl = this.mk(DEFAULT_TBL_SIMPLE_KV_FOR_MISC, baseDir);
    this.prevSyncRecordsTbl = this.mk(DEFAULT_TBL_PREV_SYNC_RECORDS, baseDir);
    this.profilerResultsTbl = this.mk(DEFAULT_TBL_PROFILER_RESULTS, baseDir);
    this.fileHistoryTbl = this.mk(DEFAULT_TBL_FILE_HISTORY, baseDir);
    this.syncMappingTbl = this.mk(DEFAULT_TBL_SYNC_MAPPING, baseDir);
    this.fileContentHistoryTbl = this.mk(
      DEFAULT_TBL_FILE_CONTENT_HISTORY,
      baseDir,
    );
  }

  private mk(storeName: string, baseDir: string): LocalForage {
    const f = new FileForage(storeName, baseDir);
    this.tables.push(f);
    return f as unknown as LocalForage;
  }

  /** Force-persist every table (clean shutdown / test gate). */
  async flushAll(): Promise<void> {
    await Promise.all(this.tables.map((t) => t.flush()));
  }
}
