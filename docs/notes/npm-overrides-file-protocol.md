# npm overrides + `file:` protocol — cross-platform pitfall

## What npm overrides do

`package.json` `"overrides"` replaces a dependency anywhere in the tree (including transitive deps) with a different version or package. This is the standard way to force a vulnerable transitive dep out of the tree without waiting for the direct dep to update.

```json
"overrides": {
  "elliptic": "file:./stubs/elliptic"
}
```

This tells npm: wherever anything depends on `elliptic`, install it from `./stubs/elliptic/` (a local directory with its own `package.json` + `index.js`) instead of from the registry.

## The `file:` protocol creates symlinks

`file:./path` in npm does NOT copy files — it creates a **symlink** in `node_modules/<pkg>` → the local path. On Windows this works (NTFS symlinks). On Linux, `npm ci` recreates the lockfile's symlink structure, but the symlink target path may not resolve correctly — especially when the lockfile was generated on a different OS.

### Symptom

esbuild (or any bundler that reads `node_modules/`) does `require("elliptic")` inside `node_modules/browserify-sign/browser/sign.js`. On Windows, the symlink resolves → the stub loads. On Linux CI (`npm ci`), the symlink is broken or points nowhere → `ERROR: Could not resolve "elliptic"`.

### Root cause

The lockfile records the symlink as `"link": true` with a `"resolved"` path. When `npm ci` recreates this on a different OS, the relative symlink path may not point to the right place. The lockfile entry might say:

```json
"node_modules/elliptic": {
  "resolved": "node_modules/browserify-sign/stubs/elliptic",
  "link": true
}
```

This is an npm-internal virtual path that doesn't correspond to the actual `stubs/elliptic/` in the project root.

## Fix: dual mechanism

1. **npm `overrides`** (for `npm audit`): removes the vulnerable package from the dependency tree so `npm audit` is clean.
2. **esbuild `alias`** (for bundling): redirects `require("elliptic")` to the stub file at bundle time, bypassing node_modules resolution entirely.

```javascript
// esbuild.config.mjs
alias: {
  elliptic: path.resolve("stubs/elliptic/index.js"),
}
```

The `alias` is platform-independent (it's a build-time string redirect, no symlink). The `overrides` is needed for audit; the `alias` is needed for the bundle. Both are required.

## When to use `file:` overrides safely

`file:` overrides work reliably when:
- You develop + CI on the **same OS**.
- You use `npm install` (not `npm ci`) on CI — `npm install` re-resolves, `npm ci` strictly follows the lockfile.

When you develop on Windows + CI on Linux, prefer `npm:` aliases (`"elliptic": "npm:some-published-stub@1.0.0"`) or esbuild `alias` instead of `file:`.
