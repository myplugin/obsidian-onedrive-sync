// License: Apache-2.0 (see src/LICENSE)

import { strict as assert } from "assert";
import {
  fromDriveItemToEntity,
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
    id: "473340CC2449AD6B!s354ed46c2d9e4b1b87770b08aa0888a8",
    name: "MyVault",
    size: 0,
    folder: {},
    parentReference: {
      driveType: "personal",
      driveId: "473340CC2449AD6B",
      id: "473340CC2449AD6B!sc6a1176cde5a4a7ba20f8f5078b6cc63",
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
});
