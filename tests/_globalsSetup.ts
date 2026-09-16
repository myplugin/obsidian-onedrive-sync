/**
 * Minimal browser-like globals so that some src modules can be imported
 * and executed under plain Node.js (mocha + tsx).
 *
 * IMPORTANT: this file must be imported BEFORE any module that (even
 * indirectly) imports src/encryptRClone.ts, because the rclone worker module
 * (src/encryptRClone.worker.ts) touches `self.addEventListener(...)` at
 * module top level, and localforage (used by src/localdb.ts) needs a
 * Web Storage API (`localStorage`) implementation to be usable in Node.
 *
 * Importing this file has no effect if the globals already exist.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// 1. `self` stub: src/encryptRClone.worker.ts registers a "message" listener
//    on `self` at import time. A no-op EventTarget-like stub is enough since
//    the tests never post messages to the worker.
if ((globalThis as any).self === undefined) {
  (globalThis as any).self = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

// 2. `window.crypto`: src/encryptOpenSSL.ts calls window.crypto.subtle and
//    window.crypto.getRandomValues. Node's webcrypto implementation provides
//    both.
if ((globalThis as any).window === undefined) {
  (globalThis as any).window = {
    crypto: require("node:crypto").webcrypto,
  };
}

/**
 * In-memory implementation of the Web Storage API, used as a `localStorage`
 * shim so localforage falls back to its localStorage driver in Node.js
 * (neither indexedDB nor openDatabase are available there).
 */
export class MemoryStorage {
  private map: Map<string, string> = new Map();

  get length(): number {
    return this.map.size;
  }

  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }

  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }

  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }

  removeItem(k: string): void {
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}

export const memoryLocalStorage = new MemoryStorage();

if ((globalThis as any).localStorage === undefined) {
  (globalThis as any).localStorage = memoryLocalStorage;
}
