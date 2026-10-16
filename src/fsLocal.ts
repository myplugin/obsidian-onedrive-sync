import { type Entity, type RenameOpts, isDebugFolderPath } from "./baseTypes";
import { FakeFs } from "./fsAll";

import { TFile, TFolder, type Vault } from "obsidian";
import { mkdirpInVault, statFix, unixTimeToStr } from "./misc";
import { listFilesInObsFolder } from "./obsFolderLister";
import type { Profiler } from "./profiler";

export class FakeFsLocal extends FakeFs {
  vault: Vault;
  syncObsidianConfig: boolean;
  syncThirdPartyPlugins: boolean;
  syncSelfPlugin: boolean;
  syncBookmarks: boolean;
  syncAppearance: boolean;
  configDir: string;
  pluginID: string;
  profiler: Profiler | undefined;
  deleteToWhere: "obsidian" | "system";
  kind: "local";
  constructor(
    vault: Vault,
    syncObsidianConfig: boolean,
    syncThirdPartyPlugins: boolean,
    syncSelfPlugin: boolean,
    syncBookmarks: boolean,
    syncAppearance: boolean,
    configDir: string,
    pluginID: string,
    profiler: Profiler | undefined,
    deleteToWhere: "obsidian" | "system"
  ) {
    super();

    this.vault = vault;
    this.syncObsidianConfig = syncObsidianConfig;
    this.syncThirdPartyPlugins = syncThirdPartyPlugins;
    this.syncSelfPlugin = syncSelfPlugin;
    this.syncBookmarks = syncBookmarks;
    this.syncAppearance = syncAppearance;
    this.configDir = configDir;
    this.pluginID = pluginID;
    this.profiler = profiler;
    this.deleteToWhere = deleteToWhere;
    this.kind = "local";
  }

  async walk(): Promise<Entity[]> {
    this.profiler?.addIndent();
    this.profiler?.insert("enter walk for local");
    const local: Entity[] = [];

    const localTAbstractFiles = this.vault.getAllLoadedFiles();
    this.profiler?.insert("finish getting walk for local");
    for (const entry of localTAbstractFiles) {
      let r: Entity | undefined = undefined;
      let key = entry.path;
      if (key.startsWith("/")) {
        // why?
        // just remove leading slash /
        key = key.slice(1);
      }

      if (entry.path === "/" || entry.path === "") {
        // ignore
        continue;
      } else if (entry instanceof TFile) {
        let mtimeLocal: number | undefined = entry.stat.mtime;
        if (mtimeLocal <= 0) {
          mtimeLocal = entry.stat.ctime;
        }
        if (mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        if (mtimeLocal === undefined) {
          throw Error(
            `Your file has last modified time 0: ${key}, don't know how to deal with it`
          );
        }
        r = {
          key: key, // local always unencrypted
          keyRaw: key,
          mtimeCli: mtimeLocal,
          mtimeSvr: mtimeLocal,
          size: entry.stat.size, // local always unencrypted
          sizeRaw: entry.stat.size,
        };
      } else if (entry instanceof TFolder) {
        key = `${key}/`;
        r = {
          key: key,
          keyRaw: key,
          size: 0,
          sizeRaw: 0,
        };
      } else {
        throw Error(`unexpected ${entry.path}`);
      }

      if (isDebugFolderPath(r.keyRaw)) {
        continue; // debug export folder never participates in sync
      }
      local.push(r);
    }

    this.profiler?.insert("finish transforming walk for local");

    if (
      this.syncObsidianConfig ||
      this.syncBookmarks ||
      this.syncThirdPartyPlugins ||
      this.syncSelfPlugin ||
      this.syncAppearance
    ) {
      this.profiler?.insert("into obsidian config sync");
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        this.syncObsidianConfig,
        this.syncAppearance,
        this.syncBookmarks,
        this.syncThirdPartyPlugins,
        this.syncSelfPlugin
      );
      // console.debug(`syncFiles in obs: ${JSON.stringify(syncFiles, null, 2)}`);
      for (const f of syncFiles) {
        local.push(f);
      }
      this.profiler?.insert("finish syncConfigDir");
    }

    this.profiler?.insert("finish walk for local");
    this.profiler?.removeIndent();
    return local;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const statRes = await statFix(this.vault, key);
    if (statRes === undefined || statRes === null) {
      throw Error(`${key} does not exist! cannot stat for local`);
    }
    const isFolder = statRes.type === "folder";
    return {
      key: isFolder ? `${key}/` : key, // local always unencrypted
      keyRaw: isFolder ? `${key}/` : key,
      ctimeCli: statRes.ctime,
      mtimeCli: statRes.mtime,
      mtimeSvr: statRes.mtime,
      ctimeCliFmt: unixTimeToStr(statRes.ctime),
      mtimeCliFmt: unixTimeToStr(statRes.mtime),
      mtimeSvrFmt: unixTimeToStr(statRes.mtime),
      size: statRes.size, // local always unencrypted
      sizeRaw: statRes.size,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    // console.debug(`mkdir: ${key}`);
    await mkdirpInVault(key, this.vault);
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expectedEtag?: string
  ): Promise<Entity> {
    await this.vault.adapter.writeBinary(key, content, {
      mtime: mtime,
      ctime: ctime,
    });
    return await this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    try {
      return await this.vault.adapter.readBinary(key);
    } catch (e) {
      // A file the walk saw but that vanished before this read is a TOCTOU
      // race — confirm via stat and surface LOCAL_NOT_FOUND (thrown by
      // statFix) so sync skips it gracefully, mirroring REMOTE_NOT_FOUND.
      // If stat succeeds the file exists but is unreadable: rethrow the
      // original error unchanged (a real error, not a race).
      await statFix(this.vault, key);
      throw e;
    }
  }

  async rename(key1: string, key2: string, _opts?: RenameOpts): Promise<void> {
    try {
      return await this.vault.adapter.rename(key1, key2);
    } catch (e) {
      // If the source vanished between walk and this rename, surface
      // LOCAL_NOT_FOUND (thrown by statFix) so sync skips it gracefully.
      // If the source still exists, the rename failed for a real reason:
      // rethrow unchanged.
      await statFix(this.vault, key1);
      throw e;
    }
  }

  async rm(key: string): Promise<void> {
    try {
      if (this.deleteToWhere === "obsidian") {
        await this.vault.adapter.trashLocal(key);
      } else {
        // "system"
        if (!(await this.vault.adapter.trashSystem(key))) {
          await this.vault.adapter.trashLocal(key);
        }
      }
    } catch (e) {
      // If the file vanished between walk and this delete, it is already in
      // the desired (gone) state — succeed silently, mirroring the remote
      // _deleteJson 404→success idempotency. If it still exists, the delete
      // failed for a real reason (permissions, IO): rethrow unchanged.
      try {
        await statFix(this.vault, key);
      } catch {
        return; // gone — idempotent success
      }
      throw e;
    }
  }
  async checkConnect(callbackFunc?: (err: unknown) => void): Promise<boolean> {
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
