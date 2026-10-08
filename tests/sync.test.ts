import { strict as assert } from "assert";
import { checkIsSkipItemOrNotByName } from "../src/skipFilter";

// Helper: call with all .obsidian sync toggles OFF (matches old default
// behavior where nothing in .obsidian was synced)
function callSkip(
  key: string,
  opts: {
    isHidden?: boolean;
    isFolder?: boolean;
    isSymlink?: boolean;
    obsidianFolder?: string;
    ignorePaths?: string[];
    onlyAllowPaths?: string[];
    syncObsidianConfig?: boolean;
    syncAppearance?: boolean;
    syncBookmarks?: boolean;
    syncThirdPartyPlugins?: boolean;
    syncSelfPlugin?: boolean;
    selfPluginId?: string;
  } = {}
) {
  return checkIsSkipItemOrNotByName(
    key,
    opts.isHidden ?? false,
    opts.isFolder ?? false,
    opts.isSymlink ?? false,
    opts.obsidianFolder ?? ".obsidian",
    opts.ignorePaths ?? [],
    opts.onlyAllowPaths ?? [],
    opts.syncObsidianConfig ?? false,
    opts.syncAppearance ?? false,
    opts.syncBookmarks ?? false,
    opts.syncThirdPartyPlugins ?? false,
    opts.syncSelfPlugin ?? false,
    opts.selfPluginId ?? "obsidian-onedrive-sync"
  ).finalIsIgnored;
}

describe("Sync: checkIsSkipItemOrNotByName (standard paths)", () => {
  it("should be ok everywhere for empty config", async () => {
    let isSkip = callSkip("xxx.md");
    assert.ok(!isSkip);

    isSkip = callSkip("xxx.md", {
      ignorePaths: [""],
      onlyAllowPaths: ["", "\n"],
    });
    assert.ok(!isSkip);
  });

  it("should be ok for deny list", async () => {
    let isSkip = callSkip("xxx.md", { ignorePaths: ["xxx"] });
    assert.ok(isSkip);

    isSkip = callSkip("yyy.md", { ignorePaths: ["xxx"] });
    assert.ok(!isSkip);

    isSkip = callSkip("xxx.md", { ignorePaths: ["xxx$"] });
    assert.ok(!isSkip);
  });

  it("should be ok for allow list", async () => {
    let isSkip = callSkip("xxx.md", { onlyAllowPaths: ["xxx"] });
    assert.ok(!isSkip);

    isSkip = callSkip("yyy.md", { onlyAllowPaths: ["xxx"] });
    assert.ok(isSkip);

    isSkip = callSkip("xxx.md", { onlyAllowPaths: ["xxx$"] });
    assert.ok(isSkip);
  });

  it("should detect the name by two lists together", async () => {
    let isSkip = callSkip("xxx.md", {
      ignorePaths: ["xxx"],
      onlyAllowPaths: ["yyy"],
    });
    assert.ok(isSkip);

    isSkip = callSkip("xxx/yyy.md", {
      ignorePaths: ["xxx"],
      onlyAllowPaths: ["xxx/yyy.md"],
    });
    assert.ok(isSkip);
  });

  it("should normalize backslash in key path", async () => {
    const isSkip = callSkip("tmp\\foo.md", { ignorePaths: ["tmp/.*"] });
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in ignorePaths regex", async () => {
    const isSkip = callSkip("tmp/foo.md", { ignorePaths: ["tmp\\\\.*"] });
    assert.ok(isSkip);
  });

  it("should normalize backslash in key AND regex together", async () => {
    const isSkip = callSkip("tmp\\foo.md", { ignorePaths: ["tmp\\\\.*"] });
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in onlyAllowPaths regex", async () => {
    const isSkip = callSkip("tmp/foo.md", { onlyAllowPaths: ["tmp\\\\.*"] });
    assert.ok(!isSkip);
  });

  it("should NOT touch single-backslash escapes like \\.", async () => {
    let isSkip = callSkip("a.png", { ignorePaths: [String.raw`\.png$`] });
    assert.ok(isSkip);

    isSkip = callSkip("a_png", { ignorePaths: [String.raw`\.png$`] });
    assert.ok(!isSkip);
  });
});
