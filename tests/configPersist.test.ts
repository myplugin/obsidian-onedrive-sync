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

describe("Config Persist edge cases", () => {
  // The null/undefined guards log via console.debug; keep test output clean.
  const originalDebug = console.debug;
  before(() => {
    console.debug = () => {};
  });
  after(() => {
    console.debug = originalDebug;
  });

  it("messyConfigToNormal should pass null through", () => {
    assert.strictEqual(messyConfigToNormal(null), null);
  });

  it("messyConfigToNormal should pass undefined through", () => {
    assert.strictEqual(messyConfigToNormal(undefined), undefined);
  });

  it("normalConfigToMessy should pass null through", () => {
    assert.strictEqual(normalConfigToMessy(null), null);
  });

  it("normalConfigToMessy should pass undefined through", () => {
    assert.strictEqual(normalConfigToMessy(undefined), undefined);
  });

  it("messyConfigToNormal should return a normal config as-is", () => {
    const plain = { ...DEFAULT_SETTINGS };
    const result = messyConfigToNormal(plain);
    // not decoded/copied: the very same reference is returned
    assert.strictEqual(result, plain);
  });

  it("messyConfigToNormal should return partial messy objects as-is", () => {
    // only one of the two marker fields -> treated as normal config
    const onlyReadme = { readme: "hello" } as any;
    assert.strictEqual(messyConfigToNormal(onlyReadme), onlyReadme);
    const onlyD = { d: "whatever" } as any;
    assert.strictEqual(messyConfigToNormal(onlyD), onlyD);
  });

  it("should round-trip settings containing empty strings", () => {
    const k = {
      ...DEFAULT_SETTINGS,
      password: "",
      onedrive: { username: "" } as any,
      ignorePaths: [] as string[],
    };
    const messy = normalConfigToMessy(k)!;
    assert.ok(messy.readme.length > 0);
    assert.ok(messy.d.length > 0);
    // the obfuscated blob must not leak plain field values
    assert.ok(!messy.d.includes("password"));
    const back = messyConfigToNormal(messy);
    assert.deepEqual(back, k);
    assert.strictEqual((back as any).password, "");
  });

  it("should round-trip an empty settings object", () => {
    const k = {} as RemotelySavePluginSettings;
    const back = messyConfigToNormal(normalConfigToMessy(k));
    assert.deepEqual(back, k);
  });

  it("should throw when the messy config has an empty d field", () => {
    // decodes to "" -> JSON.parse("") is a SyntaxError
    assert.throws(
      () => messyConfigToNormal({ readme: "x", d: "" }),
      SyntaxError
    );
  });

  it("should throw when the messy d field is not valid base64url", () => {
    assert.throws(() =>
      messyConfigToNormal({ readme: "x", d: "!!!not-base64!!!" })
    );
  });
});
