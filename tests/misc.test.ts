import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import * as misc from "../src/misc";

describe("Misc: hidden file", () => {
  it("should find hidden file correctly", () => {
    let item = "";
    assert.ok(!misc.isHiddenPath(item));

    item = ".";
    assert.ok(!misc.isHiddenPath(item));

    item = "..";
    assert.ok(!misc.isHiddenPath(item));

    item = "/x/y/z/../././../a/b/c";
    assert.ok(!misc.isHiddenPath(item));

    item = ".hidden";
    assert.ok(misc.isHiddenPath(item));

    item = "_hidden_loose";
    assert.ok(misc.isHiddenPath(item));
    assert.ok(!misc.isHiddenPath(item, true, false));

    item = "/sdd/_hidden_loose";
    assert.ok(misc.isHiddenPath(item));

    item = "what/../_hidden_loose/what/what/what";
    assert.ok(misc.isHiddenPath(item));

    item = "what/../_hidden_loose/what/what/what";
    assert.ok(!misc.isHiddenPath(item, true, false));

    item = "what/../_hidden_loose/../.hidden/what/what/what";
    assert.ok(misc.isHiddenPath(item, true, false));

    item = "what/../_hidden_loose/../.hidden/what/what/what";
    assert.ok(!misc.isHiddenPath(item, false, true));

    item = "what/_hidden_loose/what/what/what";
    assert.ok(misc.isHiddenPath(item, false, true));
    assert.ok(!misc.isHiddenPath(item, true, false));

    item = "what/.hidden/what/what/what";
    assert.ok(!misc.isHiddenPath(item, false, true));
    assert.ok(misc.isHiddenPath(item, true, false));
  });
});

describe("Misc: get folder levels", () => {
  it("should ignore empty path", () => {
    const item = "";
    assert.equal(misc.getFolderLevels(item).length, 0);
  });

  it("should ignore single file", () => {
    const item = "xxx";
    assert.equal(misc.getFolderLevels(item).length, 0);
  });

  it("should detect path ending with /", () => {
    const item = "xxx/";
    const res = ["xxx"];
    assert.deepEqual(misc.getFolderLevels(item), res);
  });

  it("should correctly split folders and files", () => {
    const item = "xxx/yyy/zzz.md";
    const res = ["xxx", "xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item), res);

    const item2 = "xxx/yyy/zzz";
    const res2 = ["xxx", "xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item2), res2);

    const item3 = "xxx/yyy/zzz/";
    const res3 = ["xxx", "xxx/yyy", "xxx/yyy/zzz"];
    assert.deepEqual(misc.getFolderLevels(item3), res3);
  });

  it("should correctly add ending slash if required", () => {
    const item = "xxx/yyy/zzz.md";
    const res = ["xxx/", "xxx/yyy/"];
    assert.deepEqual(misc.getFolderLevels(item, true), res);

    const item2 = "xxx/yyy/zzz";
    const res2 = ["xxx/", "xxx/yyy/"];
    assert.deepEqual(misc.getFolderLevels(item2, true), res2);

    const item3 = "xxx/yyy/zzz/";
    const res3 = ["xxx/", "xxx/yyy/", "xxx/yyy/zzz/"];
    assert.deepEqual(misc.getFolderLevels(item3, true), res3);
  });

  it("should treat path starting with / correctly", () => {
    const item = "/xxx/yyy/zzz.md";
    const res = ["/xxx", "/xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item), res);

    const item2 = "/xxx/yyy/zzz";
    const res2 = ["/xxx", "/xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item2), res2);

    const item3 = "/xxx/yyy/zzz/";
    const res3 = ["/xxx", "/xxx/yyy", "/xxx/yyy/zzz"];
    assert.deepEqual(misc.getFolderLevels(item3), res3);

    const item4 = "/xxx";
    const res4 = [] as string[];
    assert.deepEqual(misc.getFolderLevels(item4), res4);

    const item5 = "/";
    const res5 = [] as string[];
    assert.deepEqual(misc.getFolderLevels(item5), res5);
  });
});

describe("Misc: get parent folder", () => {
  it("should treat empty path correctly", () => {
    const item = "";
    assert.equal(misc.getParentFolder(item), "/");
  });

  it("should treat one level path correctly", () => {
    let item = "abc/";
    assert.equal(misc.getParentFolder(item), "/");
    item = "/efg/";
    assert.equal(misc.getParentFolder(item), "/");
  });

  it("should treat more levels path correctly", () => {
    let item = "abc/efg";
    assert.equal(misc.getParentFolder(item), "abc/");
    item = "/hij/klm/";
    assert.equal(misc.getParentFolder(item), "/hij/");
  });
});

describe("Misc: vaild file name tests", () => {
  it("should treat no ascii correctly", async () => {
    const x = misc.isVaildText("😄🍎 apple 苹果");
    // console.log(x)
    assert.ok(x);
  });

  it("should find not-printable chars correctly", async () => {
    const x = misc.isVaildText("😄🍎 apple 苹果\u0000");
    // console.log(x)
    assert.ok(!x);
  });

  it("should allow spaces/slashes/...", async () => {
    const x = misc.isVaildText("😄🍎 apple 苹果/-_=/\\*%^&@#$`");
    assert.ok(x);
  });
});

describe("Misc: get dirname", () => {
  it("should return itself for folder", async () => {
    const x = misc.getPathFolder("ssss/");
    // console.log(x)
    assert.equal(x, "ssss/");
  });

  it("should return folder for file", async () => {
    const x = misc.getPathFolder("sss/yyy");
    // console.log(x)
    assert.equal(x, "sss/");
  });

  it("should treat / specially", async () => {
    const x = misc.getPathFolder("/");
    assert.equal(x, "/");

    const y = misc.getPathFolder("/abc");
    assert.equal(y, "/");
  });
});

describe("Misc: extract svg", () => {
  beforeEach(() => {
    const fakeBrowser = new JSDOM("");
    global.window = fakeBrowser.window as any;
  });

  it("should extract rect from svg correctly", () => {
    const x = "<svg><rect/><g/></svg>";
    const y = misc.extractSvgSub(x);
    // console.log(x)
    assert.equal(y, "<rect/><g/>");
  });
});

describe("Misc: get split ranges", () => {
  it("should deal with big parts", () => {
    const k = misc.getSplitRanges(10, 20);
    const k2: misc.SplitRange[] = [
      {
        partNum: 1,
        start: 0,
        end: 10,
      },
    ];
    assert.deepEqual(k, k2);
  });

  it("should deal with 0 remainder", () => {
    const k = misc.getSplitRanges(20, 10);
    const k2: misc.SplitRange[] = [
      {
        partNum: 1,
        start: 0,
        end: 10,
      },
      {
        partNum: 2,
        start: 10,
        end: 20,
      },
    ];
    assert.deepEqual(k, k2);
  });

  it("should deal with not-0 remainder", () => {
    const k = misc.getSplitRanges(25, 10);
    const k2: misc.SplitRange[] = [
      {
        partNum: 1,
        start: 0,
        end: 10,
      },
      {
        partNum: 2,
        start: 10,
        end: 20,
      },
      {
        partNum: 3,
        start: 20,
        end: 25,
      },
    ];
    assert.deepEqual(k, k2);
  });
});

describe("Misc: at which level", () => {
  it("should throw error on some parameters", () => {
    assert.throws(() => misc.atWhichLevel(undefined));
    assert.throws(() => misc.atWhichLevel(""));
    assert.throws(() => misc.atWhichLevel(".."));
    assert.throws(() => misc.atWhichLevel("."));
    assert.throws(() => misc.atWhichLevel("/"));
    assert.throws(() => misc.atWhichLevel("/xxyy"));
  });

  it("should treat folders correctly", () => {
    assert.equal(misc.atWhichLevel("x/"), 1);
    assert.equal(misc.atWhichLevel("x/y/"), 2);
  });

  it("should treat files correctly", () => {
    assert.equal(misc.atWhichLevel("x.md"), 1);
    assert.equal(misc.atWhichLevel("x/y.md"), 2);
    assert.equal(misc.atWhichLevel("x/y/z.md"), 3);
  });
});

describe("Misc: special char for dir", () => {
  it("should return false for normal string", () => {
    assert.ok(!misc.checkHasSpecialCharForDir(""));
    assert.ok(!misc.checkHasSpecialCharForDir("xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy_xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy.xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy？xxx"));
  });

  it("should return true for special cases", () => {
    assert.ok(misc.checkHasSpecialCharForDir("?"));
    assert.ok(misc.checkHasSpecialCharForDir("/"));
    assert.ok(misc.checkHasSpecialCharForDir("\\"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx/yyy"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx\\yyy"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx?yyy"));
  });
});

describe("Misc: split chunk ranges", () => {
  it("should fail on negative numner", () => {
    assert.throws(() => misc.splitFileSizeToChunkRanges(-1, 2));
    assert.throws(() => misc.splitFileSizeToChunkRanges(1, -1));
    assert.throws(() => misc.splitFileSizeToChunkRanges(1, 0));
  });

  it("should return nothing for 0 input", () => {
    let input: [number, number] = [0, 1];
    let output: any = [];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [0, 100];
    output = [];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return single item for 1 input", () => {
    let input: [number, number] = [1, 1];
    let output = [{ start: 0, end: 0 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [1, 100];
    output = [{ start: 0, end: 0 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return single item for larger or equal input", () => {
    let input: [number, number] = [10, 10];
    let output = [{ start: 0, end: 9 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [10, 21];
    output = [{ start: 0, end: 9 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return correct items for normal input", () => {
    let input: [number, number] = [10, 9];
    let output = [
      { start: 0, end: 8 },
      { start: 9, end: 9 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [10, 5];
    output = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [3, 1];
    output = [
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [15, 5];
    output = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [1024, 578];
    output = [
      { start: 0, end: 577 },
      { start: 578, end: 1023 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });
});

describe("Misc: check valid file names", () => {
  it("should be ok for normal file nmes", () => {
    let item = "what/.hidden/what/what/what";
    assert.ok(misc.checkValidName(item).result);

    item = "ssss/%%%^^^$xxxx.md";
    assert.ok(misc.checkValidName(item).result);
  });

  it("should be not ok for reserved characters", () => {
    let item = "a**";
    assert.ok(!misc.checkValidName(item).result);

    item = "a?*";
    assert.ok(!misc.checkValidName(item).result);

    item = "<>:";
    assert.ok(!misc.checkValidName(item).result);

    item = "<>:/ssss";
    assert.ok(!misc.checkValidName(item).result);
  });

  it("should be not ok for reserved names", () => {
    let item = "CON";
    assert.ok(!misc.checkValidName(item).result);

    item = "CON.txt";
    assert.ok(!misc.checkValidName(item).result);

    item = "CON.md";
    assert.ok(!misc.checkValidName(item).result);

    item = "con"; // lower case is ok
    assert.ok(misc.checkValidName(item).result);

    item = "CON/";
    assert.ok(!misc.checkValidName(item).result);

    item = "CON.dir/";
    assert.ok(!misc.checkValidName(item).result);

    item = "CON.dir.folder/";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx/CON";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx/CON.txt";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx/CON.txt.md";
    assert.ok(!misc.checkValidName(item).result);
  });

  it("should be not ok for invalid endings", () => {
    let item = "xxx ";
    assert.ok(!misc.checkValidName(item).result);

    item = "/xxx ";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx.yyy.";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx.yyy.";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx /";
    assert.ok(!misc.checkValidName(item).result);

    item = "xxx.yyy./";
    assert.ok(!misc.checkValidName(item).result);
  });
});

describe("Misc: should fix the folder name cases", () => {
  it("should do nothing on empty folders", () => {
    const input: any[] = [];
    assert.equal(misc.fixEntityListCasesInplace(input).length, 0);
  });

  it("should sort folders by length by side effect", () => {
    const input = [
      { keyRaw: "aaaa/" },
      { keyRaw: "bbb/" },
      { keyRaw: "c/" },
      { keyRaw: "dd/" },
    ];

    const output = [
      { keyRaw: "c/" },
      { keyRaw: "dd/" },
      { keyRaw: "bbb/" },
      { keyRaw: "aaaa/" },
    ];
    assert.deepEqual(misc.fixEntityListCasesInplace(input), output);
  });

  it("should fix folder names", () => {
    const input = [
      { keyRaw: "AAA/" },
      { keyRaw: "aaa/bbb/CCC.md" },
      { keyRaw: "aaa/BBB/" },

      { keyRaw: "ddd/" },
      { keyRaw: "DDD/EEE/fff.md" },
      { keyRaw: "DDD/eee/" },

      { keyRaw: "Ggg/" },
      { keyRaw: "ggG/hHH你好/Fff世界.md" },
      { keyRaw: "ggG/Hhh你好/" },
    ];

    const output = [
      { keyRaw: "AAA/" },
      { keyRaw: "ddd/" },
      { keyRaw: "Ggg/" },
      { keyRaw: "AAA/BBB/" },
      { keyRaw: "ddd/eee/" },
      { keyRaw: "Ggg/Hhh你好/" },
      { keyRaw: "AAA/BBB/CCC.md" },
      { keyRaw: "ddd/eee/fff.md" },
      { keyRaw: "Ggg/Hhh你好/Fff世界.md" },
    ];
    assert.deepEqual(misc.fixEntityListCasesInplace(input), output);
  });
});

describe("Misc: validateRegex", () => {
  it("should accept legit regexes", () => {
    assert.equal(misc.validateRegex("test").ok, true);
    assert.equal(misc.validateRegex("^test$").ok, true);
    assert.equal(misc.validateRegex(String.raw`\.png$`).ok, true);
    assert.equal(misc.validateRegex("tmp/.*").ok, true);
  });

  it("should reject invalid regexes with non-empty error", () => {
    const expectInvalid = (r: string) => {
      const res = misc.validateRegex(r);
      assert.equal(res.ok, false, `expected ok=false for ${JSON.stringify(r)}`);
      // narrow to the error branch to read .error safely
      if (res.ok === false) {
        assert.ok(typeof res.error === "string");
        assert.ok(
          res.error.length > 0,
          `expected non-empty error for ${JSON.stringify(r)}`
        );
      }
    };
    expectInvalid("(");
    expectInvalid("[unclosed");
    expectInvalid("*leading");
  });
});

describe("Misc: testPathAgainstRegexList", () => {
  it("should return no match for an empty list", () => {
    assert.deepEqual(misc.testPathAgainstRegexList([], "anything"), {
      matched: false,
      matchedRegexes: [],
    });
  });

  it("should match an anchored-end regex on exact input", () => {
    assert.deepEqual(misc.testPathAgainstRegexList(["test$"], "test"), {
      matched: true,
      matchedRegexes: ["test$"],
    });
  });

  it("should not match when end-anchor fails", () => {
    assert.deepEqual(misc.testPathAgainstRegexList(["test$"], "testing"), {
      matched: false,
      matchedRegexes: [],
    });
  });

  it("should match .png$ on a.png but not a.txt", () => {
    const png = String.raw`\.png$`;
    assert.deepEqual(misc.testPathAgainstRegexList([png], "a.png"), {
      matched: true,
      matchedRegexes: [png],
    });
    assert.deepEqual(misc.testPathAgainstRegexList([png], "a.txt"), {
      matched: false,
      matchedRegexes: [],
    });
  });

  it("should collect multiple matches preserving order and duplicates", () => {
    // both "ab" and "bc" are substrings of "abc"
    assert.deepEqual(misc.testPathAgainstRegexList(["ab", "bc"], "abc"), {
      matched: true,
      matchedRegexes: ["ab", "bc"],
    });
    // only first matches
    assert.deepEqual(misc.testPathAgainstRegexList(["abc", "xyz"], "abc"), {
      matched: true,
      matchedRegexes: ["abc"],
    });
    // duplicates both kept, in order
    assert.deepEqual(misc.testPathAgainstRegexList(["abc", "abc"], "abc"), {
      matched: true,
      matchedRegexes: ["abc", "abc"],
    });
  });

  it("should skip invalid regex entries without throwing", () => {
    assert.deepEqual(misc.testPathAgainstRegexList(["(", "abc"], "abc"), {
      matched: true,
      matchedRegexes: ["abc"],
    });
  });

  it("should skip empty and whitespace-only entries", () => {
    assert.deepEqual(
      misc.testPathAgainstRegexList(["", "  ", "abc"], "abc"),
      {
        matched: true,
        matchedRegexes: ["abc"],
      }
    );
  });
});

describe("Misc: testPathAgainstRegexList slash compatibility", () => {
  it("should normalize backslash in input path", () => {
    // regex uses /, user pastes Windows-style path with \
    assert.deepEqual(misc.testPathAgainstRegexList(["tmp/.*"], "tmp\\foo"), {
      matched: true,
      matchedRegexes: ["tmp/.*"],
    });
  });

  it("should normalize double-backslash in regex (path separator intent)", () => {
    // regex uses \\ (literal backslash), path uses /
    assert.deepEqual(misc.testPathAgainstRegexList(["tmp\\\\.*"], "tmp/foo"), {
      matched: true,
      matchedRegexes: ["tmp\\\\.*"], // original regex returned, not normalized
    });
  });

  it("should match when both path and regex use backslashes", () => {
    assert.deepEqual(misc.testPathAgainstRegexList(["tmp\\\\.*"], "tmp\\foo"), {
      matched: true,
      matchedRegexes: ["tmp\\\\.*"],
    });
  });

  it("should NOT touch single-backslash escapes like \\.", () => {
    // \.png$ still works (\. is one backslash + dot, NOT \\)
    const r = String.raw`\.png$`;
    assert.deepEqual(misc.testPathAgainstRegexList([r], "a.png"), {
      matched: true,
      matchedRegexes: [r],
    });
    assert.deepEqual(misc.testPathAgainstRegexList([r], "a_png"), {
      matched: false,
      matchedRegexes: [],
    });
  });

  it("forward-slash paths and regexes still work (no regression)", () => {
    assert.deepEqual(misc.testPathAgainstRegexList(["tmp/.*"], "tmp/foo"), {
      matched: true,
      matchedRegexes: ["tmp/.*"],
    });
  });
});
