import { strict as assert } from "assert";

// Simulate the migration logic from main.ts loadSettings()
function migrateSettings(settings: any): any {
  const result = { ...settings };
  if (result.syncConfigDir === true) {
    result.syncObsidianConfig = true;
    result.syncThirdPartyPlugins = true;
    result.syncSelfPlugin = true;
    result.syncConfigDir = false;
  }
  result.syncObsidianConfig ??= true;
  result.syncThirdPartyPlugins ??= true;
  result.syncSelfPlugin ??= true;
  return result;
}

describe("Obsidian sync: backward compat migration", () => {
  it("#41 old syncConfigDir=true migrates to all three on", () => {
    const result = migrateSettings({ syncConfigDir: true });
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
    assert.strictEqual(result.syncConfigDir, false);
  });

  it("#42 old syncConfigDir=false uses new defaults", () => {
    const result = migrateSettings({ syncConfigDir: false });
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
  });

  it("#43 existing new settings preserved", () => {
    const result = migrateSettings({
      syncObsidianConfig: false,
      syncThirdPartyPlugins: false,
      syncSelfPlugin: false,
    });
    assert.strictEqual(result.syncObsidianConfig, false);
    assert.strictEqual(result.syncThirdPartyPlugins, false);
    assert.strictEqual(result.syncSelfPlugin, false);
  });

  it("#44 missing settings get defaults", () => {
    const result = migrateSettings({});
    assert.strictEqual(result.syncObsidianConfig, true);
    assert.strictEqual(result.syncThirdPartyPlugins, true);
    assert.strictEqual(result.syncSelfPlugin, true);
  });
});
