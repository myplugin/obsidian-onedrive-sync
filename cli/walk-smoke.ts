// Headless CLI walk smoke (Phase B Milestone 2).
//
// Proves NodeFs walks a real on-disk vault directory and produces Entity[]
// matching the fsLocal contract: folder keys end with "/", file keys don't,
// sizes match `fs.stat`, and the nested-folder structure is fully enumerated.
//
// Layout created in a temp dir:
//   <temp>/a.txt            (root file)
//   <temp>/b.txt            (root file)
//   <temp>/sub/             (root folder  -> key "sub/")
//   <temp>/sub/nested.txt   (nested file  -> key "sub/nested.txt")
// Expected entity count = 4 (2 root files + 1 folder + 1 nested file).

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFs } from "./fsLocalNode";

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "nodefs-walk-"));
  try {
    // --- create the layout ---
    await fs.writeFile(path.join(tempDir, "a.txt"), "aaa");
    await fs.writeFile(path.join(tempDir, "b.txt"), "bbbbb");
    await fs.mkdir(path.join(tempDir, "sub"));
    await fs.writeFile(path.join(tempDir, "sub", "nested.txt"), "nested!");

    // --- walk ---
    const nodeFs = new NodeFs(tempDir);
    const ents = await nodeFs.walk();

    // --- assertions ---
    // 4 entities: a.txt, b.txt, sub/, sub/nested.txt
    assert(ents.length === 4, `entity count: ${ents.length} (expected 4)`);

    const byKey = new Map(ents.map((e) => [e.keyRaw, e]));

    // a.txt
    const a = byKey.get("a.txt");
    assert(a !== undefined, "a.txt missing");
    assert(!a!.keyRaw.endsWith("/"), `a.txt key should not end with /: ${a!.keyRaw}`);
    const aStat = await fs.stat(path.join(tempDir, "a.txt"));
    assert(a!.size === aStat.size, `a.txt size: ${a!.size} vs ${aStat.size}`);
    assert(a!.sizeRaw === aStat.size, `a.txt sizeRaw: ${a!.sizeRaw} vs ${aStat.size}`);
    assert(typeof a!.mtimeCli === "number" && a!.mtimeCli! > 0, `a.txt mtimeCli: ${a!.mtimeCli}`);

    // b.txt
    const b = byKey.get("b.txt");
    assert(b !== undefined, "b.txt missing");
    assert(!b!.keyRaw.endsWith("/"), `b.txt key should not end with /: ${b!.keyRaw}`);
    const bStat = await fs.stat(path.join(tempDir, "b.txt"));
    assert(b!.size === bStat.size, `b.txt size: ${b!.size} vs ${bStat.size}`);

    // sub/ (folder — trailing slash)
    const sub = byKey.get("sub/");
    assert(sub !== undefined, `sub/ missing`);
    assert(sub!.keyRaw.endsWith("/"), `sub/ key should end with /: ${sub!.keyRaw}`);
    assert(sub!.size === 0, `sub/ size: ${sub!.size} (expected 0)`);
    assert(sub!.sizeRaw === 0, `sub/ sizeRaw: ${sub!.sizeRaw} (expected 0)`);

    // sub/nested.txt (nested file — proves recursion + forward-slash key)
    const nested = byKey.get("sub/nested.txt");
    assert(nested !== undefined, "sub/nested.txt missing");
    assert(
      !nested!.keyRaw.endsWith("/"),
      `nested key should not end with /: ${nested!.keyRaw}`,
    );
    const nStat = await fs.stat(path.join(tempDir, "sub", "nested.txt"));
    assert(nested!.size === nStat.size, `nested size: ${nested!.size} vs ${nStat.size}`);

    // Every entity has the fsLocal.walk field set (shape check beyond the
    // asserted fields): keyRaw, size, sizeRaw; files have mtimeCli+mtimeSvr.
    for (const e of ents) {
      assert(typeof e.keyRaw === "string" && e.keyRaw.length > 0, `bad keyRaw: ${e.keyRaw}`);
      assert(typeof e.size === "number", `bad size on ${e.keyRaw}`);
      assert(typeof e.sizeRaw === "number", `bad sizeRaw on ${e.keyRaw}`);
      if (!e.keyRaw.endsWith("/")) {
        assert(typeof e.mtimeCli === "number", `missing mtimeCli on ${e.keyRaw}`);
        assert(typeof e.mtimeSvr === "number", `missing mtimeSvr on ${e.keyRaw}`);
      }
    }

    console.log("WALK OK");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`WALK FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("WALK ERROR", err);
  process.exit(1);
});
