import { strict as assert } from "assert";
import { base64url } from "rfc4648";
import {
  type MetadataOnRemote,
  deserializeMetadataOnRemote,
  isEqualMetadataOnRemote,
  serializeMetadataOnRemote,
} from "../src/metadataOnRemote";
import { bufferToArrayBuffer, reverseString } from "../src/misc";

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

describe("MetadataOnRemote edge cases", () => {
  it("should deserialize from an ArrayBuffer input", () => {
    const input: MetadataOnRemote = {
      version: "v-test",
      generatedWhen: 123,
      deletions: [{ key: "a.md", actionWhen: 456 }],
    };
    const serialized = serializeMetadataOnRemote(input);
    const asBuf = bufferToArrayBuffer(Buffer.from(serialized, "utf-8"));
    const roundtrip = deserializeMetadataOnRemote(asBuf);
    assert.deepEqual(roundtrip, input);
  });

  it("should throw on malformed JSON", () => {
    assert.throws(
      () => deserializeMetadataOnRemote("not json {{{"),
      /invalid remote meta data file with first few chars: not j/
    );
  });

  it("should throw when readme/d fields are missing", () => {
    assert.throws(
      () => deserializeMetadataOnRemote('{"foo": 1}'),
      /no "readme" or "d" fields/
    );
    assert.throws(
      () => deserializeMetadataOnRemote('{"readme": "only readme"}'),
      /no "readme" or "d" fields/
    );
    assert.throws(
      () => deserializeMetadataOnRemote('{"d": "only d"}'),
      /no "readme" or "d" fields/
    );
  });

  it("should throw on a scalar JSON payload", () => {
    // "readme" in 123 -> TypeError from the `in` operator
    assert.throws(() => deserializeMetadataOnRemote("123"), TypeError);
  });

  it("should throw on an invalid d field (not base64url)", () => {
    const payload = JSON.stringify({
      readme: "x",
      d: "!!!definitely-not-base64!!!",
    });
    assert.throws(
      () => deserializeMetadataOnRemote(payload),
      /invalid "d" field/
    );
  });

  it("should throw when d decodes to non-JSON text", () => {
    const d = reverseString(
      base64url.stringify(Buffer.from("hello world", "utf-8"), { pad: false })
    );
    const payload = JSON.stringify({ readme: "x", d });
    assert.throws(
      () => deserializeMetadataOnRemote(payload),
      /with "d" field with first few chars: hello/
    );
  });

  it("should fill all default fields when they are undefined", () => {
    const before = Date.now();
    const serialized = serializeMetadataOnRemote({});
    const after = Date.now();
    const roundtrip = deserializeMetadataOnRemote(serialized);
    assert.strictEqual(roundtrip.version, "20220220");
    assert.ok(roundtrip.generatedWhen !== undefined);
    assert.ok(
      (roundtrip.generatedWhen as number) >= before &&
        (roundtrip.generatedWhen as number) <= after
    );
    assert.deepStrictEqual(roundtrip.deletions, []);
  });

  it("should not mutate the input during serialization", () => {
    const input: MetadataOnRemote = {};
    serializeMetadataOnRemote(input);
    assert.deepStrictEqual(input, {});
  });

  it("should treat two empty objects as equal", () => {
    assert.ok(isEqualMetadataOnRemote({}, {}));
  });

  it("should treat empty deletions and undefined deletions as equal", () => {
    assert.ok(isEqualMetadataOnRemote({ deletions: [] }, {}));
    assert.ok(isEqualMetadataOnRemote({}, { deletions: [] }));
    assert.ok(isEqualMetadataOnRemote({}, undefined));
    assert.ok(isEqualMetadataOnRemote(undefined, {}));
  });

  it("should detect different actionWhen values", () => {
    assert.ok(
      !isEqualMetadataOnRemote(
        { deletions: [{ key: "a", actionWhen: 1 }] },
        { deletions: [{ key: "a", actionWhen: 2 }] }
      )
    );
  });

  it("should detect different deletion orders", () => {
    const d1 = [
      { key: "a", actionWhen: 1 },
      { key: "b", actionWhen: 2 },
    ];
    const d2 = [
      { key: "b", actionWhen: 2 },
      { key: "a", actionWhen: 1 },
    ];
    assert.ok(!isEqualMetadataOnRemote({ deletions: d1 }, { deletions: d2 }));
  });

  it("should ignore version and generatedWhen in comparisons", () => {
    assert.ok(
      isEqualMetadataOnRemote(
        { version: "1", generatedWhen: 1, deletions: [] },
        { version: "2", generatedWhen: 2, deletions: [] }
      )
    );
  });
});
