/**
 * Microsoft QuickXorHash: the non-cryptographic content hash OneDrive
 * exposes as `file.hashes.quickXorHash` in the Graph API. It only answers
 * "do these two files have identical content" (e.g. for rename/move
 * tracking) and must never be used for security purposes.
 *
 * Ported from Microsoft's official C# reference implementation (the
 * "QuickXorHash" sample in the OneDrive developer documentation).
 *
 * Algorithm: the 160-bit state is held in three 64-bit "cells" (the last
 * cell only uses its low 32 bits: 64 + 64 + 32 = 160). Every input byte is
 * XOR-ed into the state at a bit offset that rotates by `SHIFT` (11) bits
 * per byte and wraps around the state; bytes 160 apart therefore land on
 * the same offset and are XOR-folded together. In `HashFinal` the 64-bit
 * little-endian input length is XOR-ed into the least significant bytes
 * (bytes 12..19), and the state is serialized little-endian to 20 bytes.
 *
 * JavaScript has no UInt64 type (and this project targets ES6, so BigInt is
 * unavailable), so each 64-bit cell is stored as a lo/hi pair of 32-bit
 * words in a `Uint32Array`: cell c occupies indices 2*c (lo) and 2*c + 1
 * (hi). This matches the little-endian serialization order, and JS 32-bit
 * shift truncation naturally reproduces the C# `unchecked` `ulong`
 * overflow behavior (bits shifted past bit 63 are dropped, then recovered
 * into the next cell via `>>> low`, exactly like the reference).
 *
 * This function is pure: same input, same output, no side effects.
 */

const BITS_IN_LAST_CELL = 32;
const SHIFT = 11;
const WIDTH_IN_BITS = 160;
/** Number of 64-bit cells: (160 - 1) / 64 + 1 = 3 (C# integer division). */
const CELLS = Math.floor((WIDTH_IN_BITS - 1) / 64) + 1;
/** Hash output size: (160 - 1) / 8 + 1 = 20 bytes (C# integer division). */
const OUTPUT_BYTES = Math.floor((WIDTH_IN_BITS - 1) / 8) + 1;

/**
 * XOR an 8-bit value into one 64-bit cell at a cell-local bit offset.
 *
 * Bits shifted past bit 63 of the cell are dropped, matching the C#
 * reference where `(ulong)value << offset` overflows silently; the caller
 * recovers those bits into the next cell with `value >>> low`. For the last
 * cell, bits above `BITS_IN_LAST_CELL` stay in the cell's high word but are
 * dropped during serialization, exactly like the C# `HashFinal`
 * `Buffer.BlockCopy` of only 4 bytes for that cell.
 */
function xorIntoCell(
  cells: Uint32Array,
  cell: number,
  offset: number,
  value: number
): void {
  const lo = 2 * cell;
  const hi = lo + 1;
  if (offset < 32) {
    cells[lo] ^= value << offset;
    if (offset > 24) {
      // The byte straddles the 32-bit word boundary within the cell.
      cells[hi] ^= value >>> (32 - offset);
    }
  } else {
    // `value << (offset - 32)` may exceed 32 bits; JS truncates to int32,
    // i.e. cell bits >= 64 are dropped, same as C# ulong overflow.
    cells[hi] ^= value << (offset - 32);
  }
}

/**
 * Compute the Microsoft QuickXorHash of the given bytes, returned as a
 * base64 string in the exact format OneDrive uses for
 * `file.hashes.quickXorHash` (e.g. 20 zero bytes for empty input:
 * `"AAAAAAAAAAAAAAAAAAAAAAAAAAA="`).
 *
 * Accepts an `ArrayBuffer` or any `Uint8Array` view (a non-zero
 * `byteOffset` is respected; the input is never modified).
 */
export function quickXorHash(data: ArrayBuffer | Uint8Array): string {
  const array = data instanceof Uint8Array ? data : new Uint8Array(data);
  const cbSize = array.length;

  // Initialize(): 3 cells x (lo, hi) 32-bit words, all zero.
  const cells = new Uint32Array(2 * CELLS);

  // HashCore(), called once with the whole input. For a one-shot hash
  // _shiftSoFar starts at 0, so vectorArrayIndex/vectorOffset start at 0
  // and the final _shiftSoFar update is not needed (no further data).
  let vectorArrayIndex = 0;
  let vectorOffset = 0;
  const iterations = Math.min(cbSize, WIDTH_IN_BITS);

  for (let i = 0; i < iterations; i++) {
    const isLastCell = vectorArrayIndex === CELLS - 1;
    const bitsInVectorCell = isLastCell ? BITS_IN_LAST_CELL : 64;

    // All bytes at indices i, i + 160, i + 320, ... land on the same bit
    // position. The C# inner `j` loop XORs them into the cell one by one,
    // which (XOR being associative and commutative) equals folding them
    // into a single byte first, as the C# straddling branch also does.
    let xoredByte = 0;
    for (let j = i; j < cbSize; j += WIDTH_IN_BITS) {
      xoredByte ^= array[j];
    }

    if (vectorOffset <= bitsInVectorCell - 8) {
      // The byte fits entirely inside the current cell.
      xorIntoCell(cells, vectorArrayIndex, vectorOffset, xoredByte);
    } else {
      // The byte straddles the end of the current cell: the low bits stay
      // here, the high bits wrap into the next cell (or back into cell 0
      // when straddling the end of the last cell).
      const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
      const low = bitsInVectorCell - vectorOffset;
      xorIntoCell(cells, vectorArrayIndex, vectorOffset, xoredByte);
      xorIntoCell(cells, index2, 0, xoredByte >>> low);
    }

    vectorOffset += SHIFT;
    while (vectorOffset >= bitsInVectorCell) {
      vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
      vectorOffset -= bitsInVectorCell;
    }
  }

  // HashFinal(): serialize little-endian to 20 bytes. The first 5 words of
  // `cells` are exactly bytes 0..19 in order; word 5 (the high word of the
  // last cell) is intentionally dropped, since that cell only counts for
  // BITS_IN_LAST_CELL (32) bits.
  const rgb = new Uint8Array(OUTPUT_BYTES);
  const view = new DataView(rgb.buffer);
  for (let w = 0; w < OUTPUT_BYTES / 4; w++) {
    view.setUint32(w * 4, cells[w], true);
  }

  // XOR the 64-bit little-endian input length into the least significant
  // 8 bytes (bytes 12..19), matching the C# BitConverter.GetBytes loop.
  const lenOffset = OUTPUT_BYTES - 8;
  const lenLo = cbSize >>> 0;
  const lenHi = Math.floor(cbSize / 0x100000000);
  view.setUint32(lenOffset, view.getUint32(lenOffset, true) ^ lenLo, true);
  view.setUint32(
    lenOffset + 4,
    view.getUint32(lenOffset + 4, true) ^ lenHi,
    true
  );

  return Buffer.from(rgb).toString("base64");
}
