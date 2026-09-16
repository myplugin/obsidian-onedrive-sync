// `_globalsSetup` MUST stay the first import: importing ../src/fsEncrypt
// pulls in ../src/encryptRClone -> ../src/encryptRClone.worker, whose module
// top level touches `self.addEventListener`. The openssl helpers also need
// `window.crypto`.
import "./_globalsSetup";

import { strict as assert } from "assert";

import type { Entity } from "../src/baseTypes";
import {
  MAGIC_ENCRYPTED_PREFIX_BASE32,
  MAGIC_ENCRYPTED_PREFIX_BASE64URL,
  encryptStringToBase32,
  encryptStringToBase64url,
  getSizeFromOrigToEnc as opensslGetSizeFromOrigToEnc,
} from "../src/encryptOpenSSL";
import { getSizeFromOrigToEnc as rcloneGetSizeFromOrigToEnc } from "../src/encryptRClone";
import { FakeFsEncrypt } from "../src/fsEncrypt";

const PASSWORD = "some-strong-password";

const str2ab = (s: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
};

const ab2str = (ab: ArrayBuffer): string => new TextDecoder().decode(ab);

const abEq = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; ++i) {
    if (ua[i] !== ub[i]) {
      return false;
    }
  }
  return true;
};

interface MockCalls {
  writeFile: {
    key: string;
    content: ArrayBuffer;
    mtime: number;
    ctime: number;
  }[];
  mkdir: { key: string; mtime?: number; ctime?: number }[];
  rename: [string, string][];
  rm: string[];
  checkConnect: number;
}

/**
 * A stateful in-memory mock of the inner FakeFs. Keys in `store` are the
 * "remote raw" keys (what FakeFsEncrypt would see from e.g. OneDrive).
 */
const createMockInnerFs = () => {
  const store = new Map<string, { entity: Entity; content: ArrayBuffer }>();
  const calls: MockCalls = {
    writeFile: [],
    mkdir: [],
    rename: [],
    rm: [],
    checkConnect: 0,
  };

  const mock = {
    kind: "mock",
    walk: async (): Promise<Entity[]> =>
      Array.from(store.values()).map((x) => ({ ...x.entity })),
    walkPartial: async (): Promise<Entity[]> =>
      Array.from(store.values()).map((x) => ({ ...x.entity })),
    stat: async (key: string): Promise<Entity> => {
      const x = store.get(key);
      if (x === undefined) {
        throw Error(`mock stat: not found: ${key}`);
      }
      return { ...x.entity };
    },
    writeFile: async (
      key: string,
      content: ArrayBuffer,
      mtime: number,
      ctime: number
    ): Promise<Entity> => {
      calls.writeFile.push({ key, content, mtime, ctime });
      const entity: Entity = {
        key: key,
        keyRaw: key,
        size: content.byteLength,
        sizeRaw: content.byteLength,
        mtimeCli: mtime,
        mtimeSvr: ctime,
      };
      store.set(key, { entity, content });
      return { ...entity };
    },
    readFile: async (key: string): Promise<ArrayBuffer> => {
      const x = store.get(key);
      if (x === undefined) {
        throw Error(`mock readFile: not found: ${key}`);
      }
      return x.content;
    },
    readFileWithStat: async (
      key: string
    ): Promise<{ entity: Entity; content: ArrayBuffer }> => {
      const x = store.get(key);
      if (x === undefined) {
        throw Error(`mock readFileWithStat: not found: ${key}`);
      }
      return { entity: { ...x.entity }, content: x.content };
    },
    rm: async (key: string): Promise<void> => {
      calls.rm.push(key);
      store.delete(key);
    },
    mkdir: async (
      key: string,
      mtime?: number,
      ctime?: number
    ): Promise<Entity> => {
      calls.mkdir.push({ key, mtime, ctime });
      const entity: Entity = {
        key: key,
        keyRaw: key,
        size: 0,
        sizeRaw: 0,
        mtimeCli: mtime,
        mtimeSvr: ctime,
      };
      store.set(key, { entity, content: new ArrayBuffer(0) });
      return { ...entity };
    },
    rename: async (key1: string, key2: string): Promise<void> => {
      calls.rename.push([key1, key2]);
      const x = store.get(key1);
      store.delete(key1);
      if (x !== undefined) {
        store.set(key2, {
          entity: { ...x.entity, key: key2, keyRaw: key2 },
          content: x.content,
        });
      }
    },
    checkConnect: async (): Promise<boolean> => {
      calls.checkConnect += 1;
      return true;
    },
    getUserDisplayName: async (): Promise<string> => "mock-user",
    revokeAuth: async (): Promise<void> => {},
    allowEmptyFile: (): boolean => true,
  };

  /** put an entry directly into the mock "remote" store */
  const seed = (
    keyRaw: string,
    content: ArrayBuffer = new ArrayBuffer(0),
    extra: Partial<Entity> = {}
  ) => {
    const entity: Entity = {
      key: keyRaw,
      keyRaw: keyRaw,
      size: content.byteLength,
      sizeRaw: content.byteLength,
      mtimeCli: 1000,
      mtimeSvr: 2000,
      ...extra,
    };
    store.set(keyRaw, { entity, content });
    return entity;
  };

  return { mock, store, calls, seed };
};

type MockBundle = ReturnType<typeof createMockInnerFs>;

const newEncryptFs = (
  bundle: MockBundle,
  password: string,
  method: "openssl-base64" | "rclone-base64" | "unknown"
) => new FakeFsEncrypt(bundle.mock as any, password, method);

describe("fsEncrypt: FakeFsEncrypt", function () {
  // openssl PBKDF2 key derivation makes some tests a bit slow
  this.timeout(30000);

  describe("constructor / kind", () => {
    it("should show 'no password' in kind when password is empty", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      assert.equal(fs.kind, "encrypt(mock,no password)");
      assert.equal(fs.isPasswordEmpty(), true);
      assert.equal(fs.cipherRClone, undefined);
    });

    it("should show the method in kind when password is set", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      assert.equal(fs.kind, `encrypt(mock,openssl-base64)`);
      assert.equal(fs.isPasswordEmpty(), false);
      // openssl does not need the rclone cipher
      assert.equal(fs.cipherRClone, undefined);
    });

    it("should accept rclone method with empty password (no worker)", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "rclone-base64");
      assert.equal(fs.kind, "encrypt(mock,no password)");
      assert.equal(fs.cipherRClone, undefined);
      assert.equal(fs.isFolderAware(), true);
    });

    it("should treat null/undefined password as empty", () => {
      const b = createMockInnerFs();
      const fs = new FakeFsEncrypt(
        b.mock as any,
        undefined as any,
        "openssl-base64"
      );
      assert.equal(fs.password, "");
      assert.equal(fs.isPasswordEmpty(), true);
      assert.equal(fs.kind, "encrypt(mock,no password)");
    });
  });

  describe("isPasswordEmpty()", () => {
    it("should be true for empty password and false otherwise", () => {
      const b = createMockInnerFs();
      assert.equal(
        newEncryptFs(b, "", "openssl-base64").isPasswordEmpty(),
        true
      );
      assert.equal(
        newEncryptFs(b, "x", "openssl-base64").isPasswordEmpty(),
        false
      );
      assert.equal(
        newEncryptFs(b, " ", "openssl-base64").isPasswordEmpty(),
        false
      );
    });
  });

  describe("isFolderAware()", () => {
    it("should be false for openssl-base64", () => {
      const b = createMockInnerFs();
      assert.equal(
        newEncryptFs(b, "", "openssl-base64").isFolderAware(),
        false
      );
      assert.equal(
        newEncryptFs(b, PASSWORD, "openssl-base64").isFolderAware(),
        false
      );
    });

    it("should be true for rclone-base64", () => {
      const b = createMockInnerFs();
      assert.equal(newEncryptFs(b, "", "rclone-base64").isFolderAware(), true);
      // rclone + password cannot be constructed directly under Node (the
      // worker cannot be spawned), so flip the method on an openssl instance
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      (fs as any).method = "rclone-base64";
      assert.equal(fs.isFolderAware(), true);
    });

    it("should throw for unknown method", () => {
      const b = createMockInnerFs();
      assert.throws(
        () => newEncryptFs(b, PASSWORD, "unknown").isFolderAware(),
        /no idea about isFolderAware/
      );
      assert.throws(
        () => newEncryptFs(b, "", "unknown").isFolderAware(),
        /no idea about isFolderAware/
      );
    });
  });

  describe("_getSizeFromOrigToEnc()", () => {
    it("should return x as-is when password is empty", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      assert.equal(fs._getSizeFromOrigToEnc(0), 0);
      assert.equal(fs._getSizeFromOrigToEnc(100), 100);
      assert.equal(fs._getSizeFromOrigToEnc(65536), 65536);
      // the empty-password shortcut happens before any validation
      assert.equal(fs._getSizeFromOrigToEnc(-5), -5);

      const fsRclone = newEncryptFs(b, "", "rclone-base64");
      assert.equal(fsRclone._getSizeFromOrigToEnc(123), 123);
    });

    it("should follow the openssl formula for openssl-base64", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      // (Math.floor(x / 16) + 1) * 16 + 16
      assert.equal(fs._getSizeFromOrigToEnc(0), 32);
      assert.equal(fs._getSizeFromOrigToEnc(15), 32);
      assert.equal(fs._getSizeFromOrigToEnc(16), 48);
      assert.equal(fs._getSizeFromOrigToEnc(31), 48);
      assert.equal(fs._getSizeFromOrigToEnc(32), 64);
      assert.equal(fs._getSizeFromOrigToEnc(100), 128);
      assert.equal(fs._getSizeFromOrigToEnc(65536), 65568);
      // cross-check with the underlying openssl implementation
      for (const x of [0, 1, 17, 999, 12345, 1048576]) {
        assert.equal(
          fs._getSizeFromOrigToEnc(x),
          opensslGetSizeFromOrigToEnc(x)
        );
      }
    });

    it("should throw for invalid sizes with openssl-base64", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      assert.throws(() => fs._getSizeFromOrigToEnc(-1), /not a valid size/);
      assert.throws(
        () => fs._getSizeFromOrigToEnc(Number.NaN),
        /not a valid size/
      );
      assert.throws(() => fs._getSizeFromOrigToEnc(1.5), /not a valid size/);
    });

    it("should follow the rclone formula for rclone-base64", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      // rclone + password cannot be constructed directly under Node (worker),
      // so flip the method; _getSizeFromOrigToEnc only dispatches to the pure
      // module-level rclone.getSizeFromOrigToEnc (no cipher/workers needed)
      (fs as any).method = "rclone-base64";
      // fileHeader(32) + blocks * (16 + 65536) + residue?(16 + residue)
      assert.equal(fs._getSizeFromOrigToEnc(0), 32);
      assert.equal(fs._getSizeFromOrigToEnc(1), 49);
      assert.equal(fs._getSizeFromOrigToEnc(16), 64);
      assert.equal(fs._getSizeFromOrigToEnc(65535), 65583);
      assert.equal(fs._getSizeFromOrigToEnc(65536), 65584);
      assert.equal(fs._getSizeFromOrigToEnc(65537), 65601);
      assert.equal(fs._getSizeFromOrigToEnc(131072), 131136);
      // cross-check with the underlying rclone implementation
      for (const x of [0, 7, 65535, 65536, 4242424]) {
        assert.equal(
          fs._getSizeFromOrigToEnc(x),
          rcloneGetSizeFromOrigToEnc(x)
        );
      }
    });

    it("should throw for unknown method with password", () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "unknown");
      assert.throws(
        () => fs._getSizeFromOrigToEnc(10),
        /not supported encrypt method=unknown/
      );
    });
  });

  describe("encryptEntity() with empty password (copyEntityAndCopyKeyEncSizeEnc)", () => {
    it("should copy keyRaw to keyEnc and sizeRaw to sizeEnc", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      const input: Entity = {
        key: "a.md",
        keyRaw: "aRaw.md",
        sizeRaw: 123,
        size: 123,
        mtimeCli: 5,
        mtimeSvr: 6,
        etag: "some-etag",
      };
      const inputSnapshot = { ...input };
      const res = await fs.encryptEntity(input);
      // input itself is not mutated; res is a new object
      assert.notEqual(res, input);
      assert.deepStrictEqual(input, inputSnapshot);
      assert.equal(res.keyEnc, "aRaw.md");
      assert.equal(res.sizeEnc, 123);
      // everything else copied over
      assert.equal(res.key, "a.md");
      assert.equal(res.keyRaw, "aRaw.md");
      assert.equal(res.size, 123);
      assert.equal(res.sizeRaw, 123);
      assert.equal(res.mtimeCli, 5);
      assert.equal(res.mtimeSvr, 6);
      assert.equal(res.etag, "some-etag");
    });

    it("should also apply the copy transform in walk/stat/readFileWithStat", async () => {
      const b = createMockInnerFs();
      b.seed("a.md", str2ab("hello"), { mtimeCli: 11, mtimeSvr: 22 });
      b.seed("dir/", new ArrayBuffer(0), { size: 0, sizeRaw: 0 });
      const fs = newEncryptFs(b, "", "openssl-base64");

      const walked = await fs.walk();
      assert.equal(walked.length, 2);
      for (const w of walked) {
        assert.equal(w.keyEnc, w.keyRaw);
        assert.equal(w.sizeEnc, w.sizeRaw);
      }
      assert.equal(walked[0].mtimeCli, 11);
      assert.deepStrictEqual(fs.cacheMapOrigToEnc, {
        "a.md": "a.md",
        "dir/": "dir/",
      });
      assert.equal(fs.hasCacheMap, true);

      const st = await fs.stat("a.md");
      assert.equal(st.key, "a.md");
      assert.equal(st.keyEnc, "a.md");
      assert.equal(st.sizeEnc, st.sizeRaw);

      const rs = await fs.readFileWithStat("a.md");
      assert.equal(rs.entity.keyEnc, "a.md");
      assert.equal(rs.entity.sizeEnc, rs.entity.sizeRaw);
      assert.equal(ab2str(rs.content), "hello");
    });

    it("should throw if input.key is undefined", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      await assert.rejects(
        fs.encryptEntity({ keyRaw: "x.md", sizeRaw: 0 } as Entity),
        /abnormal without key/
      );
    });
  });

  describe("encryptEntity() with password (openssl-base64)", () => {
    it("should fill sizeEnc from size and generate keyEnc", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const input: Entity = {
        key: "a.md",
        keyRaw: "a.md",
        sizeRaw: 100,
        size: 100,
        mtimeCli: 7,
      };
      const inputSnapshot = { ...input };
      const res = await fs.encryptEntity(input);
      // input is not mutated
      assert.deepStrictEqual(input, inputSnapshot);
      assert.equal(res.sizeEnc, 128); // openssl formula for 100
      assert.ok(res.keyEnc !== undefined);
      assert.ok(
        (res.keyEnc as string).startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
      );
      assert.notEqual(res.keyEnc, "a.md");
      // written back into the cache
      assert.equal(fs.cacheMapOrigToEnc["a.md"], res.keyEnc);
    });

    it("should reuse the cached keyEnc for the same key", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      fs.cacheMapOrigToEnc["b.md"] = "cachedEncName";
      const res = await fs.encryptEntity({
        key: "b.md",
        keyRaw: "b.md",
        sizeRaw: 3,
        size: 3,
      });
      assert.equal(res.keyEnc, "cachedEncName");
      assert.equal(res.sizeEnc, 32); // (floor(3/16)+1)*16+16
      assert.equal(fs.cacheMapOrigToEnc["b.md"], "cachedEncName");
    });

    it("should ignore a cached keyEnc equal to the raw key or empty", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      // cached value equal to key -> must be ignored, new encrypted name
      fs.cacheMapOrigToEnc["c.md"] = "c.md";
      const res1 = await fs.encryptEntity({
        key: "c.md",
        keyRaw: "c.md",
        sizeRaw: 1,
        size: 1,
      });
      assert.notEqual(res1.keyEnc, "c.md");
      assert.ok(
        (res1.keyEnc as string).startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
      );
      assert.equal(fs.cacheMapOrigToEnc["c.md"], res1.keyEnc);

      // cached empty value -> must be ignored too
      fs.cacheMapOrigToEnc["d.md"] = "";
      const res2 = await fs.encryptEntity({
        key: "d.md",
        keyRaw: "d.md",
        sizeRaw: 1,
        size: 1,
      });
      assert.ok(
        (res2.keyEnc as string).startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
      );
      assert.equal(fs.cacheMapOrigToEnc["d.md"], res2.keyEnc);
    });

    it("should keep pre-set keyEnc and sizeEnc untouched", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const res = await fs.encryptEntity({
        key: "e.md",
        keyRaw: "e.md",
        sizeRaw: 10,
        size: 10,
        keyEnc: "presetEnc",
        sizeEnc: 999,
      });
      assert.equal(res.keyEnc, "presetEnc");
      assert.equal(res.sizeEnc, 999);
      // cache is not polluted when keyEnc was preset
      assert.equal(fs.cacheMapOrigToEnc["e.md"], undefined);
    });

    it("should leave sizeEnc undefined when size is undefined (prevSync)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const res = await fs.encryptEntity({
        key: "f.md",
        keyRaw: "f.md",
        sizeRaw: 1,
        // size undefined, like a "prevSync" entity
      });
      assert.equal(res.sizeEnc, undefined);
      assert.ok(
        (res.keyEnc as string).startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
      );
    });

    it("should encrypt folder keys (trailing slash) too", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const res = await fs.encryptEntity({
        key: "some folder/",
        keyRaw: "some folder/",
        sizeRaw: 0,
        size: 0,
      });
      assert.notEqual(res.keyEnc, "some folder/");
      assert.equal(await fs._decryptName(res.keyEnc as string), "some folder/");
      assert.equal(res.sizeEnc, 32);
    });

    it("should throw if input.key is undefined", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await assert.rejects(
        fs.encryptEntity({ keyRaw: "x", sizeRaw: 0, keyEnc: "y" } as Entity),
        /abnormal without key/
      );
    });
  });

  describe("walk() / walkPartial() with password", () => {
    it("should decrypt names and transform entities", async () => {
      const b = createMockInnerFs();
      const encFile = await encryptStringToBase64url("a.md", PASSWORD);
      const encFolder = await encryptStringToBase64url("folder/", PASSWORD);
      b.seed(encFile, str2ab("x".repeat(50)), { sizeRaw: 50 });
      b.seed(encFolder, new ArrayBuffer(0), {
        size: 0,
        sizeRaw: 0,
        synthesizedFolder: true,
      });
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");

      const walked = await fs.walk();
      assert.equal(walked.length, 2);

      const file = walked[0];
      assert.equal(file.key, "a.md");
      assert.equal(file.keyRaw, encFile);
      assert.equal(file.keyEnc, encFile); // innerEntity.key
      assert.equal(file.sizeEnc, 50); // innerEntity.size
      assert.equal(file.sizeRaw, 50);
      assert.equal(file.size, undefined); // not a folder
      assert.equal(file.hash, undefined);
      assert.equal(file.mtimeCli, 1000);
      assert.equal(file.mtimeSvr, 2000);

      const folder = walked[1];
      assert.equal(folder.key, "folder/");
      assert.equal(folder.size, 0); // folders get size 0
      assert.equal(folder.synthesizedFolder, true);

      assert.deepStrictEqual(fs.cacheMapOrigToEnc, {
        "a.md": encFile,
        "folder/": encFolder,
      });
      assert.equal(fs.hasCacheMap, true);
    });

    it("should skip special folder names", async () => {
      const b = createMockInnerFs();
      const encFile = await encryptStringToBase64url("keep.md", PASSWORD);
      b.seed(encFile, str2ab("data"));
      // these are skipped before decryption, so raw names are fine
      b.seed("node_modules/");
      b.seed(".git");
      b.seed("sub/.DS_Store");
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");

      const walked = await fs.walkPartial();
      assert.equal(walked.length, 1);
      assert.equal(walked[0].key, "keep.md");
      assert.deepStrictEqual(Object.keys(fs.cacheMapOrigToEnc), ["keep.md"]);
    });
  });

  describe("cacheMap guard errors", () => {
    it("should reject mutating/reading ops before walk()", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await assert.rejects(fs.stat("a.md"), /cacheMap firstly/);
      await assert.rejects(fs.readFile("a.md"), /cacheMap firstly/);
      await assert.rejects(fs.readFileWithStat("a.md"), /cacheMap firstly/);
      await assert.rejects(
        fs.writeFile("a.md", new ArrayBuffer(0), 1, 2),
        /cacheMap firstly/
      );
      await assert.rejects(fs.mkdir("dir/"), /cacheMap firstly/);
      await assert.rejects(fs.rename("a", "b"), /cacheMap firstly/);
      await assert.rejects(fs.rm("a"), /cacheMap firstly/);
    });

    it("should reject unknown keys for stat/readFile/rm/readFileWithStat", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk(); // build empty cacheMap
      await assert.rejects(fs.stat("nope.md"), /no encrypted key nope\.md/);
      await assert.rejects(
        fs.readFile("nope.md"),
        /no encrypted key nope\.md before! cannot readFile/
      );
      await assert.rejects(fs.rm("nope.md"), /no encrypted key nope\.md/);
      await assert.rejects(
        fs.readFileWithStat("nope.md"),
        /no encrypted key nope\.md before! cannot readFileWithStat/
      );
    });
  });

  describe("stat() with password", () => {
    it("should transform the inner entity", async () => {
      const b = createMockInnerFs();
      const encName = await encryptStringToBase64url("a.md", PASSWORD);
      b.seed(encName, str2ab("0123456789"), { sizeRaw: 10 });
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();

      const st = await fs.stat("a.md");
      assert.equal(st.key, "a.md");
      assert.equal(st.keyRaw, encName);
      assert.equal(st.keyEnc, encName);
      assert.equal(st.sizeEnc, 10);
      assert.equal(st.sizeRaw, 10);
      assert.equal(st.size, undefined);
      assert.equal(st.hash, undefined);
      assert.equal(st.mtimeCli, 1000);
      assert.equal(st.mtimeSvr, 2000);
    });
  });

  describe("writeFile()/readFile()/readFileWithStat() with password", () => {
    it("should encrypt content on write and decrypt on read", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk(); // build cacheMap

      const content = str2ab("hello world, this is secret content");
      const res = await fs.writeFile("note.md", content, 111, 222);

      // the inner fs got an encrypted key and encrypted content
      assert.equal(b.store.size, 1);
      const innerKey = Array.from(b.store.keys())[0];
      assert.ok(innerKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL));
      assert.equal(await fs._decryptName(innerKey), "note.md");
      const inner = b.store.get(innerKey)!;
      assert.ok(!abEq(inner.content, content));
      assert.ok(inner.content.byteLength > content.byteLength);

      // returned entity
      assert.equal(res.key, "note.md");
      assert.equal(res.keyRaw, innerKey);
      assert.equal(res.keyEnc, innerKey);
      assert.equal(res.size, undefined);
      assert.equal(res.sizeEnc, inner.content.byteLength);
      assert.equal(res.mtimeCli, 111);
      assert.equal(res.mtimeSvr, 222);
      assert.equal(res.hash, undefined);

      // readFile round trip
      const back = await fs.readFile("note.md");
      assert.ok(abEq(back, content));
      assert.equal(ab2str(back), "hello world, this is secret content");

      // readFileWithStat round trip
      const rs = await fs.readFileWithStat("note.md");
      assert.equal(rs.entity.key, "note.md");
      assert.equal(rs.entity.keyEnc, innerKey);
      assert.equal(rs.entity.sizeEnc, inner.content.byteLength);
      assert.equal(rs.entity.size, undefined);
      assert.ok(abEq(rs.content, content));
    });

    it("should overwrite an existing file and keep the same keyEnc", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();
      await fs.writeFile("note.md", str2ab("v1"), 1, 1);
      const keyEnc1 = fs.cacheMapOrigToEnc["note.md"];
      const res2 = await fs.writeFile("note.md", str2ab("v2-longer"), 2, 2);
      assert.equal(res2.keyEnc, keyEnc1);
      assert.equal(ab2str(await fs.readFile("note.md")), "v2-longer");
      assert.equal(b.store.size, 1);
    });
  });

  describe("writeFile()/readFile() with empty password", () => {
    it("should pass content through unchanged", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      await fs.walk();
      const content = str2ab("plain text");
      const res = await fs.writeFile("p.md", content, 1, 2);
      assert.equal(res.keyEnc, "p.md");
      assert.equal(res.sizeEnc, res.sizeRaw);
      const inner = b.store.get("p.md")!;
      assert.ok(abEq(inner.content, content));
      const back = await fs.readFile("p.md");
      assert.ok(abEq(back, content));
    });
  });

  describe("mkdir()", () => {
    it("should call inner mkdir when password is empty", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "openssl-base64");
      await fs.walk();
      const res = await fs.mkdir("newdir/", 5, 6);
      assert.equal(b.calls.mkdir.length, 1);
      assert.equal(b.calls.mkdir[0].key, "newdir/");
      assert.equal(res.keyEnc, res.keyRaw); // copy transform
      assert.equal(res.sizeEnc, res.sizeRaw);
      // cached for later
      assert.equal(fs.cacheMapOrigToEnc["newdir/"], "newdir/");
    });

    it("should write an empty placeholder file for openssl (not folder aware)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();
      const res = await fs.mkdir("pdir/", 5, 6);
      assert.equal(b.calls.mkdir.length, 0);
      assert.equal(b.calls.writeFile.length, 1);
      const call = b.calls.writeFile[0];
      assert.equal(call.content.byteLength, 0); // allowEmptyFile() is true
      assert.equal(call.mtime, 5);
      assert.equal(call.ctime, 6);
      assert.ok(call.key.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL));
      assert.equal(await fs._decryptName(call.key), "pdir/");
      assert.equal(res.key, "pdir/");
      assert.equal(res.keyEnc, call.key);
      assert.equal(res.size, 0);
      assert.equal(res.sizeEnc, 0);

      // calling again reuses the cached encrypted name
      await fs.mkdir("pdir/", 7, 8);
      assert.equal(b.calls.writeFile.length, 2);
      assert.equal(b.calls.writeFile[1].key, call.key);
    });

    it("should write a 1-byte placeholder when inner disallows empty files", async () => {
      const b = createMockInnerFs();
      (b.mock as any).allowEmptyFile = () => false;
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();
      const res = await fs.mkdir("qdir/");
      const call = b.calls.writeFile[0];
      assert.equal(call.content.byteLength, 1);
      assert.equal(typeof call.mtime, "number"); // defaulted to Date.now()
      assert.equal(res.size, 0);
    });

    it("should reject keys without trailing slash", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();
      await assert.rejects(fs.mkdir("notafolder"), /should not call mkdir on/);
    });
  });

  describe("rename()", () => {
    it("should translate both keys with password", async () => {
      const b = createMockInnerFs();
      const encA = await encryptStringToBase64url("a.md", PASSWORD);
      b.seed(encA, str2ab("content-a"));
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();

      await fs.rename("a.md", "b.md");
      assert.equal(b.calls.rename.length, 1);
      const [k1, k2] = b.calls.rename[0];
      assert.equal(k1, encA); // reused from cacheMap (keyRaw)
      assert.notEqual(k2, "b.md");
      assert.equal(await fs._decryptName(k2), "b.md");
      assert.equal(fs.cacheMapOrigToEnc["b.md"], k2);
      // content moved in the mock store
      assert.equal(b.store.has(encA), false);
      assert.equal(ab2str(b.store.get(k2)!.content), "content-a");
    });

    it("should pass keys through with empty password", async () => {
      const b = createMockInnerFs();
      b.seed("a.md", str2ab("x"));
      const fs = newEncryptFs(b, "", "openssl-base64");
      await fs.walk();
      await fs.rename("a.md", "z.md");
      assert.deepStrictEqual(b.calls.rename[0], ["a.md", "z.md"]);
    });
  });

  describe("rm()", () => {
    it("should remove using the encrypted key", async () => {
      const b = createMockInnerFs();
      const encA = await encryptStringToBase64url("a.md", PASSWORD);
      b.seed(encA, str2ab("data"));
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await fs.walk();
      await fs.rm("a.md");
      assert.deepStrictEqual(b.calls.rm, [encA]);
      assert.equal(b.store.size, 0);
    });
  });

  describe("isPasswordOk()", () => {
    it("should return empty_remote when the remote has nothing", async () => {
      const b = createMockInnerFs();
      const fsNoPw = newEncryptFs(b, "", "openssl-base64");
      assert.deepStrictEqual(await fsNoPw.isPasswordOk(), {
        ok: true,
        reason: "empty_remote",
      });

      const b2 = createMockInnerFs();
      const fsPw = newEncryptFs(b2, PASSWORD, "openssl-base64");
      assert.deepStrictEqual(await fsPw.isPasswordOk(), {
        ok: true,
        reason: "empty_remote",
      });
    });

    it("should return likely_no_password_both_sides for plain names", async () => {
      const b = createMockInnerFs();
      b.seed("plain.md", str2ab("x"));
      const fs = newEncryptFs(b, "", "openssl-base64");
      assert.deepStrictEqual(await fs.isPasswordOk(), {
        ok: true,
        reason: "likely_no_password_both_sides",
      });
    });

    it("should detect encrypted remote with no local password", async () => {
      const b = createMockInnerFs();
      b.seed(`${MAGIC_ENCRYPTED_PREFIX_BASE64URL}1_fakefake`, str2ab("x"));
      const fs = newEncryptFs(b, "", "openssl-base64");
      assert.deepStrictEqual(await fs.isPasswordOk(), {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      });

      // base32 magic prefix is also recognized
      const b2 = createMockInnerFs();
      b2.seed(`${MAGIC_ENCRYPTED_PREFIX_BASE32}fakefake`, str2ab("x"));
      const fs2 = newEncryptFs(b2, "", "openssl-base64");
      assert.deepStrictEqual(await fs2.isPasswordOk(), {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      });
    });

    it("should return password_matched for correct password", async () => {
      const b = createMockInnerFs();
      const encName = await encryptStringToBase64url("a.md", PASSWORD);
      b.seed(encName, str2ab("x"));
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      assert.deepStrictEqual(await fs.isPasswordOk(), {
        ok: true,
        reason: "password_matched",
      });
    });
  });

  describe("_encryptName() / _decryptName()", () => {
    it("should be identity when password is empty", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "rclone-base64");
      assert.equal(await fs._encryptName("some name.md"), "some name.md");
      assert.equal(await fs._decryptName("some name.md"), "some name.md");
    });

    it("should round-trip base64url names (openssl)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const name = "folder with space/文件.md";
      const enc = await fs._encryptName(name);
      assert.ok(enc.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL));
      assert.equal(await fs._decryptName(enc), name);
      // two encryptions of the same name differ (random salt)
      const enc2 = await fs._encryptName(name);
      assert.notEqual(enc, enc2);
      assert.equal(await fs._decryptName(enc2), name);
    });

    it("should decrypt legacy base32 names (openssl)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const legacy = await encryptStringToBase32("old name.md", PASSWORD);
      assert.ok(legacy.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32));
      assert.equal(await fs._decryptName(legacy), "old name.md");
    });

    it("should reject plain names and wrong passwords (openssl)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      await assert.rejects(fs._decryptName("plain.md"), /likely mismatch/);

      const encOther = await encryptStringToBase64url(
        "a.md",
        "a-different-password"
      );
      await assert.rejects(fs._decryptName(encOther), /cannot decrypt name/);
    });

    it("should throw for unknown method with password", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "unknown");
      await assert.rejects(
        fs._encryptName("a.md"),
        /not supported encrypt method=unknown/
      );
      await assert.rejects(
        fs._decryptName("a.md"),
        /not supported decrypt method=unknown/
      );
    });
  });

  describe("_encryptContent() / _decryptContent()", () => {
    it("should be identity when password is empty", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, "", "rclone-base64");
      const content = str2ab("abc");
      assert.equal(await fs._encryptContent(content), content);
      assert.equal(await fs._decryptContent(content), content);
    });

    it("should round-trip content (openssl)", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      const content = str2ab("the quick brown fox jumps over the lazy dog");
      const enc = await fs._encryptContent(content);
      assert.ok(!abEq(enc, content));
      const dec = await fs._decryptContent(enc);
      assert.ok(abEq(dec, content));
      assert.equal(ab2str(dec), ab2str(content));
    });

    it("should fail decrypting with a wrong password", async () => {
      const b = createMockInnerFs();
      const fs1 = newEncryptFs(b, PASSWORD, "openssl-base64");
      const enc = await fs1._encryptContent(str2ab("secret"));
      const b2 = createMockInnerFs();
      const fs2 = newEncryptFs(b2, "wrong-password", "openssl-base64");
      await assert.rejects(fs2._decryptContent(enc));
    });

    it("should throw for unknown method with password", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "unknown");
      await assert.rejects(
        fs._encryptContent(new ArrayBuffer(0)),
        /not supported encrypt method=unknown/
      );
      await assert.rejects(
        fs._decryptContent(new ArrayBuffer(0)),
        /not supported decrypt method=unknown/
      );
    });
  });

  describe("delegation and misc", () => {
    it("should delegate checkConnect/getUserDisplayName/revokeAuth", async () => {
      const b = createMockInnerFs();
      const fs = newEncryptFs(b, PASSWORD, "openssl-base64");
      assert.equal(await fs.checkConnect(), true);
      assert.equal(b.calls.checkConnect, 1);
      assert.equal(await fs.getUserDisplayName(), "mock-user");
      assert.equal(await fs.revokeAuth(), undefined);
    });

    it("should always allow empty files", () => {
      const b = createMockInnerFs();
      assert.equal(
        newEncryptFs(b, "", "openssl-base64").allowEmptyFile(),
        true
      );
      assert.equal(
        newEncryptFs(b, PASSWORD, "openssl-base64").allowEmptyFile(),
        true
      );
    });

    it("closeResources() should be a safe no-op without rclone cipher", async () => {
      const b = createMockInnerFs();
      await newEncryptFs(b, PASSWORD, "openssl-base64").closeResources();
      const fsRclone = newEncryptFs(b, PASSWORD, "openssl-base64");
      (fsRclone as any).method = "rclone-base64";
      // cipherRClone is undefined, the guard must skip it
      await fsRclone.closeResources();
      await newEncryptFs(b, "", "rclone-base64").closeResources();
    });
  });
});
