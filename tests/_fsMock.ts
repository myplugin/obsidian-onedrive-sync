// Shared in-memory FakeFs mock, extracted VERBATIM in behavior from
// tests/conflictLogicFull.test.ts (plan Task 6 Step 3) so sync-level tests
// (tests/syncDispatchIfMatch.test.ts) can reuse the exact mock semantics:
// missing keys make stat() throw by default (which tryDuplicateFile relies
// on to find a usable ".dup" name), and write/rename calls are recorded.

import type { Entity } from "../src/baseTypes";
import { bufferToArrayBuffer } from "../src/misc";

export function str2ab(s: string): ArrayBuffer {
  return bufferToArrayBuffer(Buffer.from(s, "utf-8"));
}

export type StatMissingMode = "throw" | "undefined" | "null";

export interface MockFsOptions {
  /** How stat() behaves for missing keys. Default: throw. */
  statMissing?: StatMissingMode;
  /** Fields overridden on the entity returned by writeFile(). */
  writeReturn?: { mtimeCli?: number; ctimeCli?: number };
}

/**
 * Minimal in-memory FakeFs mock. Only the methods used by
 * conflictLogic (stat / readFile / writeFile / rename / rm) are
 * implemented. Missing keys make stat() throw by default, which is
 * what tryDuplicateFile relies on to find a usable ".dup" name.
 */
export function makeMockFs(
  kind: string,
  init: Record<string, string> = {},
  opts: MockFsOptions = {}
) {
  const files = new Map<string, ArrayBuffer>();
  for (const [k, v] of Object.entries(init)) {
    files.set(k, str2ab(v));
  }
  const writeCalls: {
    key: string;
    content: ArrayBuffer;
    mtime: number;
    ctime: number;
  }[] = [];
  const renameCalls: { from: string; to: string }[] = [];
  const statMissing = opts.statMissing ?? "throw";

  return {
    kind,
    files,
    writeCalls,
    // Alias of writeCalls (SAME array): sync-level tests assert via
    // __writes per plan Task 6; existing conflictLogicFull tests keep
    // using writeCalls.
    __writes: writeCalls,
    renameCalls,
    async stat(key: string): Promise<Entity> {
      const c = files.get(key);
      if (c === undefined) {
        if (statMissing === "undefined") {
          return undefined as any;
        }
        if (statMissing === "null") {
          return null as any;
        }
        throw Object.assign(new Error(`not found: ${key}`), {
          code: "FILE_NOT_FOUND",
        });
      }
      return {
        key,
        keyRaw: key,
        size: c.byteLength,
        sizeRaw: c.byteLength,
        mtimeCli: 1000,
        ctimeCli: 1000,
      };
    },
    async readFile(key: string): Promise<ArrayBuffer> {
      const c = files.get(key);
      if (c === undefined) {
        throw new Error(`not found: ${key}`);
      }
      return c;
    },
    async writeFile(
      key: string,
      content: ArrayBuffer,
      mtime: number,
      ctime: number
    ): Promise<Entity> {
      files.set(key, content);
      writeCalls.push({ key, content, mtime, ctime });
      return {
        key,
        keyRaw: key,
        size: content.byteLength,
        sizeRaw: content.byteLength,
        mtimeCli: mtime,
        ctimeCli: ctime,
        ...(opts.writeReturn ?? {}),
      };
    },
    async rename(key1: string, key2: string): Promise<void> {
      const c = files.get(key1);
      if (c === undefined) {
        throw new Error(`not found: ${key1}`);
      }
      files.delete(key1);
      files.set(key2, c);
      renameCalls.push({ from: key1, to: key2 });
    },
    async rm(key: string): Promise<void> {
      files.delete(key);
    },
  };
}
