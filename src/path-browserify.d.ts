// Type shim for the `path-browserify` polyfill (mapped from `path` via the
// package.json `browser` field and used directly by src/misc.ts so the
// obsidianmd/no-nodejs-modules rule stays clean). Re-uses @types/node's
// `path` types: the polyfill implements the same posix-ish API surface.
declare module "path-browserify" {
  const p: typeof import("path");
  export = p;
}
