# AGENTS.md

Guidance for AI agents working in `remotely-save-onedrive` — a OneDrive-only fork of the Obsidian plugin that syncs a vault to Microsoft OneDrive via the Graph App Folder API.

## Commands

- `npm run dev` — esbuild watch (sole dev toolchain)
- `npm run build` — `tsc -noEmit -skipLibCheck` typecheck + esbuild production build → `main.js`
- `npm run typecheck` — `tsc -noEmit -skipLibCheck` (standalone typecheck; also runs as part of `build`)
- `npm run format` — `biome check --write .` (formatter + linter)
- `npm run clean` — `rimraf main.js`
- `npm test` — mocha + tsx over `tests/**/*.ts`
- Single test file: `npx mocha --import=tsx tests/misc.test.ts`
- No standalone lint script. The webpack toolchain has been removed; esbuild is the sole bundler.

## Build environment

- `.env` is gitignored (`.gitignore` ignores `.*`). Copy from `.env.example.txt` and fill the OneDrive client ID.
- The OneDrive OAuth values are injected at build time as `global.DEFAULT_*` constants — `DEFAULT_ONEDRIVE_CLIENT_ID` and `DEFAULT_ONEDRIVE_AUTHORITY` (see `esbuild.config.mjs` `define`). Empty values build fine, but OneDrive can't connect.
- `VAULT_PATH` in `.env` enables auto-deploy: on `dev` (watch) and `build`, an esbuild `onEnd` plugin copies `main.js` + `manifest.json` + `styles.css` to `<vault>/.obsidian/plugins/remotely-save-onedrive/` (mirrors `scripts/deploy.mjs`, which `npm run deploy` invokes directly).
- Obsidian loads `main.js` + `manifest.json` + `styles.css`. Both `main.js` and `data.json` (runtime plugin data) are gitignored.

## Architecture

- Entry point `src/main.ts` (~1.2k lines) — the Obsidian `Plugin` subclass, the only stateful file / only place with side effects.
- **No `pro/` directory** — it has been dissolved. All code lives in flat `src/`.
- **License split within `src/`**: most of `src/` is Apache-2.0 (`src/LICENSE`). Five files are **PolyForm Strict 1.0.0** (source-available, see root `LICENSE.pro`): `src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts` (each carries a `// License: PolyForm Strict` header). Personal use is fine; distribution must respect the PolyForm terms. Never copy these into Apache-licensed derived works without honoring the license.
- Per-cloud filesystem modules follow the `fs*.ts` pattern, all in `src/`:
  - `fsLocal` — vault local filesystem
  - `fsOnedrive` — the only real cloud backend (Microsoft Graph App Folder)
  - `fsAll` — `FakeFs` abstract base
  - `fsGetter` — `getClient` selector (separate file to avoid a `fsAll`↔`fsOnedrive` circular dependency: `fsOnedrive` extends `FakeFs` from `fsAll`, while `getClient` instantiates `FakeFsOnedrive`)
  - `fsEncrypt` — rclone-crypt wrapper around any `FakeFs`
- Sync algorithm (v3) lives in `src/sync.ts`, supported by `src/copyLogic.ts` (copy primitives), `src/metadataOnRemote.ts` (remote metadata file naming), `src/syncAlgoV3Notice.ts` (v3 migration modal). `src/conflictLogic.ts` = smart-conflict 3-way merge (node-diff3). `src/fileContentHistory.ts` = file-content-history backing for smart-conflict (sole consumer: `src/sync.ts`). `src/clearDupFiles.ts` + `src/settingsClearDupFiles.ts` = clear-duplicate-files feature. (These five are the PolyForm files noted above.)
- Runtime state: `src/settings.ts` (plugin settings UI), `src/configPersist.ts` (settings serialization), `src/localdb.ts` (localforage wrapper, sync-record persistence). Plugin data is persisted to `data.json` (gitignored).
- Utilities: `src/misc.ts` (must-not-depend-on-internal layer), `src/encryptOpenSSL.ts` + `src/encryptRClone.ts` (+`.worker.ts`) (encryption), `src/baseTypes.ts` (shared types + Obsidian API version constants; `baseTypesObs` was merged in here), `src/importExport.ts` (QR config import/export), `src/obsFolderLister.ts`, `src/profiler.ts`, `src/regexListSetting.ts`, `src/debugMode.ts` (sync plan export for debugging).
- i18n lives in `src/i18n.ts` + `src/langs/` (a single directory — `en` / `zh_cn` / `zh_tw` JSON + `index.ts`). To add a language: copy `en.json` → `<lang>.json`, translate, then register it in `src/langs/index.ts`.
- Web workers use the `*.worker.ts` suffix (e.g. `encryptRClone.worker.ts`); inlined by esbuild `esbuild-plugin-inline-worker`.

## Conventions

- Keep functions pure except inside `main.ts`; pass state via parameters. (see `docs/code_design.md`)
- `src/misc.ts` must not depend on any other internal module.
- Storage modules (`fs*.ts`) must not import `sync.ts`.
- Folders are always represented by strings ending with `/`.
- Biome style: 2-space indent, LF, 80-col width, double quotes for JSX, semicolons, `es5` trailing commas. `noExplicitAny`, `noNonNullAssertion`, and several other defaults are **off** — `any` and non-null assertions are accepted here; don't "fix" them.
- Versioning: keep `package.json`, `manifest.json`, and `manifest-beta.json` versions in sync. `versions.json` is Obsidian's version history.

## Contributing

- A signed CLA is required for **all** PRs — sign by commenting `I have read the CLA Document and I hereby sign the CLA` on the PR. No corporate contributions accepted. See `CONTRIBUTING.md` / `CLA.md`.

## Key docs

- `docs/code_design.md` — code organization rules (purity, deps, folder strings).
- `docs/sync_algorithm/v3/` — sync algorithm design (`intro.md`, `design.md`).
- `docs/remote_services/onedrive/` — OneDrive setup notes and CORS/quirks (the only service).
- `docs/how_to_debug/` — debugging flows (logs, sync plans export, console/vconsole).
