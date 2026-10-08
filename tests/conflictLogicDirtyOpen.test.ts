// Tests for src/conflictLogic.ts (PolyForm Strict, source-available).
// Covers the dirty-buffer guard helpers: computeMergedContent (the pure
// read+merge layer extracted from mergeFile) and writeDupCopyForDirtyOpen
// (the .dup copy writer with cross-run anti-loop behavior).

import { strict as assert } from "assert";
import type { Entity } from "../src/baseTypes";
import {
  computeMergedContent,
  writeDupCopyForDirtyOpen,
} from "../src/conflictLogic";
import { makeMockFs, str2ab } from "./_fsMock";

const decoder = new TextDecoder();

function ab2str(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

function makeEntity(key: string, sizeRaw: number): Entity {
  return { key, keyRaw: key, sizeRaw };
}

describe("conflictLogic: writeDupCopyForDirtyOpen", () => {
  const originalDebug = console.debug;
  before(() => {
    console.debug = () => {};
  });
  after(() => {
    console.debug = originalDebug;
  });

  it("writes remote content to a free .dup key, leaves the live file untouched", async () => {
    const local = makeMockFs("local", { "x.md": "local-v" });
    const remote = makeMockFs("remote", { "x.md": "remote-v" });
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { remoteMtime: 5000 }
    );
    assert.equal(res.written, true);
    assert.equal(res.dupKey, "x.dup.md");
    // the live local file is untouched
    assert.equal(ab2str(local.files.get("x.md") as ArrayBuffer), "local-v");
    // the dup copy holds the remote content
    assert.equal(
      ab2str(local.files.get("x.dup.md") as ArrayBuffer),
      "remote-v"
    );
    assert.equal(local.writeCalls.length, 1);
    assert.equal(local.writeCalls[0].key, "x.dup.md");
    // the returned entity describes the dup copy
    const expected = makeEntity("x.dup.md", str2ab("remote-v").byteLength);
    assert.equal(res.entity?.key, expected.key);
    assert.equal(res.entity?.sizeRaw, expected.sizeRaw);
  });

  it("uses provided content over reading remote", async () => {
    const local = makeMockFs("local", { "x.md": "local-v" });
    const remote = makeMockFs("remote", { "x.md": "remote-v" });
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { content: str2ab("merged-xyz"), remoteMtime: 5000 }
    );
    assert.equal(res.written, true);
    // the provided content was used; remote's "remote-v" was NOT read in
    assert.equal(
      ab2str(local.files.get("x.dup.md") as ArrayBuffer),
      "merged-xyz"
    );
    assert.equal(local.writeCalls.length, 1);
  });

  it("uses provided remoteMtime as the dup's mtime (immune to clock skew)", async () => {
    const local = makeMockFs("local");
    const remote = makeMockFs("remote", { "x.md": "r" });
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { content: str2ab("c"), remoteMtime: 7777 }
    );
    assert.equal(res.written, true);
    assert.equal(local.writeCalls.length, 1);
    assert.equal(local.writeCalls[0].mtime, 7777);
    assert.equal(local.writeCalls[0].ctime, 7777);
  });

  it("anti-loop: skips rewriting when an up-to-date dup already exists", async () => {
    const local = makeMockFs("local", {
      "x.md": "local",
      "x.dup.md": "old-dup",
    });
    const remote = makeMockFs("remote", { "x.md": "remote" });
    // the mock's stat() reports mtimeCli=1000 for x.dup.md, and
    // 1000 >= 2000 - DUP_MTIME_TOLERANCE_MS (2000) = 0, so the existing
    // dup counts as up-to-date and nothing is rewritten
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { remoteMtime: 2000 }
    );
    assert.equal(res.written, false);
    assert.equal(res.dupKey, undefined);
    assert.equal(local.writeCalls.length, 0);
    assert.equal(ab2str(local.files.get("x.dup.md") as ArrayBuffer), "old-dup");
  });

  it("anti-loop: writes a fresh dup when the remote is newer than the existing dup", async () => {
    const local = makeMockFs("local", {
      "x.md": "local",
      "x.dup.md": "old-dup",
    });
    const remote = makeMockFs("remote", { "x.md": "remote" });
    // 1000 >= 5000 - 2000 = 3000? NO -> the existing dup is stale, so a
    // fresh copy is written under the next free chain name
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { remoteMtime: 5000 }
    );
    assert.equal(res.written, true);
    assert.equal(res.dupKey, "x.dup.dup.md");
    // the pre-existing dup is untouched
    assert.equal(ab2str(local.files.get("x.dup.md") as ArrayBuffer), "old-dup");
    assert.equal(
      ab2str(local.files.get("x.dup.dup.md") as ArrayBuffer),
      "remote"
    );
  });

  it("walks the dup chain past multiple existing dups", async () => {
    const local = makeMockFs("local", {
      "x.md": "local",
      "x.dup.md": "d1",
      "x.dup.dup.md": "d2",
    });
    const remote = makeMockFs("remote", { "x.md": "remote" });
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { remoteMtime: 5000 }
    );
    assert.equal(res.written, true);
    assert.equal(res.dupKey, "x.dup.dup.dup.md");
    // the two pre-existing dups are untouched
    assert.equal(ab2str(local.files.get("x.dup.md") as ArrayBuffer), "d1");
    assert.equal(ab2str(local.files.get("x.dup.dup.md") as ArrayBuffer), "d2");
    assert.equal(
      ab2str(local.files.get("x.dup.dup.dup.md") as ArrayBuffer),
      "remote"
    );
  });

  it("falls back to Date.now() mtime when remoteMtime is undefined and content is provided (stat-failure path)", async () => {
    const local = makeMockFs("local");
    // remote has no "x.md": stat() throws, the helper catches it and keeps
    // remoteMtime undefined. content is provided, so readFile is never
    // called (which would throw too).
    const remote = makeMockFs("remote");
    const t0 = Date.now();
    const res = await writeDupCopyForDirtyOpen(
      "x.md",
      local as any,
      remote as any,
      { content: str2ab("c") }
    );
    assert.equal(res.written, true);
    assert.equal(res.dupKey, "x.dup.md");
    assert.equal(local.writeCalls.length, 1);
    const lw = local.writeCalls[0];
    assert.ok(lw.mtime >= t0);
    assert.equal(lw.mtime, lw.ctime);
  });

  it("throws for folder keys", async () => {
    const m = makeMockFs("m");
    await assert.rejects(
      writeDupCopyForDirtyOpen("folder/", m as any, m as any),
      /should not call/
    );
  });
});

describe("conflictLogic: computeMergedContent", () => {
  it("returns left as-is when both sides are identical", async () => {
    const left = makeMockFs("left", { "n.md": "same\ncontent" });
    const right = makeMockFs("right", { "n.md": "same\ncontent" });
    const res = await computeMergedContent(
      "n.md",
      left as any,
      right as any,
      null
    );
    assert.equal(ab2str(res), "same\ncontent");
  });

  it("two-way merges when contentOrig is null", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs("right", { "n.md": "bbb" });
    const res = await computeMergedContent(
      "n.md",
      left as any,
      right as any,
      null
    );
    assert.equal(ab2str(res), "`<<<<<<<`\naaa\n`=======`\nbbb\n`>>>>>>>`");
  });

  it("three-way merges when contentOrig is given (clean merge)", async () => {
    const orig = "\n* [ ] A1\n* [ ] A2\n* [ ] A3\n";
    const a = "\n* [ ] A1\n* [ ] new line after A1\n* [ ] A2\n* [ ] A3\n";
    const b = "\n* [ ] A1\n* [ ] A2\n* [ ] New line after A2\n* [ ] A3\n";
    const expected =
      "\n* [ ] A1\n* [ ] new line after A1\n* [ ] A2\n" +
      "* [ ] New line after A2\n* [ ] A3\n";
    const left = makeMockFs("left", { "n.md": a });
    const right = makeMockFs("right", { "n.md": b });
    const res = await computeMergedContent(
      "n.md",
      left as any,
      right as any,
      str2ab(orig)
    );
    const merged = ab2str(res);
    assert.equal(merged, expected);
    assert.ok(!merged.includes("<<<<<<<"), "clean merge, no conflict markers");
  });

  it("does NOT write to either side (pure compute)", async () => {
    const left = makeMockFs("left", { "n.md": "aaa" });
    const right = makeMockFs("right", { "n.md": "bbb" });
    await computeMergedContent("n.md", left as any, right as any, null);
    // key difference from mergeFile: nothing is written to either side
    assert.equal(left.writeCalls.length, 0);
    assert.equal(right.writeCalls.length, 0);
    assert.equal(ab2str(left.files.get("n.md") as ArrayBuffer), "aaa");
    assert.equal(ab2str(right.files.get("n.md") as ArrayBuffer), "bbb");
  });
});
