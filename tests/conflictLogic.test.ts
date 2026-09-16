import { deepStrictEqual, ok, rejects, throws } from "assert";
import {
  getFileRenameForDup,
  threeWayMerge,
  twoWayMerge,
} from "../src/mergeUtils";

describe("New name is generated", () => {
  it("should throw for empty file", async () => {
    for (const key of ["", "/", ".", ".."]) {
      throws(() => getFileRenameForDup(key));
    }
  });

  it("should throw for folder", async () => {
    for (const key of ["sss/", "ssss/yyy/"]) {
      throws(() => getFileRenameForDup(key));
    }
  });

  it("should correctly get no ext files renamed", async () => {
    deepStrictEqual(getFileRenameForDup("abc"), "abc.dup");

    deepStrictEqual(getFileRenameForDup("xxxx/yyyy/abc"), "xxxx/yyyy/abc.dup");
  });

  it("should correctly get dot files renamed", async () => {
    deepStrictEqual(getFileRenameForDup(".abc"), ".abc.dup");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.efg"),
      "xxxx/yyyy/.efg.dup"
    );

    deepStrictEqual(getFileRenameForDup("xxxx/yyyy/hij."), "xxxx/yyyy/hij.dup");
  });

  it("should correctly get normal files renamed", async () => {
    deepStrictEqual(getFileRenameForDup("abc.efg"), "abc.dup.efg");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.efg"),
      "xxxx/yyyy/abc.dup.efg"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.tar.gz"),
      "xxxx/yyyy/abc.tar.dup.gz"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.efg"),
      "xxxx/yyyy/.abc.dup.efg"
    );
  });

  it("should correctly get duplicated files renamed again", async () => {
    deepStrictEqual(getFileRenameForDup("abc.dup"), "abc.dup.dup");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.dup"),
      "xxxx/yyyy/.abc.dup.dup"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.dup.md"),
      "xxxx/yyyy/abc.dup.dup.md"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.dup.md"),
      "xxxx/yyyy/.abc.dup.dup.md"
    );
  });
});

describe("Two way merge", () => {
  it("should correctly merge from zero files", async () => {
    const a = "aaa";
    const b = "bbb";
    const res = twoWayMerge(a, b);
    const expected = `\`<<<<<<<\`
aaa
\`=======\`
bbb
\`>>>>>>>\``;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge from common lines", async () => {
    const a = `
Something is cool. 中文1
Other thing is cooler. 哈哈！
`;
    const b = `
Anything is cool. 中文2
Other thing is cooler. 哈哈！
`;
    const res = twoWayMerge(a, b);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
Something is cool. 中文1
\`=======\`
Anything is cool. 中文2
\`>>>>>>>\`
Other thing is cooler. 哈哈！
`;
    deepStrictEqual(expected, res);
  });

  it("should merge by lines", async () => {
    const a = `
Something is cool. 中文1
`;
    const b = `
Something is cooler. 中文2
`;
    const res = twoWayMerge(a, b);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
Something is cool. 中文1
\`=======\`
Something is cooler. 中文2
\`>>>>>>>\`
`;
    deepStrictEqual(expected, res);
  });
});

describe("Three way merge", () => {
  it("should correctly merge from zero files", async () => {
    const orig = "";
    const a = "aaa";
    const b = "bbb";
    const res = threeWayMerge(a, b, orig);
    const expected = `\`<<<<<<<\`
aaa
\`=======\`
bbb
\`>>>>>>>\``;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding lines on both sides", async () => {
    const orig = `
* [ ] A1
* [ ] A2
* [ ] A3
`;
    const a = `
* [ ] A1
* [ ] new line after A1
* [ ] A2
* [ ] A3
`;
    const b = `
* [ ] A1
* [ ] A2
* [ ] New line after A2
* [ ] A3
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
* [ ] A1
* [ ] new line after A1
* [ ] A2
* [ ] New line after A2
* [ ] A3
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding lines on both sides (again)", async () => {
    const orig = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
`;
    const a = `
* [ ] 中文
* [ ] new line after 中文
* [ ] にほんご／にっぽんご
* [ ] A3
`;
    const b = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] New line after にほんご／にっぽんご
* [ ] A3
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
* [ ] 中文
* [ ] new line after 中文
* [ ] にほんご／にっぽんご
* [ ] New line after にほんご／にっぽんご
* [ ] A3
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after deleting lines on both sides", async () => {
    const orig = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
* [ ] にほんご／にっぽんご
\`=======\`
* [ ] 中文
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding on one side and deleting on other side", async () => {
    const orig = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
* [ ] 中文
* [ ] にほんご／にっぽんご
\`=======\`
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding on one side and deleting on other side (again)", async () => {
    const orig = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
\`=======\`
* [ ] 中文
* [ ] にほんご／にっぽんご
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });
});

describe("Two way merge: no common lines [M2 fix]", () => {
  // M2: getLCSText's do...while bug pushed aa[-1]=undefined when LCS was
  // empty, producing "undefined" as the common ancestor string. After the
  // fix (while loop), empty LCS returns "" and merges are sensible.
  it("should not produce 'undefined' string when texts have no common lines", () => {
    const a = "line1\nline2";
    const b = "line3\nline4";
    const result = twoWayMerge(a, b);
    ok(
      !result.includes("undefined"),
      `result should not contain 'undefined': ${result}`
    );
  });

  it("should handle completely different single-line texts", () => {
    const a = "hello";
    const b = "world";
    const result = twoWayMerge(a, b);
    ok(result.length > 0);
    ok(
      !result.includes("undefined"),
      `result should not contain 'undefined': ${result}`
    );
  });

  it("should still merge correctly when texts share common lines", () => {
    const a = "shared\nlineA";
    const b = "shared\nlineB";
    const result = twoWayMerge(a, b);
    ok(result.includes("shared"));
    ok(
      !result.includes("undefined"),
      `result should not contain 'undefined': ${result}`
    );
  });
});
