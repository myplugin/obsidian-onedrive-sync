# Deploy paths & auto-reload — why two scripts, and the reload wiring

Project-relevant experience — the build/deploy toolchain has two deploy paths that look duplicative but serve different trigger models; both must stay in sync, including the auto-reload step.

## The two deploy paths

| | `esbuild.config.mjs` (inline `deployPlugin`) | `scripts/deploy.mjs` (standalone) |
|---|---|---|
| Trigger | **Build side effect** — `onEnd` hook fires after each (re)build | **Explicit command** `npm run deploy` |
| Builds? | Yes — coupled to esbuild lifecycle | No — only copies already-built `main.js` |
| Vault source | Only `.env` `VAULT_PATH`; unset = no deploy | `VAULT_PATH`, else **auto-discovers** from Obsidian's global `obsidian.json` (zero-config) |
| Watch behavior | Fires on every save/rebuild | Doesn't run in watch |
| Failure semantics | Silent warn — must not break the build | `process.exit(1)` — a no-op deploy is a mistake worth surfacing |

## Why both exist (not redundant)

- The inline one **must** be an esbuild `onEnd` plugin: a plain function call can't fire at the exact "bundle finished" moment, and watch-mode auto-deploy depends on it. Putting `process.exit`/auto-discovery logic inside an esbuild plugin is awkward and risks killing the build mid-context.
- The standalone one gives a zero-config, one-shot deploy of an already-built artifact without recompiling, and auto-discovers the vault so it works without `.env`.

Dropping either one loses a workflow: remove inline → watch loses auto-deploy (every save needs a manual deploy); remove standalone → lose zero-config auto-discovery and one-shot deploy-without-build.

## Lineage

Originally webpack had a `DeployPlugin` (inline, build-coupled). Migrating to esbuild reimplemented the same inline behavior as an `onEnd` plugin. `scripts/deploy.mjs` is the separate, standalone path — its top comment explicitly flags the two as independent.

## Auto-reload wiring (added this session)

Both paths now call `reloadPlugin(id)` after copying files, running `obsidian plugin:reload id=remotely-save-onedrive`. Design choices:

- **`spawnSync` with `shell: true`** — resolves Windows `.cmd` shims for globally-installed CLIs as well as real binaries on PATH.
- **Graceful / non-fatal** — missing CLI or closed Obsidian logs a one-line warn and continues; never breaks the build. Essential so CI/headless builds stay green.
- **Only when deploy actually happens** — inline plugin is gated on `VAULT_PATH`; standalone runs reload only after a vault is resolved.
- **Fires on every watch rebuild** — intended hot-reload dev cycle. If it ever gets noisy, gate behind an env flag rather than removing it.

## Lesson: keep both paths in sync

Any deploy-affecting change (new file to copy, reload step, path logic) must be applied to **both** `esbuild.config.mjs` and `scripts/deploy.mjs`. They intentionally don't share a helper; the duplication (~6 lines of copy loop) is the cost of two self-contained, independently-triggered paths. Resist "DRY-ing" by coupling the esbuild plugin to the standalone script — the standalone's `process.exit`/auto-discovery semantics don't belong inside an esbuild `onEnd`.
