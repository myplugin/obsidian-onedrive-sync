/**
 * Minimal `obsidian` runtime stub for tests that import src modules which
 * VALUE-import the `obsidian` package (e.g. ../src/fsOnedrive directly, and
 * ../src/baseTypes via its top-level VALID_REQURL computation).
 *
 * The `obsidian` npm package is types-only ("main": "", no runtime JS), so
 * require("obsidian") throws MODULE_NOT_FOUND under plain Node. Every other
 * src module tested in this repo is obsidian-free at runtime (type-only
 * imports); fsOnedrive is the first that is not.
 *
 * USAGE: `import "./_obsidianStub";` BEFORE any import of such modules —
 * as a side-effect module it participates in static import order, so the
 * intercept is installed before the target module is evaluated. (An inline
 * statement in the test file cannot do this: static imports hoist above
 * every statement in the transpiled output.)
 *
 * The stub covers exactly the members used at module-load time:
 * - Platform.isAndroidApp / requireApiVersion() — baseTypes.ts VALID_REQURL
 * - request / requestUrl — fsOnedrive.ts (only used inside async methods;
 *   the stubs throw so accidental use in a test fails loudly)
 *
 * Importing this file twice is a no-op (guarded).
 */
import Module from "node:module";

const obsidianStub = {
  Platform: { isAndroidApp: false, isMobileApp: false, isDesktopApp: true },
  requireApiVersion: () => true,
  request: () => {
    throw new Error("obsidian.request is not available in tests");
  },
  requestUrl: () => {
    throw new Error("obsidian.requestUrl is not available in tests");
  },
};

if ((globalThis as any).__obsidianStubInstalled === undefined) {
  const originalModuleLoad = (Module as any)._load;
  (Module as any)._load = function (
    this: any,
    request: string,
    parent: any,
    isMain: boolean
  ) {
    if (request === "obsidian") {
      return obsidianStub;
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  (globalThis as any).__obsidianStubInstalled = true;
}
