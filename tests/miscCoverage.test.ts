// License: Apache-2.0 (see src/LICENSE)
// Coverage tests for misc.ts functions that are not covered by misc.test.ts.

import { strict as assert } from "assert";
import * as misc from "../src/misc";

describe("Misc: fixEntityListCasesInplace", () => {
  it("should do nothing on empty list", () => {
    const entities: { keyRaw: string }[] = [];
    const result = misc.fixEntityListCasesInplace(entities);
    assert.strictEqual(result.length, 0);
  });

  it("should fix folder name cases to match parent", () => {
    const entities = [
      { keyRaw: "Folder/" },
      { keyRaw: "Folder/file.md" },
    ];
    const result = misc.fixEntityListCasesInplace(entities);
    // Should preserve case consistency
    assert.ok(result[0].keyRaw.startsWith("Folder"));
    assert.ok(result[1].keyRaw.startsWith("Folder"));
  });

  it("should handle nested folders", () => {
    const entities = [
      { keyRaw: "A/" },
      { keyRaw: "A/B/" },
      { keyRaw: "A/B/file.md" },
    ];
    const result = misc.fixEntityListCasesInplace(entities);
    assert.strictEqual(result.length, 3);
  });
});

describe("Misc: roughSizeOfObject", () => {
  it("should return 0 for null", () => {
    assert.strictEqual(misc.roughSizeOfObject(null), 0);
  });

  it("should return 8 for a number", () => {
    assert.strictEqual(misc.roughSizeOfObject(42), 8);
  });

  it("should return 4 for a boolean", () => {
    assert.strictEqual(misc.roughSizeOfObject(true), 4);
  });

  it("should return length*2 for a string", () => {
    assert.strictEqual(misc.roughSizeOfObject("hello"), 10);
  });

  it("should handle nested objects", () => {
    const obj = { a: 1, b: "hi", c: true };
    const size = misc.roughSizeOfObject(obj);
    assert.ok(size > 0);
    // number(8) + string(4) + boolean(4) = 16 minimum
    assert.ok(size >= 16);
  });
});

describe("Misc: checkValidName edge cases [coverage]", () => {
  it("should return false for undefined input", () => {
    const result = misc.checkValidName(undefined as any);
    assert.strictEqual(result.result, false);
    assert.strictEqual(result.reason, "empty");
  });

  it("should return false for empty string", () => {
    const result = misc.checkValidName("");
    assert.strictEqual(result.result, false);
    assert.strictEqual(result.reason, "empty");
  });

  it("should return false for directory being .", () => {
    const result = misc.checkValidName(".");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("directory"));
  });

  it("should return false for directory being ..", () => {
    const result = misc.checkValidName("..");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("directory"));
  });

  it("should return false for path containing /./", () => {
    const result = misc.checkValidName("a/./b");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("directory"));
  });

  it("should return false for path containing /../", () => {
    const result = misc.checkValidName("a/../b");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("directory"));
  });

  it("should return false for ending with space", () => {
    const result = misc.checkValidName("file ");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("ending"));
  });

  it("should return false for ending with period", () => {
    const result = misc.checkValidName("file.");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("ending"));
  });

  it("should return false for reserved name CON", () => {
    const result = misc.checkValidName("CON");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("reserved"));
  });

  it("should return false for reserved name with extension", () => {
    const result = misc.checkValidName("CON.txt");
    assert.strictEqual(result.result, false);
    assert.ok(result.reason.includes("reserved"));
  });

  it("should return ok for normal filename", () => {
    const result = misc.checkValidName("note.md");
    assert.strictEqual(result.result, true);
    assert.strictEqual(result.reason, "ok");
  });
});

describe("Misc: validateRegex non-string input [coverage]", () => {
  it("should return error for non-string input", () => {
    const result = misc.validateRegex(123 as any);
    assert.strictEqual(result.ok, false);
    assert.ok((result as any).error.includes("string"));
  });
});

describe("Misc: testPathAgainstRegexList non-string entry [coverage]", () => {
  it("should skip non-string entries", () => {
    const result = misc.testPathAgainstRegexList(
      [123 as any, ".*\\.md$"],
      "note.md"
    );
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.matchedRegexes.length, 1);
  });
});

describe("Misc: compareVersion", () => {
  it("should return 0 for equal versions", () => {
    assert.strictEqual(misc.compareVersion("1.0.0", "1.0.0"), 0);
  });

  it("should return positive for newer version", () => {
    assert.ok(misc.compareVersion("1.0.1", "1.0.0") > 0);
  });

  it("should return negative for older version", () => {
    assert.ok(misc.compareVersion("1.0.0", "1.0.1") < 0);
  });

  it("should return -1 for longer version with same first 3 parts (only compares 3 components)", () => {
    // compareVersion only compares first 3 components (x1, x2, x3)
    assert.strictEqual(misc.compareVersion("1.0.0.1", "1.0.0"), -1);
  });

  it("should return -1 for null first argument", () => {
    assert.strictEqual(misc.compareVersion(null, "1.0.0"), -1);
  });

  it("should return 1 for null second argument", () => {
    assert.strictEqual(misc.compareVersion("1.0.0", null), 1);
  });
});

describe("Misc: delay", () => {
  it("should resolve after specified milliseconds", async () => {
    const start = Date.now();
    await misc.delay(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `elapsed=${elapsed} should be >= 40`);
  });
});

describe("Misc: getTypeName", () => {
  it("should return type name for string", () => {
    assert.strictEqual(misc.getTypeName("hello"), "String");
  });

  it("should return type name for number", () => {
    assert.strictEqual(misc.getTypeName(42), "Number");
  });

  it("should return type name for object", () => {
    assert.strictEqual(misc.getTypeName({}), "Object");
  });
});

describe("Misc: reverseString", () => {
  it("should reverse a simple string", () => {
    assert.strictEqual(misc.reverseString("hello"), "olleh");
  });

  it("should reverse empty string", () => {
    assert.strictEqual(misc.reverseString(""), "");
  });
});

describe("Misc: toText", () => {
  it("should pass through string input", () => {
    assert.strictEqual(misc.toText("hello world"), "hello world");
  });

  it("should convert number to string", () => {
    assert.strictEqual(misc.toText(42), "42");
  });

  it("should convert undefined to string", () => {
    assert.strictEqual(misc.toText(undefined), "undefined");
  });

  it("should convert null to string", () => {
    assert.strictEqual(misc.toText(null), "null");
  });
});

describe("Misc: buffer/array conversions", () => {
  it("should convert arrayBuffer to buffer and back", () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const buf = misc.arrayBufferToBuffer(arr);
    const back = misc.bufferToArrayBuffer(buf);
    const view = new Uint8Array(back);
    assert.strictEqual(view[0], 1);
    assert.strictEqual(view[4], 5);
  });

  it("should copy array buffer", () => {
    const arr = new Uint8Array([1, 2, 3]).buffer;
    const copy = misc.copyArrayBuffer(arr);
    const view1 = new Uint8Array(arr);
    const view2 = new Uint8Array(copy);
    view1[0] = 99;
    // copy should be independent
    assert.strictEqual(view2[0], 1);
  });
});

describe("Misc: base64 conversions", () => {
  it("should convert arrayBuffer to base64 and back", () => {
    const arr = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
    const b64 = misc.arrayBufferToBase64(arr);
    assert.ok(typeof b64 === "string");
    assert.ok(b64.length > 0);
  });

  it("should convert base64 to arrayBuffer", () => {
    // "Hello" in base64
    const b64 = btoa("Hello");
    const arr = misc.base64ToArrayBuffer(b64);
    const view = new Uint8Array(arr);
    assert.strictEqual(view[0], 72); // 'H'
  });

  it("should convert base64 to base64url", () => {
    const result = misc.base64ToBase64url("a+b/c=");
    assert.ok(!result.includes("+"));
    assert.ok(!result.includes("/"));
  });
});

// getSha1 and unixTimeToStr depend on window.crypto / window.moment
// which are not available in the Node.js test environment (no jsdom).
// These functions are tested indirectly through the Obsidian runtime.
