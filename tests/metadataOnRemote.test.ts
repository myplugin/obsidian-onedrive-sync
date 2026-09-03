import { strict as assert } from "assert";
import {
  type MetadataOnRemote,
  isEqualMetadataOnRemote,
  serializeMetadataOnRemote,
  deserializeMetadataOnRemote,
} from "../src/metadataOnRemote";

describe("Metadata operations tests", () => {
  it("should compare objects deeply", async () => {
    const a: MetadataOnRemote = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
    };
    const b: MetadataOnRemote = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
    };

    assert.ok(isEqualMetadataOnRemote(a, b));
  });

  it("should find diff", async () => {
    const a: MetadataOnRemote = {
      deletions: [
        { key: "xxxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
    };
    const b: MetadataOnRemote = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
    };

    assert.ok(!isEqualMetadataOnRemote(a, b));
  });

  it("should treat undefined correctly", async () => {
    const a: MetadataOnRemote | undefined = undefined;
    let b: MetadataOnRemote | undefined = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
    };

    assert.ok(!isEqualMetadataOnRemote(a, b));

    b = { deletions: [] };
    assert.ok(isEqualMetadataOnRemote(a, b));

    b = { deletions: undefined };
    assert.ok(isEqualMetadataOnRemote(a, b));

    b = undefined;
    assert.ok(isEqualMetadataOnRemote(a, b));
  });

  it("should ignore generated at fields", async () => {
    const a: MetadataOnRemote = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
      generatedWhen: 1,
    };
    const b: MetadataOnRemote = {
      deletions: [
        { key: "xxx", actionWhen: 1 },
        { key: "yyy", actionWhen: 2 },
      ],
      generatedWhen: 2,
    };

    assert.ok(isEqualMetadataOnRemote(a, b));
  });

  // REGRESSION: serializeMetadataOnRemote had a typo (=== instead of =)
  // that prevented the version field from being defaulted. The field was
  // never set when undefined, silently omitting it from the output.
  it("should set default version when undefined (Bug 4 regression)", () => {
    const input: MetadataOnRemote = {
      deletions: [{ key: "a.md", actionWhen: 1 }],
    };
    // version is intentionally undefined — serialize should default it
    assert.strictEqual(input.version, undefined);

    const serialized = serializeMetadataOnRemote(input);
    const roundtrip = deserializeMetadataOnRemote(serialized);

    assert.ok(
      roundtrip.version !== undefined,
      "version should have been defaulted during serialization"
    );
  });

  it("should preserve an explicitly set version", () => {
    const input: MetadataOnRemote = {
      version: "custom-version",
      deletions: [],
    };
    const serialized = serializeMetadataOnRemote(input);
    const roundtrip = deserializeMetadataOnRemote(serialized);

    assert.strictEqual(roundtrip.version, "custom-version");
  });
});
