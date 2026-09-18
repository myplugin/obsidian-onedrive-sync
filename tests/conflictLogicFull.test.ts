// Tests for src/conflictLogic.ts (PolyForm Strict, source-available).
// Covers the functions NOT exercised by tests/conflictLogic.test.ts (which
// runs against the Apache-licensed src/mergeUtils.ts re-implementation):
// isMergable, mergeFile, tryDuplicateFile.

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import { isMergable, mergeFile, tryDuplicateFile } from "../src/conflictLogic";
import { bufferToArrayBuffer } from "../src/misc";

const decoder = new TextDecoder();

function str2ab(s: string): ArrayBuffer {
  return bufferToArrayBuffer(Buffer.from(s, "utf-8"));
}

function ab2str(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

type StatMissingMode = "throw" | "undefined" | "null";

interface MockFsOptions {
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
function makeMockFs(
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

function makeEntity(key: string, sizeRaw: number): Entity {
  return { key, keyRaw: key, sizeRaw };
}

describe("conflictLogic: isMergable", () => {
  it("should accept small markdown files", () => {
    assert.ok(isMergable(makeEntity("a/b.md", 100)));
    assert.ok(isMergable(makeEntity("a/b.markdown", 100)));
    assert.ok(isMergable(makeEntity("noext.md", 0)));
  });

  it("should reject non-markdown extensions", () => {
    assert.ok(!isMergable(makeEntity("a/b.txt", 100)));
    assert.ok(!isMergable(makeEntity("a/b.md.txt", 100)));
    assert.ok(!isMergable(makeEntity("a/b.mdx", 100)));
    assert.ok(!isMergable(makeEntity("a/b", 100)));
  });

  it("should reject folders even when named like markdown", () => {
    assert.ok(!isMergable(makeEntity("folder.md/", 100)));
    assert.ok(!isMergable(makeEntity("a/b/", 0)));
  });

  it("should respect the 1 MB size limit (sizeRaw)", () => {
    const limit = 1000 * 1000;
    assert.ok(isMergable(makeEntity("a.md", limit)));
    assert.ok(isMergable(makeEntity("a.md", limit - 1)));
    assert.ok(!isMergable(makeEntity("a.md", limit + 1)));
  });

  it("should compare keys when a second entity is given", () => {
    const a = makeEntity("x.md", 10);
    const bSameKey = makeEntity("x.md", 9999999); // b's size is ignored
    const bDiffKey = makeEntity("y.md", 10);
    assert.ok(isMergable(a, bSameKey));
    assert.ok(!isMergable(a, bDiffKey));
    // even two perfectly mergeable entities fail when keys differ
    assert.ok(!isMergable(makeEntity("x.md", 1), makeEntity("y.md", 1)));
  });
});

describe("conflictLogic: mergeFile", () => {
  it("should throw for folder keys", async () => {
    const m = makeMockFs("m");
    await assert.rejects(
      mergeFile("some/folder/", m as any, m as any, null),
      /should not call/
    );
  });

  it("should throw for non-markdown keys", async () => {
    const left = makeMockFs("left", { "a.txt": "x" });
    const right = makeMockFs("right", { "a.txt": "x" });
    await assert.rejects(
      mergeFile("a.txt", left as any, right as any, null),
      /only support markdown files/
    );
    assert.equal(left.writeCalls.length, 0);
    assert.equal(right.writeCalls.length, 0);
  });

  it("should accept .markdown files", async () => {
    const left = makeMockFs("left", { "n.markdown": "same" });
    const right = makeMockFs("right", { "n.markdown": "same" });
    const res = await mergeFile("n.markdown", left as any, right as any, null);
    assert.equal(ab2str(res.content as ArrayBuffer), "same");
  });

  it("should keep content as-is when both sides are identical", async () => {
    const left = makeMockFs("left", { "n.md": "same\ncontent" });
    const right = makeMockFs("right", { "n.md": "same\ncontent" });
    const res = await mergeFile("n.md", left as any, right as any, null);
    assert.equal(ab2str(res.content as ArrayBuffer), "same\ncontent");
    assert.equal(res.entity.key, "n.md");
    assert.equal(
      ab2str(left.files.get("n.md") as ArrayBuffer),
      "same\ncontent"
    );
    assert.equal(
      ab2str(right.files.get("n.md") as ArrayBuffer),
      "same\ncontent"
    );
    // both sides are (re)written even when nothing changed
    assert.equal(left.writeCalls.length, 1);
    assert.equal(right.writeCalls.length, 1);
  });

  it("should two-way merge when contentOrig is null", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs("right", { "n.md": "bbb" });
    const res = await mergeFile("n.md", left as any, right as any, null);
    const merged = ab2str(res.content as ArrayBuffer);
    assert.equal(merged, "`<<<<<<<`\naaa\n`=======`\nbbb\n`>>>>>>>`");
    // the merged result is written to both sides
    assert.equal(ab2str(left.files.get("n.md") as ArrayBuffer), merged);
    assert.equal(ab2str(right.files.get("n.md") as ArrayBuffer), merged);
  });

  it("should two-way merge when contentOrig is undefined", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs("right", { "n.md": "bbb" });
    const res = await mergeFile("n.md", left as any, right as any, undefined);
    assert.equal(
      ab2str(res.content as ArrayBuffer),
      "`<<<<<<<`\naaa\n`=======`\nbbb\n`>>>>>>>`"
    );
  });

  it("should three-way merge when contentOrig is given", async () => {
    const orig = "\n* [ ] A1\n* [ ] A2\n* [ ] A3\n";
    const a = "\n* [ ] A1\n* [ ] new line after A1\n* [ ] A2\n* [ ] A3\n";
    const b = "\n* [ ] A1\n* [ ] A2\n* [ ] New line after A2\n* [ ] A3\n";
    const expected =
      "\n* [ ] A1\n* [ ] new line after A1\n* [ ] A2\n" +
      "* [ ] New line after A2\n* [ ] A3\n";
    const left = makeMockFs("left", { "n.md": a });
    const right = makeMockFs("right", { "n.md": b });
    const res = await mergeFile(
      "n.md",
      left as any,
      right as any,
      str2ab(orig)
    );
    const merged = ab2str(res.content as ArrayBuffer);
    assert.equal(merged, expected);
    assert.ok(!merged.includes("<<<<<<<"), "clean merge, no conflict markers");
    assert.equal(ab2str(left.files.get("n.md") as ArrayBuffer), expected);
    assert.equal(ab2str(right.files.get("n.md") as ArrayBuffer), expected);
  });

  it("should insert conflict markers for true three-way conflicts", async () => {
    const orig = "\n* [ ] A3\n* [ ] A4\n";
    const a = "\n* [ ] changed by left\n* [ ] A3\n* [ ] A4\n";
    const b = "\n* [ ] changed by right\n* [ ] A3\n* [ ] A4\n";
    const left = makeMockFs("left", { "n.md": a });
    const right = makeMockFs("right", { "n.md": b });
    const res = await mergeFile(
      "n.md",
      left as any,
      right as any,
      str2ab(orig)
    );
    const merged = ab2str(res.content as ArrayBuffer);
    // markers are wrapped in backticks for markdown compatibility
    assert.ok(merged.includes("`<<<<<<<`"));
    assert.ok(merged.includes("`=======`"));
    assert.ok(merged.includes("`>>>>>>>`"));
    assert.ok(merged.includes("changed by left"));
    assert.ok(merged.includes("changed by right"));
  });

  it("should write right first, then left with right's mtime/ctime", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs(
      "right",
      { "n.md": "bbb" },
      { writeReturn: { mtimeCli: 9999, ctimeCli: 8888 } }
    );
    const res = await mergeFile("n.md", left as any, right as any, null);
    // the returned entity is the remote one
    assert.equal(res.entity.mtimeCli, 9999);
    assert.equal(right.writeCalls.length, 1);
    assert.equal(left.writeCalls.length, 1);
    // local write adopts the mtime/ctime reported by the remote
    assert.equal(left.writeCalls[0].mtime, 9999);
    assert.equal(left.writeCalls[0].ctime, 8888);
    // remote write used the freshly generated timestamp
    assert.notEqual(right.writeCalls[0].mtime, 9999);
    assert.equal(right.writeCalls[0].mtime, right.writeCalls[0].ctime);
  });

  it("should fall back to generated mtime when right returns none", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs(
      "right",
      { "n.md": "bbb" },
      { writeReturn: { mtimeCli: undefined, ctimeCli: undefined } }
    );
    const t0 = Date.now();
    const res = await mergeFile("n.md", left as any, right as any, null);
    assert.equal(res.entity.mtimeCli, undefined);
    assert.equal(left.writeCalls.length, 1);
    const lw = left.writeCalls[0];
    assert.ok(lw.mtime >= t0);
    assert.equal(lw.mtime, lw.ctime);
    assert.equal(lw.mtime, right.writeCalls[0].mtime);
  });
});

describe("conflictLogic: tryDuplicateFile", () => {
  const originalDebug = console.debug;
  before(() => {
    console.debug = () => {};
  });
  after(() => {
    console.debug = originalDebug;
  });

  function makeRecorders() {
    const uploads: (Entity | undefined)[] = [];
    const downloads: (Entity | undefined)[] = [];
    return {
      uploads,
      downloads,
      uploadCallback: async (e: Entity | undefined) => {
        uploads.push(e);
      },
      downloadCallback: async (e: Entity | undefined) => {
        downloads.push(e);
      },
    };
  }

  it("same size, same content: updates local only, no upload", async () => {
    const local = makeMockFs("local", { "x.md": "hello" });
    const remote = makeMockFs("remote", { "x.md": "hello" });
    const rec = makeRecorders();
    const res = await tryDuplicateFile(
      "x.md",
      local as any,
      remote as any,
      rec.uploadCallback,
      rec.downloadCallback
    );
    assert.equal(res, undefined);
    assert.equal(rec.downloads.length, 1);
    assert.equal(rec.downloads[0]!.key, "x.md");
    assert.equal(rec.uploads.length, 0);
    assert.equal(local.renameCalls.length, 0);
    assert.ok(!local.files.has("x.dup.md"));
    assert.ok(!remote.files.has("x.dup.md"));
    assert.equal(ab2str(local.files.get("x.md") as ArrayBuffer), "hello");
    // local was rewritten using the remote metadata (mtimeCli = 1000)
    assert.equal(local.writeCalls.length, 1);
    assert.equal(local.writeCalls[0].mtime, 1000);
  });

  it("same size, different content: renames local, swaps in remote", async () => {
    const local = makeMockFs("local", { "x.md": "aaa" });
    const remote = makeMockFs("remote", { "x.md": "bbb" });
    const rec = makeRecorders();
    const res = await tryDuplicateFile(
      "x.md",
      local as any,
      remote as any,
      rec.uploadCallback,
      rec.downloadCallback
    );
    assert.equal(res, undefined);
    // local was renamed to x.dup.md before the remote content was pulled
    assert.deepEqual(local.renameCalls, [{ from: "x.md", to: "x.dup.md" }]);
    assert.equal(ab2str(local.files.get("x.md") as ArrayBuffer), "bbb");
    assert.equal(ab2str(local.files.get("x.dup.md") as ArrayBuffer), "aaa");
    // the original local content is uploaded under the dup name
    assert.equal(ab2str(remote.files.get("x.dup.md") as ArrayBuffer), "aaa");
    assert.equal(ab2str(remote.files.get("x.md") as ArrayBuffer), "bbb");
    assert.equal(rec.downloads.length, 1);
    assert.equal(rec.downloads[0]!.key, "x.md");
    assert.equal(rec.uploads.length, 1);
    assert.equal(rec.uploads[0]!.key, "x.dup.md");
  });

  it("different sizes: uploads local as .dup, downloads remote", async () => {
    const local = makeMockFs("local", { "x.md": "local content is longer" });
    const remote = makeMockFs("remote", { "x.md": "short" });
    const rec = makeRecorders();
    const res: any = await tryDuplicateFile(
      "x.md",
      local as any,
      remote as any,
      rec.uploadCallback,
      rec.downloadCallback
    );
    assert.equal(res.upload.key, "x.dup.md");
    assert.equal(res.download.key, "x.md");
    assert.deepEqual(local.renameCalls, [{ from: "x.md", to: "x.dup.md" }]);
    assert.equal(ab2str(local.files.get("x.md") as ArrayBuffer), "short");
    assert.equal(
      ab2str(local.files.get("x.dup.md") as ArrayBuffer),
      "local content is longer"
    );
    assert.equal(
      ab2str(remote.files.get("x.dup.md") as ArrayBuffer),
      "local content is longer"
    );
    assert.equal(ab2str(remote.files.get("x.md") as ArrayBuffer), "short");
    assert.equal(rec.uploads.length, 1);
    assert.equal(rec.uploads[0]!.key, "x.dup.md");
    assert.equal(rec.downloads.length, 1);
    assert.equal(rec.downloads[0]!.key, "x.md");
  });

  it("picks the next free dup name when x.dup.md already exists", async () => {
    const local = makeMockFs("local", {
      "x.md": "local content is longer",
      "x.dup.md": "pre-existing",
    });
    const remote = makeMockFs("remote", { "x.md": "short" });
    const rec = makeRecorders();
    const res: any = await tryDuplicateFile(
      "x.md",
      local as any,
      remote as any,
      rec.uploadCallback,
      rec.downloadCallback
    );
    assert.equal(res.upload.key, "x.dup.dup.md");
    // the pre-existing dup file is left untouched
    assert.equal(
      ab2str(local.files.get("x.dup.md") as ArrayBuffer),
      "pre-existing"
    );
    assert.equal(
      ab2str(local.files.get("x.dup.dup.md") as ArrayBuffer),
      "local content is longer"
    );
    assert.equal(
      ab2str(remote.files.get("x.dup.dup.md") as ArrayBuffer),
      "local content is longer"
    );
    assert.equal(rec.uploads[0]!.key, "x.dup.dup.md");
  });

  for (const mode of ["undefined", "null"] as const) {
    it(`treats stat() returning ${mode} for missing key2 as "not exists"`, async () => {
      const local = makeMockFs(
        "local",
        { "x.md": "hello" },
        { statMissing: mode }
      );
      const remote = makeMockFs("remote", { "x.md": "hello" });
      const rec = makeRecorders();
      await tryDuplicateFile(
        "x.md",
        local as any,
        remote as any,
        rec.uploadCallback,
        rec.downloadCallback
      );
      // no infinite loop; the dup-name search succeeded and the
      // same-content path ran
      assert.equal(rec.downloads.length, 1);
      assert.equal(rec.uploads.length, 0);
    });
  }
});
