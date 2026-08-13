import { strict as assert } from "assert";

import type { RemotelySavePluginSettings } from "../src/baseTypes";
import { messyConfigToNormal, normalConfigToMessy } from "../src/configPersist";
import { stripPasswordInPlace } from "../src/syncSettings";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  onedrive: {
    username: "test 🍎 emoji",
  } as any,
  password: "password",
  serviceType: "onedrive",
  currLogLevel: "info",
  ignorePaths: ["somefoldertoignore"],
  enableStatusBarInfo: true,
};

describe("Config Persist tests", () => {
  it("should encrypt go back and forth conrrectly", async () => {
    const k = DEFAULT_SETTINGS;
    const k2 = normalConfigToMessy(k);
    const k3 = messyConfigToNormal(k2);
    assert.deepEqual(k3, k);
  });

  it("obfuscated data.json carries no password after stripPasswordInPlace", () => {
    const k = { ...DEFAULT_SETTINGS, password: "supersecret" };
    stripPasswordInPlace(k as any);
    const messy = normalConfigToMessy(k);
    const blob = JSON.stringify(messy);
    assert.ok(
      !blob.includes("supersecret"),
      "password leaked into the obfuscated data.json blob"
    );
    assert.equal((messyConfigToNormal(messy) as any).password, "");
  });
});
