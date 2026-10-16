// Headless CLI local-filesystem adapter (Phase B Milestone 2).
//
// `NodeFs extends FakeFs` — a real-Node implementation of the local side of the
// sync contract, decoupled from the Obsidian Vault API that `src/fsLocal.ts`
// (FakeFsLocal) depends on. The CLI syncs vault CONTENT only: it does NOT
// replicate FakeFsLocal's syncObsidianConfig / syncBookmarks /
// syncThirdPartyPlugins / syncSelfPlugin / syncAppearance machinery (those walk
// `.obsidian/` via `listFilesInObsFolder`, which is Vault-coupled and out of
// scope for the headless CLI).
//
// All abstract methods are implemented via `node:fs/promises`. Keys are
// vault-relative (no leading slash, forward slashes, folders end with "/"),
// matching the convention `src/fsLocal.ts` and `src/fsOnedrive.ts` expect —
// `sync.ts` relies on the trailing-slash folder convention.
//
// Entity shapes mirror `src/fsLocal.ts` EXACTLY (walk + stat) so `sync.ts`
// consumes them without shape drift; typecheck will NOT catch a missing field,
// so the field set here is deliberately copied field-for-field.

import { promises as fs } from "node:fs";
import path from "node:path";
import { type Entity, type RenameOpts, isDebugFolderPath } from "../src/baseTypes";
import { FakeFs } from "../src/fsAll";
import type { Profiler } from "../src/profiler";

/**
 * Format a unix-ms timestamp as an ISO string.
 *
 * `src/fsLocal.ts` uses `unixTimeToStr` (misc.ts), which calls
 * `window.moment(x).toISOString(true)` (timezone-offset ISO). The headless CLI
 * does NOT stub `window.moment`, so we cannot call `unixTimeToStr` here. The
 * `*Fmt` Entity fields are display/debug-only — sync logic reads the numeric
 * `*Cli`/`*Svr` fields — so a UTC ISO string is a safe, dependency-free
 * stand-in. This is a deliberate, documented divergence from fsLocal.
 */
function nodeUnixTimeToStr(ms: number | undefined | null): string | undefined {
  if (ms === undefined || ms === null || Number.isNaN(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

export class NodeFs extends FakeFs {
  kind = "local" as const;
  vaultRootPath: string;
  profiler: Profiler | undefined;

  constructor(vaultRootPath: string, profiler?: Profiler) {
    super();
    this.vaultRootPath = vaultRootPath;
    this.profiler = profiler;
  }

  /** Resolve a vault-relative key to an absolute filesystem path.
   *  Trailing "/" (folder keys) is stripped — `path.join` does this, and
   *  `fs` APIs accept either form on a path. */
  private resolve(key: string): string {
    // Split on "/" (vault keys use forward slashes) and join with the
    // platform separator so Windows backslash roots work.
    const rel = key.replace(/\/+$/, "");
    return path.join(this.vaultRootPath, ...rel.split("/"));
  }

  async walk(): Promise<Entity[]> {
    const out: Entity[] = [];
    const walkDir = async (relDir: string): Promise<void> => {
      const absDir = relDir === "" ? this.vaultRootPath : this.resolve(relDir);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        // A missing/unreadable dir yields nothing (mirrors vault behavior).
        return;
      }
      for (const entry of entries) {
        // Build the vault-relative key with forward slashes.
        const baseName = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
        let r: Entity | undefined = undefined;
        if (entry.isFile()) {
          const st = await fs.stat(this.resolve(baseName));
          // Mirror fsLocal.walk mtime logic: mtime, fall back to ctime, throw on 0.
          let mtimeLocal: number = st.mtimeMs;
          if (mtimeLocal <= 0) {
            mtimeLocal = st.ctimeMs;
          }
          if (mtimeLocal === 0) {
            throw Error(
              `Your file has last modified time 0: ${baseName}, don't know how to deal with it`
            );
          }
          r = {
            key: baseName, // local always unencrypted
            keyRaw: baseName,
            mtimeCli: mtimeLocal,
            mtimeSvr: mtimeLocal,
            size: st.size, // local always unencrypted
            sizeRaw: st.size,
          };
        } else if (entry.isDirectory()) {
          const folderKey = `${baseName}/`;
          r = {
            key: folderKey,
            keyRaw: folderKey,
            size: 0,
            sizeRaw: 0,
          };
        } else {
          // Symlinks / sockets / etc. — not synced (vault only has files+folders).
          continue;
        }
        // Debug export folder never participates in sync (mirrors fsLocal.walk).
        if (isDebugFolderPath(r.keyRaw!)) {
          // Still recurse? No — fsLocal skips the entry entirely (it is a
          // debug OUTPUT folder). Do not descend into it.
          continue;
        }
        out.push(r);
        if (entry.isDirectory()) {
          await walkDir(baseName);
        }
      }
    };
    await walkDir("");
    return out;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const abs = this.resolve(key);
    const st = await fs.stat(abs);
    const isFolder = st.isDirectory();
    const folderKey = isFolder ? `${key.replace(/\/+$/, "")}/` : key;
    return {
      key: folderKey, // local always unencrypted
      keyRaw: folderKey,
      ctimeCli: st.ctimeMs,
      mtimeCli: st.mtimeMs,
      mtimeSvr: st.mtimeMs,
      // See nodeUnixTimeToStr: UTC ISO stand-in (CLI has no window.moment).
      ctimeCliFmt: nodeUnixTimeToStr(st.ctimeMs),
      mtimeCliFmt: nodeUnixTimeToStr(st.mtimeMs),
      mtimeSvrFmt: nodeUnixTimeToStr(st.mtimeMs),
      size: st.size, // local always unencrypted
      sizeRaw: st.size,
    };
  }

  async mkdir(key: string, _mtime?: number, _ctime?: number): Promise<Entity> {
    // fsLocal.mkdir also ignores mtime/ctime (mkdirpInVault has no time args).
    await fs.mkdir(this.resolve(key), { recursive: true });
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    _ctime: number,
    _expectedEtag?: string
  ): Promise<Entity> {
    const abs = this.resolve(key);
    // Ensure the parent directory exists (fsLocal uses mkdirpInVault for this).
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // ArrayBuffer → Buffer. Node's fs.writeFile accepts an ArrayBuffer-backed
    // view; wrap in Buffer.from so byteOffset/byteLength are honored.
    await fs.writeFile(abs, Buffer.from(content));
    // Set mtime. fs.utimes takes SECONDS; Obsidian mtime is ms.
    const atimeSec = Date.now() / 1000;
    const mtimeSec = mtime / 1000;
    await fs.utimes(abs, atimeSec, mtimeSec);
    // ctime is system-managed on most filesystems (birth time where the FS
    // supports it, otherwise the inode-change time from the writeFile). We do
    // NOT fake it — fsLocal relies on the Vault adapter's ctime which is also
    // OS-derived. Documented limitation, not a bug.
    // expectedEtag is ignored — local fs has no etag (fsLocal ignores it too).
    return await this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.resolve(key));
    // Buffer → ArrayBuffer. buf.buffer is the shared pool backing; slice the
    // exact [byteOffset, byteOffset+byteLength) range so callers don't see
    // neighboring pool bytes. Mirrors misc.bufferToArrayBuffer.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async rename(key1: string, key2: string, _opts?: RenameOpts): Promise<void> {
    // fsLocal ignores _opts; so do we. Note: fs.rename requires the parent of
    // key2 to already exist — sync creates folders before files, so this holds.
    await fs.rename(this.resolve(key1), this.resolve(key2));
  }

  async rm(key: string): Promise<void> {
    // DIVERGENCE from fsLocal: fsLocal moves to Obsidian trash
    // (vault.adapter.trashLocal / trashSystem). The CLI has no Obsidian trash,
    // so this is a DIRECT recursive delete (fs.rm recursive+force). Deliberate
    // CLI divergence — documented, not faked.
    await fs.rm(this.resolve(key), { recursive: true, force: true });
  }

  async checkConnect(_callbackFunc?: (err: unknown) => void): Promise<boolean> {
    return true;
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
