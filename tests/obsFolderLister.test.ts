import { strict as assert } from "assert";
import { listFilesInObsFolder } from "../src/obsFolderLister";

const CF = ".obsidian";
const PID = "onedrive-vault-sync";

// Manual mock vault (no sinon in devDependencies):
// - adapter.stat(path) -> { type, ctime, mtime, size } or null
// - adapter.list(path) -> { files, folders } with full vault paths
// statFix (src/misc.ts) consumes adapter.stat; files need non-zero mtime.
function mockVault(filePaths: string[], folderPaths: string[]): any {
  const fileSet = new Set(filePaths);
  const folderSet = new Set(folderPaths);
  const MTIME = 1700000000000;
  return {
    adapter: {
      stat: async (path: string) => {
        if (folderSet.has(path)) {
          return { type: "folder", ctime: MTIME, mtime: MTIME, size: 0 };
        }
        if (fileSet.has(path)) {
          return { type: "file", ctime: MTIME, mtime: MTIME, size: 100 };
        }
        return null;
      },
      list: async (path: string) => {
        const prefix = `${path}/`;
        const directChildren = (p: string) =>
          p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
        return {
          files: filePaths.filter(directChildren),
          folders: folderPaths.filter(directChildren),
        };
      },
    },
  };
}

interface Toggles {
  syncObsidianConfig?: boolean;
  syncAppearance?: boolean;
  syncBookmarks?: boolean;
  syncThirdPartyPlugins?: boolean;
  syncSelfPlugin?: boolean;
}

async function listAll(
  files: string[],
  folders: string[],
  toggles: Toggles
): Promise<string[]> {
  const entities = await listFilesInObsFolder(
    CF,
    mockVault(files, folders),
    PID,
    toggles.syncObsidianConfig ?? false,
    toggles.syncAppearance ?? false,
    toggles.syncBookmarks ?? false,
    toggles.syncThirdPartyPlugins ?? false,
    toggles.syncSelfPlugin ?? false
  );
  return entities.map((e) => e.key!).sort();
}

// File entries only (folder keys always end with "/")
async function listFileKeys(
  files: string[],
  folders: string[],
  toggles: Toggles
): Promise<string[]> {
  const keys = await listAll(files, folders, toggles);
  return keys.filter((k) => !k.endsWith("/"));
}

describe("obsFolderLister: five-toggle selective listing", () => {
  it("#33 only self plugin synced (data.json excluded)", async () => {
    const folders = [CF, `${CF}/plugins`, `${CF}/plugins/${PID}`];
    const files = [
      `${CF}/plugins/${PID}/main.js`,
      `${CF}/plugins/${PID}/manifest.json`,
      `${CF}/plugins/${PID}/data.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncSelfPlugin: true,
    });
    assert.deepStrictEqual(keys, [
      `${CF}/plugins/${PID}/main.js`,
      `${CF}/plugins/${PID}/manifest.json`,
    ]);
    // folder entries: config root, plugins/, self plugin dir
    const all = await listAll(files, folders, { syncSelfPlugin: true });
    assert.deepStrictEqual(
      all.filter((k) => k.endsWith("/")),
      [`${CF}/`, `${CF}/plugins/`, `${CF}/plugins/${PID}/`]
    );
  });

  it("#34 only third-party plugins synced (incl. their data.json)", async () => {
    const folders = [CF, `${CF}/plugins`, `${CF}/plugins/dataview`];
    const files = [
      `${CF}/plugins/dataview/main.js`,
      `${CF}/plugins/dataview/data.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncThirdPartyPlugins: true,
    });
    assert.deepStrictEqual(keys, [
      `${CF}/plugins/dataview/data.json`,
      `${CF}/plugins/dataview/main.js`,
    ]);
  });

  it("#35 only core config synced (workspace/appearance/bookmarks excluded)", async () => {
    const folders = [CF];
    const files = [
      `${CF}/app.json`,
      `${CF}/workspace.json`,
      `${CF}/appearance.json`,
      `${CF}/bookmarks.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncObsidianConfig: true,
    });
    assert.deepStrictEqual(keys, [`${CF}/app.json`]);
  });

  it("#36 core config + appearance", async () => {
    const folders = [CF];
    const files = [
      `${CF}/app.json`,
      `${CF}/workspace.json`,
      `${CF}/appearance.json`,
      `${CF}/bookmarks.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncObsidianConfig: true,
      syncAppearance: true,
    });
    assert.deepStrictEqual(keys, [`${CF}/app.json`, `${CF}/appearance.json`]);
  });

  it("#37 all toggles off -> empty list", async () => {
    const folders = [CF];
    const files = [
      `${CF}/app.json`,
      `${CF}/workspace.json`,
      `${CF}/appearance.json`,
      `${CF}/bookmarks.json`,
    ];
    const all = await listAll(files, folders, {});
    assert.deepStrictEqual(all, []);
  });

  it("#38 blacklist excludes workspace-mobile.json and workspaces.json", async () => {
    const folders = [CF];
    const files = [
      `${CF}/workspace-mobile.json`,
      `${CF}/workspaces.json`,
      `${CF}/app.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncObsidianConfig: true,
    });
    assert.deepStrictEqual(keys, [`${CF}/app.json`]);
  });

  it("#39 snippets and themes synced with core config", async () => {
    const folders = [CF, `${CF}/snippets`, `${CF}/themes`, `${CF}/themes/PLN`];
    const files = [`${CF}/snippets/h1.css`, `${CF}/themes/PLN/theme.css`];
    const keys = await listFileKeys(files, folders, {
      syncObsidianConfig: true,
    });
    assert.deepStrictEqual(keys, [
      `${CF}/snippets/h1.css`,
      `${CF}/themes/PLN/theme.css`,
    ]);
  });

  it("#40 self plugin dir filters unknown files", async () => {
    const folders = [CF, `${CF}/plugins`, `${CF}/plugins/${PID}`];
    const files = [
      `${CF}/plugins/${PID}/main.js`,
      `${CF}/plugins/${PID}/styles.css`,
      `${CF}/plugins/${PID}/unknown.txt`,
      `${CF}/plugins/${PID}/data.json`,
    ];
    const keys = await listFileKeys(files, folders, {
      syncSelfPlugin: true,
    });
    assert.deepStrictEqual(keys, [
      `${CF}/plugins/${PID}/main.js`,
      `${CF}/plugins/${PID}/styles.css`,
    ]);
  });

  // --- extra coverage beyond the spec table ---

  it("extra: plugins/ dir not traversed when both plugin toggles off", async () => {
    const folders = [CF, `${CF}/plugins`, `${CF}/plugins/dataview`];
    const files = [`${CF}/app.json`, `${CF}/plugins/dataview/main.js`];
    const all = await listAll(files, folders, { syncObsidianConfig: true });
    assert.deepStrictEqual(all, [`${CF}/`, `${CF}/app.json`]);
  });

  it("extra: bookmarks-only mode lists root + bookmarks.json only", async () => {
    const folders = [CF];
    const files = [`${CF}/app.json`, `${CF}/bookmarks.json`];
    const all = await listAll(files, folders, { syncBookmarks: true });
    assert.deepStrictEqual(all, [`${CF}/`, `${CF}/bookmarks.json`]);
  });

  it("extra: appearance-only mode lists root + appearance.json only", async () => {
    const folders = [CF];
    const files = [`${CF}/app.json`, `${CF}/appearance.json`];
    const all = await listAll(files, folders, { syncAppearance: true });
    assert.deepStrictEqual(all, [`${CF}/`, `${CF}/appearance.json`]);
  });

  it("extra: core-plugins-migration.json blacklisted", async () => {
    const folders = [CF];
    const files = [`${CF}/core-plugins-migration.json`, `${CF}/app.json`];
    const keys = await listFileKeys(files, folders, {
      syncObsidianConfig: true,
    });
    assert.deepStrictEqual(keys, [`${CF}/app.json`]);
  });
});
