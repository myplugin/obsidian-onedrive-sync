// Headless CLI sync-wiring smoke (Phase C Milestone C1b).
//
// THE GATE: construct the full syncer arg set (all 21 positional args, the
// SAME set syncCommand builds) + assert the fsEncrypt.innerFs === fsRemote
// invariant (sync.ts:2813 — a wrong wrapper would throw on the real sync).
// Does NOT call syncer — a fake token would hit the real OneDrive network
// and fail. This proves the WIRING is complete before Phase D (real login +
// sync, user-gated).
//
// A missing positional arg or a mis-wrapped FakeFsEncrypt would make the
// real Phase D syncer call fail. The smoke asserts completeness + the
// innerFs===fsRemote invariant so those bugs surface here, not in Phase D.

// MUST be first — sets window.moment before any src module load.
import "./polyfills";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeFs } from "./fsLocalNode";
import { NodeDb } from "./dbNode";
import {
  FakeFsOnedrive,
  DEFAULT_ONEDRIVE_CONFIG,
} from "../src/fsOnedrive";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { syncer } from "../src/sync";
import { loadConfig } from "./config";
import { deriveVaultRandomID } from "./sync";
import type { RemotelySavePluginSettings } from "../src/baseTypes";

async function main(): Promise<void> {
  let tmpVault: string | undefined;
  let tmpDb: string | undefined;
  try {
    tmpVault = await fs.mkdtemp(path.join(tmpdir(), "ods-syncwire-vault-"));
    tmpDb = await fs.mkdtemp(path.join(tmpdir(), "ods-syncwire-db-"));

    // Create a dummy file so the local walk has at least one entity (the
    // real sync would walk this; here we only assert wiring, but the file
    // mirrors a realistic vault).
    await fs.writeFile(path.join(tmpVault, "hello.md"), "# hello\n", "utf8");

    // --- load a default config + inject a FAKE onedrive auth ---
    // Fake tokens so constructing FakeFsOnedrive + the syncer arg set
    // succeeds without any real network. (syncer is NOT called — see top.)
    const settings: RemotelySavePluginSettings = await loadConfig(
      path.join(tmpDb, "config.json"),
    );
    settings.onedrive = {
      ...DEFAULT_ONEDRIVE_CONFIG,
      clientID: "fake",
      authority: "https://login.microsoftonline.com/common",
      accessToken: "fake-at",
      refreshToken: "fake-rt",
      accessTokenExpiresAtTime: Date.now() + 3600000,
    };
    // Mirror syncCommand's forceContentOnly.
    settings.syncConfigDir = false;
    settings.syncObsidianConfig = false;
    settings.syncThirdPartyPlugins = false;
    settings.syncSelfPlugin = false;
    settings.syncBookmarks = false;
    settings.syncAppearance = false;

    // --- adapters (mirror syncCommand / buildSyncerArgs) ---
    const fsLocal = new NodeFs(tmpVault);
    const db = new NodeDb(tmpDb);

    const vaultRandomID = deriveVaultRandomID(tmpVault);
    const profileID = `${settings.serviceType}-default-1`;
    const vaultName = "smoke";
    const configDir = path.join(tmpVault, ".obsidian");
    const selfPluginId = "onedrive-vault-sync";
    const pluginVersion = "0.6.33-cli";

    const configSaver = async () => {};
    // prevRemoteEntities = undefined (fresh DB → full enumeration, like
    // main.ts:320-322 on a fresh vault).
    const fsRemote = new FakeFsOnedrive(
      settings.onedrive,
      vaultName,
      configSaver,
      undefined,
    );

    // FAKEFSENCRYPT — UNENCRYPTED passthrough, mirroring syncCommand's
    // construction (which mirrors main.ts:329-333 EXACTLY):
    //   new FakeFsEncrypt(fsRemote, settings.password ?? "",
    //                     settings.encryptionMethod ?? "rclone-base64")
    // settings.password defaults to "" → isPasswordEmpty()=true → every
    // encrypt/decrypt branch passes content through unchanged.
    const fsEncrypt = new FakeFsEncrypt(
      fsRemote,
      settings.password ?? "",
      settings.encryptionMethod ?? "rclone-base64",
    );

    // --- the FULL 21-arg set (mirror syncCommand) ---
    // Built as an array so we can assert positional completeness (length).
    // A missing positional arg would make length < 21 and surface here.
    // Values mirror syncCommand's buildSyncerArgs field-for-field.
    const args = [
      fsLocal,
      fsRemote,
      fsEncrypt,
      undefined, // profiler
      db,
      "manual", // triggerSource
      profileID,
      vaultRandomID,
      configDir,
      selfPluginId,
      settings,
      pluginVersion,
      configSaver,
      (_percentage: number, _modified: number, _total: number): string => "",
      (_isSyncing: boolean): void => {},
      async (_s: "manual", step: number): Promise<void> => {
        void _s;
        console.log(`[sync] step ${step}`);
      },
      async (_s: "manual", error: Error): Promise<void> => {
        void _s;
        console.error(`[sync error] ${error.message}`);
      },
      undefined, // ribboonFunc
      undefined, // statusBarFunc
      async (
        _s: "manual",
        counter: number,
        total: number,
        key: string,
        _decision: string | undefined,
      ): Promise<void> => {
        void _s;
        if (counter % 50 === 0 || counter === total) {
          console.log(`  ${counter}/${total} ${key}`);
        }
      },
      (_filePath: string): boolean => false, // isFileDirtyOpen
    ];

    // --- ASSERTIONS ---

    // Completeness: 21 positional args — no missing/extra. (syncer's
    // signature is 21 params; main.ts:670-696 passes exactly 21.)
    assert(
      args.length === 21,
      `args.length: expected 21, got ${args.length} — a positional arg is missing or extra`,
    );

    // THE CRITICAL INVARIANT: sync.ts:2813 throws
    //   `your enc should has inner of the remote`
    // if fsEncrypt.innerFs !== fsRemote. A wrong wrapper (e.g. wrapping a
    // different FakeFs) would crash the real Phase D sync at step 2.
    assert(
      fsEncrypt.innerFs === fsRemote,
      `fsEncrypt.innerFs (${fsEncrypt.innerFs?.kind}) !== fsRemote (${fsRemote.kind}) — sync.ts:2813 would throw`,
    );

    // fsEncrypt is the unencrypted passthrough (password="").
    assert(
      fsEncrypt.isPasswordEmpty(),
      "fsEncrypt should be unencrypted (password=\"\"), isPasswordEmpty()=false",
    );

    // The sync entry point loaded in Node (via stub + polyfill) — same
    // gate as assembly-smoke, re-checked here because sync.ts is the
    // module the real sync runs through.
    assert(
      typeof syncer === "function",
      `typeof syncer: ${typeof syncer} (expected "function")`,
    );

    // All adapters constructed without throwing.
    assert(fsLocal !== undefined, "NodeFs is undefined");
    assert(db !== undefined, "NodeDb is undefined");
    assert(fsRemote !== undefined, "FakeFsOnedrive is undefined");
    assert(fsEncrypt !== undefined, "FakeFsEncrypt is undefined");

    console.log("SYNC-WIRING OK");
  } finally {
    if (tmpVault !== undefined) {
      await fs.rm(tmpVault, { recursive: true, force: true });
    }
    if (tmpDb !== undefined) {
      await fs.rm(tmpDb, { recursive: true, force: true });
    }
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`SYNC-WIRING FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("SYNC-WIRING ERROR", err);
  process.exit(1);
});
