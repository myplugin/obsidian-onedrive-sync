import { strict as assert } from "assert";
import { checkIsSkipItemOrNotByName } from "../src/skipFilter";

describe("Sync: checkIsSkipItemOrNotByName", () => {
  it("should be ok everywhere for empty config", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [""],
      /* onlyAllowPaths */ ["", "\n"]
    ).finalIsIgnored;
    assert.ok(!isSkip);
  });

  it("should be ok for deny list", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx$"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip);

    // if we deny a folder, we have to deny all the sub files
    // TODO: it's soooo hard to do the path resolution in this func with regex,
    //       so we defer the detection to later steps now.
    //       the test here doesn't work.
    // isSkip = checkIsSkipItemOrNotByName(
    //   'xxx/yyy.md',
    //   false,
    //   false,
    //   false,
    //   '.obsidian',
    //   /*    ignorePaths */ ['xxx/$'],
    //   /* onlyAllowPaths */ []
    // ).finalIsIgnored;
    // assert.ok(isSkip);
  });

  it("should be ok for allow list", async () => {
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ ["xxx"]
    ).finalIsIgnored;
    assert.ok(!isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [""],
      /* onlyAllowPaths */ ["xxx"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ ["xxx$"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    // should NOT skip because we allow the sub file AND not deny the folder
    // TODO: it's soooo hard to do the path resolution in this func with regex,
    //       so we defer the detection to later steps now.
    //       the test here doesn't work.
    // isSkip = checkIsSkipItemOrNotByName(
    //   'xxx/',
    //   false,
    //   false,
    //   false,
    //   '.obsidian',
    //   /*    ignorePaths */ [],
    //   /* onlyAllowPaths */ ['xxx/yyy.md']
    // ).finalIsIgnored;
    // assert.ok(!isSkip);
  });

  it("should detect the name by two lists together", async () => {
    // should skip because we ignore the path
    let isSkip = checkIsSkipItemOrNotByName(
      "xxx.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ ["yyy"]
    ).finalIsIgnored;
    assert.ok(isSkip);

    // should skip because we disallow the whole folder
    isSkip = checkIsSkipItemOrNotByName(
      "xxx/yyy.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["xxx"],
      /* onlyAllowPaths */ ["xxx/yyy.md"]
    ).finalIsIgnored;
    assert.ok(isSkip);
  });

  it("should normalize backslash in key path (slash compatibility)", async () => {
    // key uses \, ignorePaths regex uses / → should still skip after path normalization
    const isSkip = checkIsSkipItemOrNotByName(
      "tmp\\foo.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["tmp/.*"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in ignorePaths regex (slash compatibility)", async () => {
    // regex uses \\ (literal backslash = path-separator intent), key uses /
    const isSkip = checkIsSkipItemOrNotByName(
      "tmp/foo.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["tmp\\\\.*"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip);
  });

  it("should normalize backslash in key AND regex together (slash compatibility)", async () => {
    // both key and regex use backslashes → both normalized to / → match
    const isSkip = checkIsSkipItemOrNotByName(
      "tmp\\foo.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ ["tmp\\\\.*"],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip);
  });

  it("should normalize double-backslash in onlyAllowPaths regex (slash compatibility)", async () => {
    // allow regex uses \\, key uses / → explicitly allowed → NOT skipped
    const isSkip = checkIsSkipItemOrNotByName(
      "tmp/foo.md",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [],
      /* onlyAllowPaths */ ["tmp\\\\.*"]
    ).finalIsIgnored;
    assert.ok(!isSkip);
  });

  it("should NOT touch single-backslash escapes like \\. in sync (slash compatibility)", async () => {
    // \.png$ is one backslash + dot (NOT \\) → must stay a literal-dot escape
    let isSkip = checkIsSkipItemOrNotByName(
      "a.png",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [String.raw`\.png$`],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(isSkip); // matches a.png

    isSkip = checkIsSkipItemOrNotByName(
      "a_png",
      false,
      false,
      false,
      ".obsidian",
      /*    ignorePaths */ [String.raw`\.png$`],
      /* onlyAllowPaths */ []
    ).finalIsIgnored;
    assert.ok(!isSkip); // does NOT match a_png
  });
});
