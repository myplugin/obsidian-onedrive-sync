// Headless CLI state-DB smoke (Phase B Milestone 2.5).
//
// The correctness gate for NodeDb / FileForage: closes the
// load → mutate → persist → reload → verify loop. A NodeDb that loses data on
// reload is silently broken — sync state vanishes between runs → false
// conflicts on the next sync. So the smoke instantiates NodeDb against a temp
// dir, writes + reads, flushes, then builds a SECOND NodeDb over the SAME dir
// and asserts the persisted values survived the instance boundary.
//
// Exercises on db.simpleKVForMiscTbl:
//  - setItem / getItem / removeItem / getItems (the localforage-getitems ext)
//  - reload-after-persist (flush then new NodeDb → values survive)
//
// Exit 0 on `DB OK`, exit 1 on any assertion failure.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDb } from "./dbNode";

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "nodedb-smoke-"));
  try {
    // --- write + read (single instance) ---
    const db = new NodeDb(tmp);
    await db.simpleKVForMiscTbl.setItem("k1", { a: 1 });
    await db.simpleKVForMiscTbl.setItem("k2", "v2");

    const v1 = await db.simpleKVForMiscTbl.getItem("k1");
    assert(
      deepEqual(v1, { a: 1 }),
      `getItem("k1") after setItem: ${JSON.stringify(v1)} (expected {a:1})`,
    );

    const items = await db.simpleKVForMiscTbl.getItems();
    assert(
      Object.prototype.hasOwnProperty.call(items, "k1"),
      `getItems() missing k1: ${JSON.stringify(Object.keys(items))}`,
    );
    assert(
      Object.prototype.hasOwnProperty.call(items, "k2"),
      `getItems() missing k2: ${JSON.stringify(Object.keys(items))}`,
    );
    assert(
      deepEqual(items.k1, { a: 1 }),
      `getItems().k1: ${JSON.stringify(items.k1)}`,
    );
    assert(items.k2 === "v2", `getItems().k2: ${JSON.stringify(items.k2)}`);

    // --- removeItem ---
    await db.simpleKVForMiscTbl.removeItem("k1");
    const v1After = await db.simpleKVForMiscTbl.getItem("k1");
    assert(v1After === null, `getItem("k1") after removeItem: ${JSON.stringify(v1After)} (expected null)`);

    // --- flush (force persist, bypassing the debounce) ---
    // NodeDb.flushAll() flushes every FileForage table (simpleKVForMiscTbl's
    // real type is FileForage, but InternalDBs exposes it as LocalForage —
    // cast hides flush()). flushAll() reaches the same FileForage.flush().
    await db.flushAll();

    // --- reload: NEW NodeDb over the SAME dir → persisted values survive ---
    const db2 = new NodeDb(tmp);
    const v2 = await db2.simpleKVForMiscTbl.getItem("k2");
    assert(
      v2 === "v2",
      `reload getItem("k2"): ${JSON.stringify(v2)} (expected "v2" — persisted across instances)`,
    );
    const v1Reload = await db2.simpleKVForMiscTbl.getItem("k1");
    assert(
      v1Reload === null,
      `reload getItem("k1"): ${JSON.stringify(v1Reload)} (expected null — was removed before flush)`,
    );

    console.log("DB OK");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Structural equality for the smoke's small value set (objects/strings/null). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`DB FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("DB ERROR", err);
  process.exit(1);
});
