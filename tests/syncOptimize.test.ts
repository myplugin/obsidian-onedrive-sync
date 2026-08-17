// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import {
  shouldSkipSync,
  splitUploadDownloadOps,
  buildDeltaStartUrl,
} from "../src/syncOptimize";
import type { Entity, MixedEntity } from "../src/baseTypes";

function makeFile(
  key: string,
  mtime?: number,
  size?: number
): Entity {
  return {
    key: key,
    keyRaw: key,
    mtimeCli: mtime ?? 1000,
    mtimeSvr: mtime ?? 1000,
    size: size ?? 100,
    sizeRaw: size ?? 100,
  };
}

function makeFolder(key: string): Entity {
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  return {
    key: folderKey,
    keyRaw: folderKey,
    size: 0,
    sizeRaw: 0,
  };
}

describe("shouldSkipSync", () => {
  // --- Basic cases ---

  it("should skip when delta=0 and local matches prevSync exactly", () => {
    const local = [makeFile("a.md", 1000, 50), makeFile("b.md", 2000, 80)];
    const prev = [makeFile("a.md", 1000, 50), makeFile("b.md", 2000, 80)];
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });

  it("should NOT skip when delta > 0 (remote has changes)", () => {
    const local = [makeFile("a.md")];
    const prev = [makeFile("a.md")];
    assert.strictEqual(shouldSkipSync(5, local, prev), false);
  });

  it("should NOT skip when delta is undefined (full enumeration)", () => {
    const local = [makeFile("a.md")];
    const prev = [makeFile("a.md")];
    assert.strictEqual(shouldSkipSync(undefined, local, prev), false);
  });

  it("should skip when delta=0 and both lists are empty", () => {
    assert.strictEqual(shouldSkipSync(0, [], []), true);
  });

  it("should NOT skip when delta=0 but local is empty and prev has files (deletions)", () => {
    const prev = [makeFile("a.md")];
    assert.strictEqual(shouldSkipSync(0, [], prev), false);
  });

  it("should NOT skip when delta=0 but local has files and prev is empty (new files)", () => {
    const local = [makeFile("a.md")];
    assert.strictEqual(shouldSkipSync(0, local, []), false);
  });

  // --- Local mtime changes ---

  it("should NOT skip when delta=0 but a local file mtime changed", () => {
    const local = [makeFile("a.md", 2000, 50)]; // mtime changed
    const prev = [makeFile("a.md", 1000, 50)];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  it("should NOT skip when delta=0 but a local file size changed", () => {
    const local = [makeFile("a.md", 1000, 200)]; // size changed
    const prev = [makeFile("a.md", 1000, 50)];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  // --- File additions / deletions ---

  it("should NOT skip when delta=0 but a local file was added", () => {
    const local = [makeFile("a.md"), makeFile("b.md")];
    const prev = [makeFile("a.md")];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  it("should NOT skip when delta=0 but a local file was deleted", () => {
    const local = [makeFile("a.md")];
    const prev = [makeFile("a.md"), makeFile("b.md")];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  it("should NOT skip when delta=0 and file count same but keys differ (swap)", () => {
    const local = [makeFile("a.md"), makeFile("c.md")];
    const prev = [makeFile("a.md"), makeFile("b.md")];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  // --- Folders ---

  it("should skip when delta=0 and only folders, all matching", () => {
    const local = [makeFolder("docs"), makeFolder("images")];
    const prev = [makeFolder("docs"), makeFolder("images")];
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });

  it("should skip when delta=0 with mix of files and folders, all matching", () => {
    const local = [
      makeFolder("docs"),
      makeFile("docs/a.md", 1000, 50),
      makeFile("b.md", 2000, 80),
    ];
    const prev = [
      makeFolder("docs"),
      makeFile("docs/a.md", 1000, 50),
      makeFile("b.md", 2000, 80),
    ];
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });

  it("should NOT skip when delta=0 but a folder was added", () => {
    const local = [makeFolder("docs"), makeFolder("new")];
    const prev = [makeFolder("docs")];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  it("should NOT skip when delta=0 but a folder was deleted", () => {
    const local = [makeFolder("docs")];
    const prev = [makeFolder("docs"), makeFolder("old")];
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  // --- Edge cases ---

  it("should NOT skip when a local file has undefined mtimeCli", () => {
    const local: Entity = {
      key: "a.md",
      keyRaw: "a.md",
      mtimeCli: undefined,
      size: 50,
      sizeRaw: 50,
    };
    const prev = [makeFile("a.md", 1000, 50)];
    assert.strictEqual(shouldSkipSync(0, [local], prev), false);
  });

  it("should NOT skip when a prevSync file has undefined mtimeCli", () => {
    const local = [makeFile("a.md", 1000, 50)];
    const prev: Entity = {
      key: "a.md",
      keyRaw: "a.md",
      mtimeCli: undefined,
      size: 50,
      sizeRaw: 50,
    };
    assert.strictEqual(shouldSkipSync(0, local, [prev]), false);
  });

  it("should skip when both local and prevSync have undefined mtimeCli for a file", () => {
    const local = [makeFile("a.md", undefined, 50)];
    const prev = [makeFile("a.md", undefined, 50)];
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });

  it("should NOT skip when a local file has undefined key", () => {
    const local = [{ keyRaw: "a.md", mtimeCli: 1000, size: 50, sizeRaw: 50 }];
    const prev = [makeFile("a.md", 1000, 50)];
    assert.strictEqual(shouldSkipSync(0, local as Entity[], prev), false);
  });

  // --- Larger scenarios ---

  it("should skip for 100 files all unchanged", () => {
    const local: Entity[] = [];
    const prev: Entity[] = [];
    for (let i = 0; i < 100; i++) {
      const e = makeFile(`file${i}.md`, 1000 + i, 50);
      local.push(e);
      prev.push({ ...e });
    }
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });

  it("should NOT skip for 100 files where one mtime changed", () => {
    const local: Entity[] = [];
    const prev: Entity[] = [];
    for (let i = 0; i < 100; i++) {
      const e = makeFile(`file${i}.md`, 1000 + i, 50);
      local.push({ ...e });
      prev.push({ ...e });
    }
    // Modify one file's mtime
    local[50] = makeFile("file50.md", 9999, 50);
    assert.strictEqual(shouldSkipSync(0, local, prev), false);
  });

  it("should handle nested folder paths", () => {
    const local = [
      makeFolder("a/b/c/"),
      makeFile("a/b/c/file.md", 1000, 50),
      makeFile("a/b/file2.md", 2000, 80),
    ];
    const prev = [
      makeFolder("a/b/c/"),
      makeFile("a/b/c/file.md", 1000, 50),
      makeFile("a/b/file2.md", 2000, 80),
    ];
    assert.strictEqual(shouldSkipSync(0, local, prev), true);
  });
});

function makeOp(key: string, decision: string): MixedEntity {
  return { key, decision: decision as any } as MixedEntity;
}

describe("splitUploadDownloadOps", () => {
  it("should split upload and download operations", () => {
    const ops = [
      makeOp("a.md", "local_is_modified_then_push"),
      makeOp("b.md", "remote_is_modified_then_pull"),
      makeOp("c.md", "local_is_created_then_push"),
      makeOp("d.md", "remote_is_created_then_pull"),
    ];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 2);
    assert.strictEqual(downloads.length, 2);
    assert.ok(uploads.every((op) => op.key === "a.md" || op.key === "c.md"));
    assert.ok(downloads.every((op) => op.key === "b.md" || op.key === "d.md"));
  });

  it("should put smart conflicts in uploads (they trigger downloads internally)", () => {
    const ops = [
      makeOp("a.md", "conflict_created_then_smart_conflict"),
      makeOp("b.md", "conflict_modified_then_smart_conflict"),
    ];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 2);
    assert.strictEqual(downloads.length, 0);
  });

  it("should route keep_local to uploads and keep_remote to downloads", () => {
    const ops = [
      makeOp("a.md", "conflict_created_then_keep_local"),
      makeOp("b.md", "conflict_created_then_keep_remote"),
      makeOp("c.md", "conflict_modified_then_keep_local"),
      makeOp("d.md", "conflict_modified_then_keep_remote"),
    ];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 2);
    assert.strictEqual(downloads.length, 2);
  });

  it("should handle empty input", () => {
    const { uploads, downloads } = splitUploadDownloadOps([]);
    assert.strictEqual(uploads.length, 0);
    assert.strictEqual(downloads.length, 0);
  });

  it("should put unknown decisions in uploads as fallback", () => {
    const ops = [makeOp("x.md", "unknown_decision")];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(downloads.length, 0);
  });

  it("should handle undefined decision", () => {
    const ops = [makeOp("x.md", "")];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(downloads.length, 0);
  });

  it("should handle all uploads (downloads empty)", () => {
    const ops = [
      makeOp("a.md", "local_is_modified_then_push"),
      makeOp("b.md", "local_is_created_then_push"),
    ];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 2);
    assert.strictEqual(downloads.length, 0);
  });

  it("should handle all downloads (uploads empty)", () => {
    const ops = [
      makeOp("a.md", "remote_is_modified_then_pull"),
      makeOp("b.md", "remote_is_created_then_pull"),
    ];
    const { uploads, downloads } = splitUploadDownloadOps(ops);
    assert.strictEqual(uploads.length, 0);
    assert.strictEqual(downloads.length, 2);
  });
});

describe("buildDeltaStartUrl", () => {
  it("should return deltaLink as-is when canIncremental=true", () => {
    const deltaLink =
      "https://graph.microsoft.com/v1.0/drive/special/approot:/vault:/delta?token=abc";
    const result = buildDeltaStartUrl(true, deltaLink, "vault");
    assert.strictEqual(result, deltaLink);
  });

  it("should NOT append $select to deltaLink (the bug that caused 400)", () => {
    // deltaLink already has $select from the server (because the original
    // full-enumeration request included $select). Appending another $select
    // creates a duplicate parameter → Graph API returns 400 Bad Request.
    const deltaLink =
      "https://graph.microsoft.com/v1.0/drive/special/approot:/vault:/delta?$select=id,name,size,fileSystemInfo,folder,file,parentReference&token=abc";
    const result = buildDeltaStartUrl(true, deltaLink, "vault");
    // Must be EXACTLY the deltaLink — no appended parameters
    assert.strictEqual(result, deltaLink);
    // Verify no duplicate $select
    const selectCount = (result.match(/\$select=/g) || []).length;
    assert.strictEqual(selectCount, 1, "should have exactly one $select");
  });

  it("should include $select for full enumeration (canIncremental=false)", () => {
    const result = buildDeltaStartUrl(false, "", "vault");
    assert.ok(result.includes("$select="));
    assert.ok(result.includes("/drive/special/approot:/vault:/delta"));
  });

  it("should build correct URL for different remoteBaseDir", () => {
    const result = buildDeltaStartUrl(false, "", "MyVault");
    assert.ok(result.includes("/drive/special/approot:/MyVault:/delta"));
  });

  it("should return deltaLink unchanged even with complex token", () => {
    const deltaLink =
      "https://graph.microsoft.com/v1.0/drive/special/approot:/vault:/delta?$select=id%2cname%2csize&token=NDslMjM0OyUyMzE7Mzs5NTgyZGNhYi0wZDViLTQyN2ItODcyMy00YTcwZDAyOWVkYjc7NjM5MjI1NDc1NDM1MzAwMDAwOzEwODUyODE2OTE7JTIzOyUyMzN6OWhtQVNwTDl0QVZ4a3R4RDNYU09wM2l0eFN2RW1NNkFVa3dCUzRFUmslMjUzRDslMjMwOyUyMw";
    const result = buildDeltaStartUrl(true, deltaLink, "vault");
    assert.strictEqual(result, deltaLink);
  });

  it("should handle empty deltaLink when canIncremental=false (fallback case)", () => {
    const result = buildDeltaStartUrl(false, "", "vault");
    assert.ok(result.startsWith("/drive/special/approot:/vault:/delta"));
    assert.ok(result.includes("$select="));
  });
});
