import { nanoid } from "nanoid";
import type {
  BatchRenameOp,
  BatchRenameResult,
  Entity,
  RenameOpts,
} from "./baseTypes";
import { debugInfo } from "./logger";
import { deepEqual } from "./misc";

export abstract class FakeFs {
  abstract kind: string;
  /**
   * The result of the most recent walk() call. Set by implementations that
   * support incremental enumeration (e.g. FakeFsOnedrive). main.ts saves this
   * to the DB after sync so the next sync can use it as prevRemoteEntities.
   */
  lastWalkResult?: Entity[];
  /**
   * Number of items returned by the delta API in the last walk().
   * 0 = incremental query returned no remote changes (safe to skip sync).
   * undefined = full enumeration (first sync or deltaLink expired, cannot skip).
   * Set by FakeFsOnedrive.walk() for use by shouldSkipSync in sync.ts.
   */
  lastWalkDeltaCount?: number;
  /**
   * Keys deleted on the remote during the current sync (via rm()).
   * main.ts uses this after sync to remove deleted entries from
   * lastWalkResult before saving as prevRemoteEntities — preventing
   * phantom entries that cause 404 on the next sync when OneDrive's
   * delta API hasn't yet reflected the deletions (eventual consistency).
   */
  deletedRemotelyKeys: Set<string> = new Set();
  /**
   * Entities uploaded to the remote during the current sync (via writeFile).
   * main.ts uses this after sync to ADD uploaded entries to
   * lastWalkResult before saving as prevRemoteEntities — preventing
   * the next sync from seeing just-uploaded files as "remote deleted"
   * when OneDrive's delta API hasn't yet reflected the uploads
   * (eventual consistency lag, especially with syncOnSave rapid re-sync).
   */
  uploadedEntities: Entity[] = [];
  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expectedEtag?: string
  ): Promise<Entity>;
  abstract readFile(key: string): Promise<ArrayBuffer>;
  /**
   * Combined stat + readFile in one call. Default implementation does two
   * separate calls; backends that can fetch metadata + content in a single
   * API request (e.g. OneDrive's $select with @microsoft.graph.downloadUrl)
   * should override this to save one HTTP round-trip per file download.
   */
  async readFileWithStat(
    key: string
  ): Promise<{ entity: Entity; content: ArrayBuffer }> {
    const entity = await this.stat(key);
    const content = await this.readFile(key);
    return { entity, content };
  }
  abstract rename(key1: string, key2: string, opts?: RenameOpts): Promise<void>;
  /** Batch rename/move multiple files in one call. Default implementation
   *  calls rename() sequentially; backends that support batching (e.g.
   *  OneDrive's $batch endpoint) should override for fewer HTTP round-trips. */
  async batchRename(ops: BatchRenameOp[]): Promise<BatchRenameResult[]> {
    const results: BatchRenameResult[] = [];
    for (const op of ops) {
      try {
        await this.rename(op.key1, op.key2, {
          sourceRemoteId: op.sourceRemoteId,
          targetParentRemoteId: op.targetParentRemoteId,
        });
        results.push({ ok: true, status: 200 });
      } catch (e: unknown) {
        results.push({
          ok: false,
          status: 0,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }
    return results;
  }
  abstract rm(key: string): Promise<void>;
  abstract checkConnect(callbackFunc?: (err: unknown) => void): Promise<boolean>;
  async checkConnectCommonOps(callbackFunc?: (err: unknown) => void) {
    const folderName = `rs-test-folder-${nanoid()}/`;
    const filename = `${folderName}rs-test-file-${nanoid()}`;
    try {
      debugInfo(`check connect: create folder`);
      await this.mkdir(folderName);

      debugInfo(`check connect: upload file`);
      const ctime = Date.now();
      const mtime1 = Date.now();
      const content1 = new ArrayBuffer(100);
      await this.writeFile(filename, content1, mtime1, ctime);

      debugInfo(`check connect: overwrite file`);
      const mtime2 = Date.now();
      const content2 = new ArrayBuffer(200);
      await this.writeFile(filename, content2, mtime2, ctime);

      debugInfo(`check connect: download file`);
      const content3 = await this.readFile(filename);
      if (!deepEqual(content2, content3)) {
        throw Error(`downloaded file is not equal with uploaded file!`);
      }

      return true;
    } catch (err) {
      console.error(err);
      callbackFunc?.(err);
      return false;
    } finally {
      // 兜底清理：无论检查成功或失败，都删除测试文件与文件夹，避免远程残留。
      // 清理自身的错误不掩盖真正的检查结果，仅记录日志。
      debugInfo(`check connect: cleanup file`);
      try {
        await this.rm(filename);
      } catch (e) {
        console.warn(
          `check connect: cleanup file failed (ignored): ${String(e)}`
        );
      }
      debugInfo(`check connect: cleanup folder`);
      try {
        await this.rm(folderName);
      } catch (e) {
        console.warn(
          `check connect: cleanup folder failed (ignored): ${String(e)}`
        );
      }
    }
  }
  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<void>;
  abstract allowEmptyFile(): boolean;
}
