import { strict as assert } from "assert";
import { quickXorHash } from "../src/quickXorHash";

/**
 * Independent, naive bit-level reference implementation of QuickXorHash,
 * used to cross-check the optimized port in src/quickXorHash.ts.
 *
 * It models the hash literally as a 160-bit circular bit buffer: byte i of
 * the input is XOR-ed at bit offset (i * 11) mod 160 (bits past 159 wrap
 * around to bit 0), then the 64-bit little-endian input length is XOR-ed
 * into bits 96..159, and the result is serialized little-endian per byte.
 */
function naiveQuickXorHashBase64(bytes: Uint8Array): string {
  const bits = new Uint8Array(160);
  for (let i = 0; i < bytes.length; i++) {
    const pos = (i * 11) % 160;
    for (let k = 0; k < 8; k++) {
      if (((bytes[i] >> k) & 1) === 1) {
        bits[(pos + k) % 160] ^= 1;
      }
    }
  }
  const lenLo = bytes.length >>> 0;
  const lenHi = Math.floor(bytes.length / 0x100000000);
  for (let b = 0; b < 4; b++) {
    const loByte = (lenLo >>> (8 * b)) & 0xff;
    const hiByte = (lenHi >>> (8 * b)) & 0xff;
    for (let k = 0; k < 8; k++) {
      bits[96 + 8 * b + k] ^= (loByte >> k) & 1;
      bits[128 + 8 * b + k] ^= (hiByte >> k) & 1;
    }
  }
  const rgb = new Uint8Array(20);
  for (let m = 0; m < 20; m++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      v |= bits[8 * m + k] << k;
    }
    rgb[m] = v;
  }
  return Buffer.from(rgb).toString("base64");
}

describe("quickXorHash", () => {
  it("should hash empty input to 20 zero bytes (base64)", () => {
    // Confirmed against real OneDrive data: an empty file has this exact
    // file.hashes.quickXorHash value.
    const expected = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    assert.equal(quickXorHash(new Uint8Array(0)), expected);
    assert.equal(quickXorHash(new ArrayBuffer(0)), expected);
    assert.equal(quickXorHash(Buffer.alloc(0)), expected);
  });

  it("should be deterministic", () => {
    const content = "some sample content for hashing";
    const buf = Buffer.from(content);
    assert.equal(quickXorHash(buf), quickXorHash(buf));
    assert.equal(quickXorHash(Buffer.from(content)), quickXorHash(buf));
  });

  it("should produce different hashes for different content", () => {
    assert.notEqual(
      quickXorHash(Buffer.from("A")),
      quickXorHash(Buffer.from("B"))
    );
  });

  it('should hash "Hello World" to the reference value', () => {
    // Computed by this implementation and independently cross-checked
    // against a naive bit-level model of Microsoft's algorithm.
    assert.equal(
      quickXorHash(Buffer.from("Hello World")),
      "SCgDG9jwBhBc4Q1yawMZAAAAAAA="
    );
  });

  it("should accept ArrayBuffer, Uint8Array and Buffer equivalently", () => {
    const content = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 128, 255]);
    const fromAb = quickXorHash(content.slice().buffer);
    assert.equal(fromAb, quickXorHash(content));
    assert.equal(quickXorHash(Buffer.from(content)), quickXorHash(content));

    // A Uint8Array view with a non-zero byteOffset must hash its own window,
    // not the underlying buffer from position 0.
    const full = new Uint8Array(300);
    for (let i = 0; i < full.length; i++) {
      full[i] = i % 256;
    }
    const view = full.subarray(50, 250);
    assert.equal(quickXorHash(view), quickXorHash(view.slice()));
  });

  it("should match the naive bit-level reference for many sizes", () => {
    // Deterministic pseudo-random bytes (LCG), so failures are reproducible.
    let seed = 42;
    const nextByte = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    };
    const sizes = [
      0, 1, 2, 7, 11, 19, 20, 63, 64, 159, 160, 161, 319, 320, 321, 1000,
    ];
    for (const size of sizes) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        bytes[i] = nextByte();
      }
      assert.equal(
        quickXorHash(bytes),
        naiveQuickXorHashBase64(bytes),
        `hash mismatch for input size ${size}`
      );
    }
  });
});
