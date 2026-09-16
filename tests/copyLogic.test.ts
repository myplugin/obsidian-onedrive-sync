// Tests for src/copyLogic.ts — copyFile / copyFolder / copyFileOrFolder
// against minimal in-memory FakeFs mocks.

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import { copyFile, copyFileOrFolder, copyFolder } from "../src/copyLogic";
import { bufferToArrayBuffer } from "../src/misc";

const decoder = new TextDecoder();

function str2ab(s: string): ArrayBuffer {
  return bufferToArrayBuffer(Buffer.from(s, "utf-8"));
}

function ab2str(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

/**
 * Minimal in-memory FakeFs mock implementing only what copyLogic uses:
 * stat / readFile / writeFile / mkdir. Missing keys make stat() throw.
 */
function makeMockFs(kind: string, init: Record<string, string> = {}) {
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
  const mkdirCalls: { key: string; mtime?: number; ctime?: number }[] = [];

  return {
    kind,
    files,
    writeCalls,
    mkdirCalls,
    async stat(key: string): Promise<Entity> {
      const c = files.get(key);
      if (c === undefined) {
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
      };
    },
    async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
      mkdirCalls.push({ key, mtime, ctime });
      files.set(key, new ArrayBuffer(0));
      return {
        key,
        keyRaw: key,
        sizeRaw: 0,
        mtimeCli: mtime,
        ctimeCli: ctime,
      };
    },
    async rename(key1: string, key2: string): Promise<void> {
      const c = files.get(key1);
      if (c === undefined) {
        throw new Error(`not found: ${key1}`);
      }
      files.delete(key1);
      files.set(key2, c);
    },
    async rm(key: string): Promise<void> {
      files.delete(key);
    },
  };
}

describe("copyLogic: copyFile", () => {
  it("should copy content from left to right", async () => {
    const left = makeMockFs("left", { "dir/a.md": "hello world" });
    const right = makeMockFs("right");
    const res = await copyFile("dir/a.md", left as any, right as any);
    assert.equal(res.entity.key, "dir/a.md");
    assert.equal(res.entity.keyRaw, "dir/a.md");
    assert.equal(res.entity.sizeRaw, "hello world".length);
    assert.equal(res.entity.mtimeCli, 1000);
    assert.equal(ab2str(res.content), "hello world");
    assert.equal(
      ab2str(right.files.get("dir/a.md") as ArrayBuffer),
      "hello world"
    );
    assert.equal(right.writeCalls.length, 1);
    assert.equal(right.writeCalls[0].mtime, 1000);
    assert.equal(right.writeCalls[0].ctime, 1000);
  });

  it("should fall back to mtimeCli when ctimeCli is undefined", async () => {
    const left = makeMockFs("left", { "a.md": "x" });
    const origStat = left.stat;
    left.stat = async (key: string) => ({
      ...(await origStat(key)),
      mtimeCli: 4242,
      ctimeCli: undefined,
    });
    const right = makeMockFs("right");
    await copyFile("a.md", left as any, right as any);
    assert.equal(right.writeCalls.length, 1);
    assert.equal(right.writeCalls[0].mtime, 4242);
    assert.equal(right.writeCalls[0].ctime, 4242);
  });

  it("should throw when stat size does not match content length", async () => {
    const left = makeMockFs("left", { "a.md": "hello" });
    const origStat = left.stat;
    left.stat = async (key: string) => ({
      ...(await origStat(key)),
      size: 999,
    });
    const right = makeMockFs("right");
    await assert.rejects(
      copyFile("a.md", left as any, right as any),
      /size not matched/
    );
    assert.equal(right.writeCalls.length, 0);
  });

  it("should tolerate stat size of 0 or undefined (android quirk)", async () => {
    // size === 0 is filled in from the actual content length
    const left0 = makeMockFs("left", { "a.md": "hello" });
    const origStat0 = left0.stat;
    left0.stat = async (key: string) => ({
      ...(await origStat0(key)),
      size: 0,
    });
    const right0 = makeMockFs("right");
    const res0 = await copyFile("a.md", left0 as any, right0 as any);
    assert.equal(ab2str(res0.content), "hello");
    assert.equal(right0.writeCalls.length, 1);

    // size === undefined is filled in from the actual content length
    const leftU = makeMockFs("left", { "a.md": "hello" });
    const origStatU = leftU.stat;
    leftU.stat = async (key: string) => ({
      ...(await origStatU(key)),
      size: undefined,
    });
    const rightU = makeMockFs("right");
    const resU = await copyFile("a.md", leftU as any, rightU as any);
    assert.equal(ab2str(resU.content), "hello");
    assert.equal(rightU.writeCalls.length, 1);
  });

  it("should throw when mtimeCli is undefined", async () => {
    const left = makeMockFs("left", { "a.md": "hello" });
    const origStat = left.stat;
    left.stat = async (key: string) => ({
      ...(await origStat(key)),
      mtimeCli: undefined,
    });
    const right = makeMockFs("right");
    await assert.rejects(
      copyFile("a.md", left as any, right as any),
      /no mtimeCli/
    );
    assert.equal(right.writeCalls.length, 0);
  });

  it("should throw for folder keys", async () => {
    const m = makeMockFs("m", { "folder/": "" });
    await assert.rejects(
      copyFile("folder/", m as any, m as any),
      /should not call/
    );
  });

  it("should propagate stat errors for missing files", async () => {
    const left = makeMockFs("left");
    const right = makeMockFs("right");
    await assert.rejects(
      copyFile("missing.md", left as any, right as any),
      /not found/
    );
    assert.equal(right.writeCalls.length, 0);
  });
});

describe("copyLogic: copyFolder", () => {
  it("should create the folder on the right side", async () => {
    const left = makeMockFs("left", { "some/folder/": "" });
    const right = makeMockFs("right");
    const res = await copyFolder("some/folder/", left as any, right as any);
    assert.equal(res.entity.key, "some/folder/");
    assert.equal(res.content, undefined);
    assert.equal(right.mkdirCalls.length, 1);
    assert.equal(right.mkdirCalls[0].key, "some/folder/");
    assert.equal(right.mkdirCalls[0].mtime, 1000);
    assert.equal(right.writeCalls.length, 0);
    assert.ok(right.files.has("some/folder/"));
  });

  it("should pass through an undefined mtimeCli", async () => {
    const left = makeMockFs("left", { "f/": "" });
    const origStat = left.stat;
    left.stat = async (key: string) => ({
      ...(await origStat(key)),
      mtimeCli: undefined,
    });
    const right = makeMockFs("right");
    const res = await copyFolder("f/", left as any, right as any);
    assert.equal(right.mkdirCalls[0].mtime, undefined);
    assert.equal(res.entity.mtimeCli, undefined);
  });

  it("should throw for non-folder keys", async () => {
    const m = makeMockFs("m", { "a.md": "x" });
    await assert.rejects(
      copyFolder("a.md", m as any, m as any),
      /should not call/
    );
  });

  it("should propagate stat errors for missing folders", async () => {
    const left = makeMockFs("left");
    const right = makeMockFs("right");
    await assert.rejects(
      copyFolder("missing/", left as any, right as any),
      /not found/
    );
    assert.equal(right.mkdirCalls.length, 0);
  });
});

describe("copyLogic: copyFileOrFolder", () => {
  it("should route folder keys to copyFolder", async () => {
    const left = makeMockFs("left", { "f/": "" });
    const right = makeMockFs("right");
    const res = await copyFileOrFolder("f/", left as any, right as any);
    assert.equal(right.mkdirCalls.length, 1);
    assert.equal(right.writeCalls.length, 0);
    assert.equal(res.entity.key, "f/");
    assert.equal(res.content, undefined);
  });

  it("should route file keys to copyFile", async () => {
    const left = makeMockFs("left", { "a.md": "data" });
    const right = makeMockFs("right");
    const res = await copyFileOrFolder("a.md", left as any, right as any);
    assert.equal(right.writeCalls.length, 1);
    assert.equal(right.mkdirCalls.length, 0);
    assert.equal(res.entity.key, "a.md");
    assert.equal(ab2str(res.content as ArrayBuffer), "data");
  });

  it("should propagate copyFile errors", async () => {
    const left = makeMockFs("left");
    const right = makeMockFs("right");
    await assert.rejects(
      copyFileOrFolder("missing.md", left as any, right as any),
      /not found/
    );
  });
});
