// Headless CLI assembly smoke (Phase C Milestone C0).
//
// Proves the full adapter wiring loads in Node: polyfills + NodeFs + NodeDb +
// FakeFsOnedrive + the sync entry point. This is the prerequisite for Phase D
// (a real end-to-end sync under Node): it confirms no module-load or construct
// path throws when the Obsidian runtime is absent.
//
// THE GATE: imports polyfills FIRST (sets window.moment), then calls
// unixTimeToStr(Date.now()) and asserts a non-empty string. If the moment shim
// is wrong, this throws where the real sync would throw — surfacing the bug
// here, not in a Phase D sync run.
//
// DEVIATION FROM CONTRACT: the contract's `import { runSync } from "../src/sync"`
// assumes a `runSync` export. sync.ts has NO `runSync` export (confirmed by
// grep `export` — Rule 1 read). The actual public sync entry is `syncer`
// (src/sync.ts:2738, `export async function syncer(...)`). This smoke imports
// `syncer` and asserts typeof === "function" — same intent (prove the sync
// module loads in Node via stub + polyfill), correct export name.
//
// Exit 0 on `ASSEMBLY OK`, exit 1 on any failure.

// MUST be the FIRST import — side-effect: sets globalThis.window.moment before
// any src module that might call unixTimeToStr at module load or runtime.
import "./polyfills";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { unixTimeToStr } from "../src/misc";
import { NodeFs } from "./fsLocalNode";
import { NodeDb } from "./dbNode";
import {
  FakeFsOnedrive,
  DEFAULT_ONEDRIVE_CONFIG,
} from "../src/fsOnedrive";
import { syncer } from "../src/sync";

async function main(): Promise<void> {
  // --- THE GATE: unixTimeToStr via the window.moment shim ---
  // unixTimeToStr(Date.now()) exercises window.moment(x).format() (the
  // !hasMs branch, misc.ts:358). Also exercise the hasMs branch directly.
  const s = unixTimeToStr(Date.now());
  assert(
    typeof s === "string" && s.length > 0,
    `unixTimeToStr(now): ${JSON.stringify(s)} (expected non-empty string)`,
  );
  const sMs = unixTimeToStr(Date.now(), true);
  assert(
    typeof sMs === "string" && sMs.length > 0,
    `unixTimeToStr(now, hasMs=true): ${JSON.stringify(sMs)} (expected non-empty string)`,
  );

  let tmp: string | undefined;
  try {
    // --- construct the full adapter wiring (no network — _init is lazy) ---
    tmp = await fs.mkdtemp(path.join(tmpdir(), "ods-asm-"));

    const local = new NodeFs(tmp);
    assert(local !== undefined, "new NodeFs(tmp) returned undefined");

    const db = new NodeDb(tmp);
    assert(db !== undefined, "new NodeDb(tmp) returned undefined");

    const fakeConfig = {
      ...DEFAULT_ONEDRIVE_CONFIG,
      clientID: "fake-cli-smoke",
      authority: "https://login.microsoftonline.com/common",
    };
    // FakeFsOnedrive constructor (fsOnedrive.ts:742):
    //   (onedriveConfig, vaultName, saveUpdatedConfigFunc, prevRemoteEntities?)
    // _init is lazy — constructing does NOT touch the network.
    const remote = new FakeFsOnedrive(
      fakeConfig,
      "smoke-vault",
      async () => {},
      undefined,
    );
    assert(remote !== undefined, "new FakeFsOnedrive(...) returned undefined");

    // --- prove the sync entry point loaded in Node (via stub + polyfill) ---
    // Contract said `runSync`; actual export is `syncer` (see deviation note).
    assert(
      typeof syncer === "function",
      `typeof syncer: ${typeof syncer} (expected "function")`,
    );

    console.log("ASSEMBLY OK");
  } finally {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`ASSEMBLY FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("ASSEMBLY ERROR", err);
  process.exit(1);
});
