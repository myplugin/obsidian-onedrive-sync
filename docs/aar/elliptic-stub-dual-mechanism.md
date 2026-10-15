# elliptic stub — dual mechanism (npm override + esbuild alias)

## Context

`crypto-browserify@3.12.0` (used as the `node:crypto` polyfill for msal-node) transitively depends on `elliptic@6.6.1` via `browserify-sign` (ECDSA sign/verify) + `create-ecdh` (ECDH key exchange). The plugin uses RSA (Azure AD JWTs via jsonwebtoken), never EC crypto — so elliptic is dead code in the bundle.

The advisory GHSA-848j-6mx2-7j84 ("Uses a Cryptographic Primitive with a Risky Implementation") has no fixed version: 6.6.1 is the latest release. The only way to eliminate it is to remove it from the dependency tree.

## The stub

`stubs/elliptic/index.js` exports the elliptic API surface (`version`, `utils`, `rand`, `curve`, `curves`, `ec`, `eddsa`) with no-op implementations. The `ec`/`eddsa` constructors throw if called — which never happens for RSA algorithms. Module initialization (property access during `require`) does not throw.

## Layer 1: npm `overrides` (for `npm audit`)

```json
// package.json
"overrides": {
  "elliptic": "file:./stubs/elliptic"
}
```

This replaces `elliptic` everywhere in the dependency tree with the local stub. `npm audit` no longer sees the vulnerable version. `npm ls elliptic` shows `elliptic@0.0.0-stub -> .\stubs\elliptic`.

**Limitation**: `file:` overrides create symlinks. These work on Windows (`npm install`) but NOT reliably on Linux CI (`npm ci` recreates the lockfile's symlink structure, which may not resolve). See `docs/notes/npm-overrides-file-protocol.md`.

## Layer 2: esbuild `alias` (for bundling)

```javascript
// esbuild.config.mjs
alias: {
  elliptic: path.resolve("stubs/elliptic/index.js"),
}
```

This tells esbuild: wherever `require("elliptic")` appears (including inside `node_modules/browserify-sign/`), resolve it to the stub file. This is a build-time string redirect — no symlink, no node_modules resolution, platform-independent.

**Why both are needed**: npm override alone fails on Linux CI (broken symlink → esbuild can't resolve). esbuild alias alone doesn't remove the vuln from `npm audit` (the real elliptic is still in the dep tree). Together: audit is clean + bundle is clean + cross-platform.

## Verification

- `npm audit --omit=dev`: 0 vulnerabilities (elliptic gone from prod deps).
- `npm run scan`: dependency audit check passes.
- esbuild bundle: 53 elliptic references → 1 (just the stub's error message). Dead EC code eliminated.
- CI (Linux + Node 22 + npm ci): build passes, release created.
- 619 tests pass, tsc 0 errors.

## If EC crypto is ever needed

Replace the stub with the real `elliptic` package: remove the npm override + the esbuild alias. The stub's `ec`/`eddsa` constructors throw with a clear message: "Install the real elliptic package and remove the npm override if needed."
