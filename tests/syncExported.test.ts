// License: Apache-2.0 (see src/LICENSE)
// Tests for sync.ts exported pure functions.

import { strict as assert } from "assert";
import { getSkipItemsByList } from "../src/sync";

// IsSkipResult is not exported, but we can construct objects matching the shape.
interface SkipResult {
  enableAllowMode: boolean;
  isExplictlyAllowed: boolean;
  isExplictlyIgnored: boolean;
  finalIsIgnored: boolean;
}

function makeResult(
  ignored = false,
  allowed = false,
  allowMode = false,
  finalIgnored = false
): SkipResult {
  return {
    enableAllowMode: allowMode,
    isExplictlyAllowed: allowed,
    isExplictlyIgnored: ignored,
    finalIsIgnored: finalIgnored,
  };
}

describe("Sync: getSkipItemsByList", () => {
  it("should return empty for empty input", () => {
    const result = getSkipItemsByList({});
    assert.strictEqual(result.length, 0);
  });

  it("should return keys with finalIsIgnored=true", () => {
    const input: Record<string, any> = {
      "a.md": makeResult(true, false, false, false),
      "b.md": makeResult(false, false, false, false),
    };
    const result = getSkipItemsByList(input);
    assert.ok(result.includes("a.md"));
    assert.ok(!result.includes("b.md"));
  });

  it("should apply parent's explicitly ignored to children", () => {
    const input: Record<string, any> = {
      "folder/": makeResult(true, false, false, false),
      "folder/file.md": makeResult(false, false, false, false),
    };
    const result = getSkipItemsByList(input as any);
    assert.ok(result.includes("folder/"));
    assert.ok(result.includes("folder/file.md"));
  });

  it("should NOT apply child's ignored to parent", () => {
    const input: Record<string, any> = {
      "folder/": makeResult(false, false, false, false),
      "folder/file.md": makeResult(true, false, false, false),
    };
    const result = getSkipItemsByList(input as any);
    assert.ok(result.includes("folder/file.md"));
    assert.ok(!result.includes("folder/"));
  });

  it("should handle allow mode: allowed child unblocks parent", () => {
    const input: Record<string, any> = {
      "folder/": makeResult(false, false, true, true), // allowMode, not allowed, finalIgnored
      "folder/file.md": makeResult(false, true, true, false), // allowed
    };
    const result = getSkipItemsByList(input as any);
    // file is allowed → parent should be unblocked (finalIsIgnored=false)
    assert.ok(!result.includes("folder/"));
    assert.ok(!result.includes("folder/file.md"));
  });

  it("should handle allow mode: non-allowed file stays ignored", () => {
    const input: Record<string, any> = {
      "folder/": makeResult(false, false, true, true), // allowMode, finalIgnored
      "folder/a.md": makeResult(false, true, true, false), // allowed
      "folder/b.md": makeResult(false, false, true, true), // not allowed, finalIgnored
    };
    const result = getSkipItemsByList(input as any);
    assert.ok(!result.includes("folder/")); // unblocked by a.md
    assert.ok(!result.includes("folder/a.md")); // allowed
    assert.ok(result.includes("folder/b.md")); // not allowed → stays ignored
  });

  it("should handle nested folders with ignore propagation", () => {
    const input: Record<string, any> = {
      "a/": makeResult(true, false, false, false),
      "a/b/": makeResult(false, false, false, false),
      "a/b/c.md": makeResult(false, false, false, false),
    };
    const result = getSkipItemsByList(input as any);
    // a/ is ignored → all children should be ignored
    assert.ok(result.includes("a/"));
    assert.ok(result.includes("a/b/"));
    assert.ok(result.includes("a/b/c.md"));
  });
});
