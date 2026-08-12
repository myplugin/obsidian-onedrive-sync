import isEqual from "lodash/isEqual";
import { nanoid } from "nanoid";
import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
  abstract walk(): Promise<Entity[]>;
  abstract walkPartial(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity>;
  abstract readFile(key: string): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string): Promise<void>;
  abstract rm(key: string): Promise<void>;
  abstract checkConnect(callbackFunc?: any): Promise<boolean>;
  async checkConnectCommonOps(callbackFunc?: any) {
    const folderName = `rs-test-folder-${nanoid()}/`;
    const filename = `${folderName}rs-test-file-${nanoid()}`;
    try {
      console.info(`check connect: create folder`);
      await this.mkdir(folderName);

      console.info(`check connect: upload file`);
      const ctime = Date.now();
      const mtime1 = Date.now();
      const content1 = new ArrayBuffer(100);
      await this.writeFile(filename, content1, mtime1, ctime);

      console.info(`check connect: overwrite file`);
      const mtime2 = Date.now();
      const content2 = new ArrayBuffer(200);
      await this.writeFile(filename, content2, mtime2, ctime);

      console.info(`check connect: download file`);
      const content3 = await this.readFile(filename);
      if (!isEqual(content2, content3)) {
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
      console.info(`check connect: cleanup file`);
      try {
        await this.rm(filename);
      } catch (e) {
        console.warn(`check connect: cleanup file failed (ignored): ${e}`);
      }
      console.info(`check connect: cleanup folder`);
      try {
        await this.rm(folderName);
      } catch (e) {
        console.warn(`check connect: cleanup folder failed (ignored): ${e}`);
      }
    }
  }
  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<any>;
  abstract allowEmptyFile(): boolean;
}
