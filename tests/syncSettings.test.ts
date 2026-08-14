import { strict as assert } from "assert";
import type { RemotelySavePluginSettings } from "../src/baseTypes";
import {
  DEFAULT_SYNCED_FIELDS,
  SYNCABLE_FIELDS,
  applySyncedFields,
  projectSyncableFields,
  stripPasswordInPlace,
  toggleFieldInList,
} from "../src/syncSettings";

const baseSettings = (): RemotelySavePluginSettings =>
  ({
    onedrive: { username: "u" } as any,
    password: "secret",
    serviceType: "onedrive",
    ignorePaths: ["myregex"],
    conflictAction: "smart_conflict",
    enableMobileStatusBar: true,
    currLogLevel: "info",
  }) as any;

describe("syncSettings projection", () => {
  it("projects only the selected fields", () => {
    const projected = projectSyncableFields(baseSettings(), [
      "ignorePaths",
      "conflictAction",
    ]);
    assert.deepEqual(projected, {
      ignorePaths: ["myregex"],
      conflictAction: "smart_conflict",
    });
  });

  it("never projects password or onedrive even if mis-selected", () => {
    const projected = projectSyncableFields(baseSettings(), [
      "ignorePaths",
      "password",
      "onedrive",
    ] as any);
    assert.deepEqual(projected, { ignorePaths: ["myregex"] });
  });

  it("applySyncedFields touches only selected fields", () => {
    const local = baseSettings();
    local.ignorePaths = [];
    const partial = {
      ignorePaths: ["syncedregex"],
      conflictAction: "keep_newer",
    } as any;
    const merged = applySyncedFields(local, partial, ["ignorePaths"]);
    assert.deepEqual(merged.ignorePaths, ["syncedregex"]);
    assert.equal(merged.conflictAction, "smart_conflict");
  });

  it("apply then project is idempotent over the default field set", () => {
    const s = baseSettings();
    const partial = projectSyncableFields(s, DEFAULT_SYNCED_FIELDS);
    const merged = applySyncedFields({ ...s }, partial, DEFAULT_SYNCED_FIELDS);
    const reprojected = projectSyncableFields(merged, DEFAULT_SYNCED_FIELDS);
    assert.deepEqual(reprojected, partial);
  });

  it("ignores unknown keys in the downloaded partial", () => {
    const s = baseSettings();
    const partial = {
      ignorePaths: ["x"],
      futureUnknownField: 123,
    } as any;
    const merged = applySyncedFields(s, partial, ["ignorePaths"]);
    assert.deepEqual(merged.ignorePaths, ["x"]);
    assert.equal((merged as any).futureUnknownField, undefined);
  });

  it("stripPasswordInPlace empties only password", () => {
    const s: any = {
      password: "secret",
      ignorePaths: ["x"],
      conflictAction: "smart_conflict",
    };
    stripPasswordInPlace(s);
    assert.equal(s.password, "");
    assert.deepEqual(s.ignorePaths, ["x"]);
    assert.equal(s.conflictAction, "smart_conflict");
  });

  it("SYNCABLE_FIELDS excludes password, onedrive, and device-level fields", () => {
    assert.ok(!SYNCABLE_FIELDS.includes("password" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("onedrive" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("enableMobileStatusBar" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("currLogLevel" as any));
    assert.ok(!SYNCABLE_FIELDS.includes("obfuscateSettingFile" as any));
  });

  it("toggleFieldInList adds when absent, removes when present, no mutation", () => {
    const list = ["a", "b"];
    assert.deepEqual(toggleFieldInList(list, "c"), ["a", "b", "c"]);
    assert.deepEqual(toggleFieldInList(list, "a"), ["b"]);
    assert.deepEqual(list, ["a", "b"]);
  });
});
