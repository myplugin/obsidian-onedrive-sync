# esbuild — fast JS/TS bundler

Project-independent knowledge — what esbuild is and the bundler concepts its config illustrates.

## What it is

esbuild is a JavaScript/TypeScript **bundler and minifier written in Go**. It resolves `import`/`require` graphs starting from an entry point and emits a single output file, compiling TS/JSX along the way. Its selling point is speed — typically one to two orders of magnitude faster than webpack/rollup, because parsing/printing and (where relevant) minification are parallelized native code rather than JS.

## Why it replaced webpack

In **watch mode** (`--watch`), esbuild rebuilds nearly instantly on each save. That speed is what makes a live edit → auto-deploy → auto-reload loop tolerable; slower rebuilders make the loop laggy.

## Core config concepts (general)

These recur in any esbuild setup:

| Concept | What it means |
|---|---|
| `entryPoints` | The file(s) bundling starts from; `import`s are followed transitively. |
| `bundle: true` | Follow imports and inline them into the output (vs. leaving `require(...)` calls). |
| `external` | Packages NOT bundled — left as a runtime `require`/import resolved by the host. Use when the runtime provides the module (e.g. a host app's global). |
| `format` | Output module system: `cjs`, `esm`, `iife`. |
| `define` | **Compile-time** constant substitution — `global.X` → a literal in the output. Bakes build-time config (e.g. a client ID from `.env`) in; changing a `define`d value requires a rebuild. |
| `loader` | Per-extension handling, e.g. `.svg: "text"` inlines the file as a string. |
| `plugins` | esbuild plugin objects with `onResolve`/`onLoad`/`onEnd` hooks. `onEnd` fires **after** a build completes — the hook point for side effects like copying output somewhere. |
| `banner` | Prepend text to the output (e.g. a "this is generated" notice). |
| `sourcemap` | Emit source maps (`true`/`"inline"`/`false`); inline is handy in dev. |
| `target` | Downlevel syntax to a JS spec level (e.g. `es2020`). |
| `minify` | Strip/mangle in production builds. |
| `watch` | Rebuild automatically when inputs change (esbuild ≥0.17 uses `context.watch()`). |
| `browser` field (package.json) | Field esbuild honors to redirect Node builtins (`fs`, `http`, …) to browser-friendly polyfills or `false` (stub). Critical when a bundle must run with **no Node runtime**. |

## `onEnd` is the post-build side-effect hook

A build often needs to do something *after* the bundle is written — deploy it, reload something, notify. esbuild plugins expose `build.onEnd(() => …)` for exactly this; it fires once per completed (re)build. A plain function call can't hit that precise "bundle finished" moment, which is why post-build side effects are wired as `onEnd` plugins rather than ordinary code after the build call.

## `define` vs runtime config

`define` injects values at **build** time — anything `define`d becomes a literal in the bundle, so it is not configurable at runtime and changing it forces a rebuild. If a value must change without rebuilding, it has to come from a runtime source (a file the host reads, an env the app exposes), not `define`.
