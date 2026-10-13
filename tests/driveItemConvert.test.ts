// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import {
  deriveKeyFromParentChain,
  deriveKeyFromPath,
  fromDriveItemToEntity,
  fromDriveItemToEntityWithChainFallback,
  fromDriveItemToEntityWithIdFallback,
  isApprootRootDriveItem,
} from "../src/driveItemConvert";

const REMOTE_BASE_DIR = "MyVault";
const PARENT_PATH = "/drive/root:/Apps/remotely-save/MyVault";
const MTIME = "2024-01-01T00:00:00Z";
const MTIME_MS = Date.parse(MTIME);

// A normal file living directly under the vault root.
const normalFile = {
  id: "d!123",
  name: "a.md",
  size: 10,
  file: {},
  fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
  parentReference: { path: PARENT_PATH },
};

// ────────────────────────────────────────────────────────────
// isApprootRootDriveItem — detects the vault root folder (the
// remoteBaseDir folder directly under the approot special folder,
// whose parentReference.path is OFFICIALLY OMITTED in delta).
// ────────────────────────────────────────────────────────────
describe("isApprootRootDriveItem", () => {
  // The exact shape from the reported warning (personal OneDrive,
  // special-folder !s IDs, no parentReference.path).
  const approotRootItem = {
    id: "00000000FACE0000!00000000000000000000000000000006",
    name: "MyVault",
    size: 0,
    folder: {},
    parentReference: {
      driveType: "personal",
      driveId: "00000000FACE0000",
      id: "00000000FACE0000!00000000000000000000000000000007",
    },
  };

  it("returns true for the approot root folder (no path, name=remoteBaseDir, folder)", () => {
    assert.ok(
      isApprootRootDriveItem(approotRootItem, REMOTE_BASE_DIR),
      "the vault root folder must be recognized"
    );
  });

  it("returns false for a regular item that HAS a parentReference.path", () => {
    const item = {
      name: "MyVault",
      folder: {},
      parentReference: { path: PARENT_PATH },
    };
    assert.ok(!isApprootRootDriveItem(item, REMOTE_BASE_DIR));
  });

  it("returns false when name !== remoteBaseDir (a sibling, not the root)", () => {
    const item = {
      name: "SomeOtherFolder",
      folder: {},
      parentReference: { driveId: "d", id: "d!s1" },
    };
    assert.ok(!isApprootRootDriveItem(item, REMOTE_BASE_DIR));
  });

  it("returns false for a FILE named like remoteBaseDir (root is a folder)", () => {
    const item = {
      name: "MyVault",
      file: {},
      parentReference: { driveId: "d", id: "d!s1" },
    };
    assert.ok(!isApprootRootDriveItem(item, REMOTE_BASE_DIR));
  });

  it("returns false for empty remoteBaseDir / null item", () => {
    assert.ok(!isApprootRootDriveItem(approotRootItem, ""));
    assert.ok(!isApprootRootDriveItem(null, REMOTE_BASE_DIR));
  });
});

// ────────────────────────────────────────────────────────────
// fromDriveItemToEntity — direct shape tests. These exist because
// the deltaMerge tests MOCK the converter, so the real converter's
// field-presence throws (parentReference.path, mtime, remoteItem,
// package/bundle) were never exercised — which is how the
// parentReference.path-omission bug escaped. These tests pin the
// converter's contract against realistic Graph delta shapes.
// ────────────────────────────────────────────────────────────
describe("fromDriveItemToEntity", () => {
  it("converts a normal file under the vault root", () => {
    const e = fromDriveItemToEntity(normalFile as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.key, "a.md");
    assert.strictEqual(e.keyRaw, "a.md");
    assert.strictEqual(e.size, 10);
    assert.strictEqual(e.sizeRaw, 10);
    assert.strictEqual(e.mtimeSvr, MTIME_MS);
    assert.strictEqual(e.remoteId, "d!123");
  });

  it("captures quickXorHash from file.hashes", () => {
    const item = {
      ...normalFile,
      file: { hashes: { quickXorHash: "AbCd123==" } },
    };
    const e = fromDriveItemToEntity(item as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.hash, "AbCd123==");
  });

  it("hash is undefined when file facet has no hashes", () => {
    // normalFile has file: {} (no hashes key)
    const e = fromDriveItemToEntity(normalFile as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.hash, undefined);
  });

  it("converts a normal folder (key gets a trailing slash)", () => {
    const item = {
      ...normalFile,
      name: "sub",
      folder: {},
      file: undefined,
      size: 0,
    };
    const e = fromDriveItemToEntity(item as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.key, "sub/");
    assert.strictEqual(e.size, 0);
  });

  it("maps the approot root folder (no parentReference.path) to key '/'", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntity(rootItem as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.key, "/");
    assert.strictEqual(e.keyRaw, "/");
  });

  it("throws on a path-less item that is NOT the approot root", () => {
    const item = {
      name: "sibling",
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!s1" }, // no path, wrong name
    };
    assert.throws(
      () => fromDriveItemToEntity(item as any, REMOTE_BASE_DIR),
      /parentReference\.path is undefinded or null/
    );
  });

  it("path-missing throw carries .code = ONEDRIVE_PATH_MISSING (stable id for the fallback catch)", () => {
    // Hardening: the id-fallback catch (fromDriveItemToEntityWithIdFallback)
    // matches on .code, NOT a fragile message-string include — so correcting
    // the historical "undefinded" typo in the message cannot silently break
    // the fallback (re-throw instead of recovering).
    const item = {
      name: "sibling",
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!s1" }, // no path, wrong name
    };
    let caught: any;
    try {
      fromDriveItemToEntity(item as any, REMOTE_BASE_DIR);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected a throw");
    assert.strictEqual(caught.code, "ONEDRIVE_PATH_MISSING");
    assert.match(
      caught.message,
      /parentReference\.path is undefinded or null/,
      "message kept verbatim so existing assert.throws regex tests stay green"
    );
  });

  it("throws on a missing lastModifiedDateTime when requireMtime=true (default)", () => {
    const item = { ...normalFile, fileSystemInfo: {} }; // no lastModifiedDateTime
    assert.throws(
      () => fromDriveItemToEntity(item as any, REMOTE_BASE_DIR),
      /onedrive cannot parse mtime/
    );
  });

  it("does NOT throw on missing mtime when requireMtime=false (deleted-item path)", () => {
    const item = { ...normalFile, fileSystemInfo: {} };
    const e = fromDriveItemToEntity(item as any, REMOTE_BASE_DIR, false);
    assert.strictEqual(e.key, "a.md");
    assert.strictEqual(e.mtimeSvr, undefined);
  });

  it("rejects a remoteItem (shared item) instead of misparsing", () => {
    const item = {
      ...normalFile,
      remoteItem: { id: "otherDrive!1", name: "a.md" },
    };
    assert.throws(
      () => fromDriveItemToEntity(item as any, REMOTE_BASE_DIR),
      /remoteItem.*not supported/
    );
  });

  it("rejects a package item (neither file nor folder)", () => {
    const item = { ...normalFile, package: {}, file: undefined };
    assert.throws(
      () => fromDriveItemToEntity(item as any, REMOTE_BASE_DIR),
      /package\/bundle.*not supported/
    );
  });

  it("rejects a bundle item (neither file nor folder)", () => {
    const item = { ...normalFile, bundle: {}, file: undefined };
    assert.throws(
      () => fromDriveItemToEntity(item as any, REMOTE_BASE_DIR),
      /package\/bundle.*not supported/
    );
  });

  it("maps driveItem.eTag onto Entity.etag", () => {
    // Reuse the file's existing DriveItem construction pattern (normalFile +
    // REMOTE_BASE_DIR), per plan Step 1 prose. The plan's inline fixture used
    // `remotely-save:/vault` (colon) and a full-path remoteBaseDir, which match
    // no known prefix and throw before the return — so etag could never be
    // asserted. Only the construction is corrected; the eTag value and the
    // assertion below are verbatim from the plan.
    const driveItem = {
      ...normalFile,
      eTag: '"012345819293.1"',
    };
    const e = fromDriveItemToEntity(driveItem as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.etag, '"012345819293.1"');
  });

  it("populates remoteId from driveItem.id", () => {
    const e = fromDriveItemToEntity(normalFile as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.remoteId, "d!123");
  });

  it("populates remoteId on the approot root entity too", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntity(rootItem as any, REMOTE_BASE_DIR);
    assert.strictEqual(e.key, "/");
    assert.strictEqual(e.remoteId, "d!s1");
  });
});

describe("fromDriveItemToEntityWithIdFallback", () => {
  // A non-root item with NO parentReference.path (the documented delta shape).
  const pathlessItem = {
    id: "d!999",
    name: "notes/a.md", // name alone can't reconstruct the vault path
    size: 20,
    file: {},
    fileSystemInfo: {
      lastModifiedDateTime: MTIME,
      createdDateTime: MTIME,
    },
    parentReference: { driveId: "d", id: "d!root" }, // no path
  };

  it("reuses the known keyRaw from idToKeyMap when path is missing (modify case)", () => {
    const idToKeyMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    const e = fromDriveItemToEntityWithIdFallback(
      pathlessItem as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "notes/a.md");
    assert.strictEqual(e.keyRaw, "notes/a.md");
    assert.strictEqual(e.size, 20);
    assert.strictEqual(e.remoteId, "d!999");
    assert.strictEqual(e.mtimeSvr, MTIME_MS);
  });

  it("re-throws when path is missing AND id is NOT in the map (new item)", () => {
    const idToKeyMap = new Map<string, string>(); // empty — id not found
    assert.throws(
      () =>
        fromDriveItemToEntityWithIdFallback(
          pathlessItem as any,
          REMOTE_BASE_DIR,
          idToKeyMap
        ),
      /parentReference\.path is undefinded or null/
    );
  });

  it("re-throws when no idToKeyMap is passed at all", () => {
    assert.throws(
      () =>
        fromDriveItemToEntityWithIdFallback(
          pathlessItem as any,
          REMOTE_BASE_DIR
        ),
      /parentReference\.path is undefinded or null/
    );
  });

  it("falls through to normal path-derivation when path IS present (no fallback needed)", () => {
    const withPath = { ...normalFile, id: "d!555", eTag: '"e1"' };
    const idToKeyMap = new Map<string, string>();
    const e = fromDriveItemToEntityWithIdFallback(
      withPath as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "a.md");
    assert.strictEqual(e.etag, '"e1"');
  });

  it("preserves the folder suffix from the reused keyRaw", () => {
    const pathlessFolder = {
      id: "d!folder1",
      name: "x", // irrelevant — key comes from the map
      size: 0,
      folder: {},
      fileSystemInfo: { lastModifiedDateTime: MTIME, createdDateTime: MTIME },
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    // The map's keyRaw already carries the trailing slash from the prior sync.
    const idToKeyMap = new Map<string, string>([["d!folder1", "sub/x/"]]);
    const e = fromDriveItemToEntityWithIdFallback(
      pathlessFolder as any,
      REMOTE_BASE_DIR,
      idToKeyMap
    );
    assert.strictEqual(e.key, "sub/x/");
    assert.strictEqual(e.size, 0); // folder → 0
  });

  it("still maps the approot root to key '/' (bypasses fallback)", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntityWithIdFallback(
      rootItem as any,
      REMOTE_BASE_DIR,
      new Map()
    );
    assert.strictEqual(e.key, "/");
  });
});

// ----------------------------------------------------------------
// deriveKeyFromParentChain - parent-id-chain key derivation for
// path-missing delta items (the documented Graph delta shape:
// "track items by id"). Baseline: parentId === approotRootId (direct
// child of the vault root). Chain: parentId resolved via the injected
// lookup map (prev ids / root anchor / in-batch resolutions).
// PURE: map + root id are parameters; no I/O.
// ----------------------------------------------------------------

// The exact ids from the reported warning data (personal OneDrive,
// new non-root folders with no parentReference.path).
const CHAIN_ROOT_ID = "00000000FACE0000!00000000000000000000000000000001";
const CHAIN_PARENT_ID = "00000000FACE0000!00000000000000000000000000000002";

describe("deriveKeyFromParentChain", () => {
  it("baseline: parent is the approot root + folder -> name + '/'", () => {
    const item = {
      name: "A",
      folder: {},
      parentReference: { driveType: "personal", id: CHAIN_ROOT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      new Map<string, string>(),
      CHAIN_ROOT_ID,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "A/");
  });

  it("baseline: parent is the approot root + file -> name", () => {
    const item = {
      name: "a.md",
      file: {},
      parentReference: { driveType: "personal", id: CHAIN_ROOT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      new Map<string, string>(),
      CHAIN_ROOT_ID,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "a.md");
  });

  it("chain: parent in map (keyRaw 'sub/') + file -> 'sub/name'", () => {
    const lookupMap = new Map<string, string>([[CHAIN_PARENT_ID, "sub/"]]);
    const item = {
      name: "a.md",
      file: {},
      parentReference: { driveType: "personal", id: CHAIN_PARENT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      lookupMap,
      undefined,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "sub/a.md");
  });

  it("chain: parent in map (keyRaw 'sub/') + folder -> 'sub/name/'", () => {
    const lookupMap = new Map<string, string>([[CHAIN_PARENT_ID, "sub/"]]);
    const item = {
      name: "B",
      folder: {},
      parentReference: { driveType: "personal", id: CHAIN_PARENT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      lookupMap,
      undefined,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "sub/B/");
  });

  it("chain: parent keyRaw '/' via map + file -> name (never '//')", () => {
    const lookupMap = new Map<string, string>([[CHAIN_PARENT_ID, "/"]]);
    const item = {
      name: "a.md",
      file: {},
      parentReference: { driveType: "personal", id: CHAIN_PARENT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      lookupMap,
      undefined,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "a.md");
  });

  it("chain: parent keyRaw without trailing slash -> joined with '/'", () => {
    const lookupMap = new Map<string, string>([[CHAIN_PARENT_ID, "sub"]]);
    const item = {
      name: "a.md",
      file: {},
      parentReference: { driveType: "personal", id: CHAIN_PARENT_ID },
    };
    const key = deriveKeyFromParentChain(
      item as any,
      lookupMap,
      undefined,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(key, "sub/a.md");
  });

  it("throws ONEDRIVE_PATH_MISSING when parent is neither root nor in map", () => {
    const item = {
      name: "orphan.md",
      file: {},
      parentReference: { driveType: "personal", id: "UNKNOWN!deadbeef" },
    };
    let caught: any;
    try {
      deriveKeyFromParentChain(
        item as any,
        new Map<string, string>(),
        CHAIN_ROOT_ID,
        REMOTE_BASE_DIR
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected a throw");
    assert.strictEqual(caught.code, "ONEDRIVE_PATH_MISSING");
  });

  it("throws ONEDRIVE_PATH_MISSING when parentReference/id/name is missing", () => {
    const noParent = { name: "a.md", file: {} };
    const noParentId = {
      name: "a.md",
      file: {},
      parentReference: { driveId: "d" },
    };
    const noName = {
      folder: {},
      parentReference: { driveId: "d", id: CHAIN_ROOT_ID },
    };
    for (const item of [noParent, noParentId, noName]) {
      let caught: any;
      try {
        deriveKeyFromParentChain(
          item as any,
          new Map<string, string>(),
          CHAIN_ROOT_ID,
          REMOTE_BASE_DIR
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected a throw");
      assert.strictEqual(caught.code, "ONEDRIVE_PATH_MISSING");
    }
  });
});

// ----------------------------------------------------------------
// fromDriveItemToEntityWithChainFallback - the delta converter with
// the FULL fallback chain for path-missing items:
//   1. own-id lookup (MODIFY case; step-for-step equivalent to
//      fromDriveItemToEntityWithIdFallback)
//   2. parentReference.id chain (NEW items: baseline via the approot
//      root anchor, or via parents known from prev / resolved earlier
//      in the same delta batch)
//   3. otherwise re-throw ONEDRIVE_PATH_MISSING -> skip + self-heal
// Throw order identical to fromDriveItemToEntity (pinned below):
// approot root -> remoteItem/package/bundle -> path-missing -> mtime.
// ----------------------------------------------------------------
describe("fromDriveItemToEntityWithChainFallback", () => {
  it("path present -> main path derivation (same as fromDriveItemToEntity)", () => {
    const withPath = { ...normalFile, id: "d!555", eTag: '"e1"' };
    const e = fromDriveItemToEntityWithChainFallback(
      withPath as any,
      REMOTE_BASE_DIR,
      new Map<string, string>(),
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "a.md");
    assert.strictEqual(e.keyRaw, "a.md");
    assert.strictEqual(e.etag, '"e1"');
    assert.strictEqual(e.remoteId, "d!555");
    assert.strictEqual(e.mtimeSvr, MTIME_MS);
  });

  it("path missing + own-id hit -> reuses keyRaw (modify case)", () => {
    const pathlessModified = {
      id: "d!999",
      name: "x", // irrelevant - key comes from the map
      size: 20,
      file: {},
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    const lookupMap = new Map<string, string>([["d!999", "notes/a.md"]]);
    const e = fromDriveItemToEntityWithChainFallback(
      pathlessModified as any,
      REMOTE_BASE_DIR,
      lookupMap,
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "notes/a.md");
    assert.strictEqual(e.keyRaw, "notes/a.md");
    assert.strictEqual(e.size, 20);
    assert.strictEqual(e.remoteId, "d!999");
    assert.strictEqual(e.mtimeSvr, MTIME_MS);
  });

  it("own-id reuse keeps the folder trailing slash from prev keyRaw", () => {
    const pathlessFolder = {
      id: "d!folder1",
      name: "x",
      size: 0,
      folder: {},
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
      parentReference: { driveId: "d", id: "d!root" }, // no path
    };
    // The map's keyRaw already carries the trailing slash from prev sync.
    const lookupMap = new Map<string, string>([["d!folder1", "sub/x/"]]);
    const e = fromDriveItemToEntityWithChainFallback(
      pathlessFolder as any,
      REMOTE_BASE_DIR,
      lookupMap,
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "sub/x/");
    assert.strictEqual(e.size, 0); // folder -> 0
  });

  it("path missing + own-id miss + parent is approot root -> name + '/'", () => {
    // Warning-data case 1: new non-root folder directly under the vault
    // root, no parentReference.path.
    const folderA = {
      id: CHAIN_PARENT_ID,
      name: "A",
      size: 0,
      folder: {},
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
      parentReference: {
        driveType: "personal",
        driveId: "00000000FACE0000",
        id: CHAIN_ROOT_ID,
      }, // no path
    };
    const e = fromDriveItemToEntityWithChainFallback(
      folderA as any,
      REMOTE_BASE_DIR,
      new Map<string, string>(),
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "A/");
    assert.strictEqual(e.keyRaw, "A/");
    assert.strictEqual(e.size, 0);
    assert.strictEqual(e.remoteId, CHAIN_PARENT_ID);
  });

  it("path missing + own-id miss + parent in map -> chained key", () => {
    // Warning-data case 2: new folder whose parent (folder A) was
    // resolved earlier in the same delta batch.
    const folderB = {
      id: "00000000FACE0000!00000000000000000000000000000003",
      name: "B",
      size: 0,
      folder: {},
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
      parentReference: {
        driveType: "personal",
        driveId: "00000000FACE0000",
        id: CHAIN_PARENT_ID, // parent = folder A
      }, // no path
    };
    const lookupMap = new Map<string, string>([[CHAIN_PARENT_ID, "A/"]]);
    const e = fromDriveItemToEntityWithChainFallback(
      folderB as any,
      REMOTE_BASE_DIR,
      lookupMap,
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "A/B/");
    assert.strictEqual(e.keyRaw, "A/B/");
  });

  it("path missing + all fallbacks miss -> throws ONEDRIVE_PATH_MISSING", () => {
    const orphan = {
      id: "d!X",
      name: "X",
      size: 0,
      folder: {},
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
      parentReference: { driveId: "d", id: "UNKNOWN!deadbeef" },
    };
    let caught: any;
    try {
      fromDriveItemToEntityWithChainFallback(
        orphan as any,
        REMOTE_BASE_DIR,
        new Map<string, string>(),
        CHAIN_ROOT_ID
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected a throw");
    assert.strictEqual(caught.code, "ONEDRIVE_PATH_MISSING");
  });

  it("works without lookupMap/approotRootId (plain path derivation)", () => {
    const e = fromDriveItemToEntityWithChainFallback(
      normalFile as any,
      REMOTE_BASE_DIR
    );
    assert.strictEqual(e.key, "a.md");
    const pathless = {
      id: "d!999",
      name: "x",
      size: 1,
      file: {},
      fileSystemInfo: { lastModifiedDateTime: MTIME },
      parentReference: { driveId: "d", id: "d!root" },
    };
    assert.throws(
      () =>
        fromDriveItemToEntityWithChainFallback(
          pathless as any,
          REMOTE_BASE_DIR
        ),
      /parentReference\.path is undefinded or null/
    );
  });

  // throw order pinned: approot root -> remoteItem/package/bundle ->
  // path-missing -> missing-mtime (same as fromDriveItemToEntity).

  it("maps the approot root to key '/' before any fallback (no mtime needed)", () => {
    const rootItem = {
      id: "d!s1",
      name: REMOTE_BASE_DIR,
      size: 0,
      folder: {},
      parentReference: { driveId: "d", id: "d!sroot" }, // no path
    };
    const e = fromDriveItemToEntityWithChainFallback(
      rootItem as any,
      REMOTE_BASE_DIR,
      new Map<string, string>(),
      CHAIN_ROOT_ID
    );
    assert.strictEqual(e.key, "/");
    assert.strictEqual(e.keyRaw, "/");
    assert.strictEqual(e.remoteId, "d!s1");
  });

  it("throws the remoteItem guard BEFORE path-missing", () => {
    const item = {
      id: "d!r",
      name: "a.md",
      remoteItem: { id: "otherDrive!1", name: "a.md" },
      parentReference: { driveId: "d", id: "UNKNOWN!deadbeef" }, // no path
    };
    assert.throws(
      () =>
        fromDriveItemToEntityWithChainFallback(
          item as any,
          REMOTE_BASE_DIR,
          new Map<string, string>(),
          CHAIN_ROOT_ID
        ),
      /remoteItem.*not supported/
    );
  });

  it("throws the package/bundle guard BEFORE path-missing", () => {
    for (const facet of [{ package: {} }, { bundle: {} }]) {
      const item = {
        id: "d!p",
        name: "pkg",
        ...facet,
        parentReference: { driveId: "d", id: "UNKNOWN!deadbeef" }, // no path
      };
      assert.throws(
        () =>
          fromDriveItemToEntityWithChainFallback(
            item as any,
            REMOTE_BASE_DIR,
            new Map<string, string>(),
            CHAIN_ROOT_ID
          ),
        /package\/bundle.*not supported/
      );
    }
  });

  it("throws path-missing BEFORE missing-mtime when fallbacks miss", () => {
    const item = {
      id: "d!X",
      name: "X",
      size: 0,
      folder: {},
      fileSystemInfo: {}, // no mtime either
      parentReference: { driveId: "d", id: "UNKNOWN!deadbeef" }, // no path
    };
    let caught: any;
    try {
      fromDriveItemToEntityWithChainFallback(
        item as any,
        REMOTE_BASE_DIR,
        new Map<string, string>(),
        CHAIN_ROOT_ID
      );
    } catch (e) {
      caught = e;
    }
    assert.strictEqual(caught.code, "ONEDRIVE_PATH_MISSING");
  });

  it("throws missing-mtime AFTER a successful chain resolution", () => {
    const item = {
      id: "d!A",
      name: "A",
      size: 0,
      folder: {},
      fileSystemInfo: {}, // no mtime
      parentReference: { driveId: "d", id: CHAIN_ROOT_ID }, // no path
    };
    assert.throws(
      () =>
        fromDriveItemToEntityWithChainFallback(
          item as any,
          REMOTE_BASE_DIR,
          new Map<string, string>(),
          CHAIN_ROOT_ID
        ),
      /onedrive cannot parse mtime/
    );
  });
});

describe("deriveKeyFromPath out-of-scope coded error", () => {
  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE for a path matching no known prefix", () => {
    const item = {
      name: "x.md",
      parentReference: { path: "/drive/special/approot" },
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(
        e.code,
        "ONEDRIVE_PATH_OUT_OF_SCOPE",
        "non-vault paths must carry the OUT_OF_SCOPE code"
      );
    }
  });

  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE for a /drive/items/ path not under remoteBaseDir", () => {
    const item = {
      name: "x.md",
      parentReference: { path: "/drive/items/abc!def:/OtherVault/x.md" },
      fileSystemInfo: {
        lastModifiedDateTime: MTIME,
        createdDateTime: MTIME,
      },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });

  it("throws ONEDRIVE_PATH_OUT_OF_SCOPE when a /drive/items/ item has no name", () => {
    const item = {
      name: undefined,
      parentReference: { path: "/drive/items/abc!def:/MyVault/sub" },
    };
    try {
      deriveKeyFromPath(item as any, REMOTE_BASE_DIR);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.strictEqual(e.code, "ONEDRIVE_PATH_OUT_OF_SCOPE");
    }
  });
});
