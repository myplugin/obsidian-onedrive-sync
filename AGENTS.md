# AGENTS.md

Guidance for AI agents working in `onedrive-vault-sync` — a OneDrive-only fork of the Obsidian plugin that syncs a vault to Microsoft OneDrive via the Graph App Folder API.

## Commands

- `npm run dev` — esbuild watch
- `npm run build` — `tsc -noEmit -skipLibCheck` typecheck + esbuild production build → `main.js`
- `npm run typecheck` — standalone typecheck (also runs as part of `build`)
- `npm run scan` — **门禁检查 (gate check)**: 7-item Obsidian scanner mirror (ESLint all rules + CSS !important + dep audit + lockfile sync + version consistency + installability + manifest fields). Exit 0 = clean.
- `npm run format` — `biome check --write .` (formatter + linter)
- `npm run clean` — `rimraf main.js`
- `npm test` — mocha + tsx over `tests/**/*.ts`
- Single test file: `npx mocha --import=tsx tests/misc.test.ts`

## 门禁检查 (Gate Check)

When the user says "门禁检查", "gate check", "检查一下", "push 前检查", or similar, run the **full gate** before any push:

```bash
npm run scan       # 7 checks: ESLint + CSS + deps + lockfile + version + installability + manifest
npm run typecheck  # tsc 0 errors
npm test           # all tests pass
npm run build      # tsc + esbuild + verify-build (move .env aside first: MV .env .env.bak; restore after)
```

All 4 must pass (0 warnings/errors/failures). Report each result. Only green → safe to push.

The CI workflow (`.github/workflows/release.yml`) runs the same gate automatically on tag push: `npm ci → npm run scan → npm run build → verify version → release`. If any check fails, no release is created.

### Before pushing: mandatory workflow

**Any `package.json` change → `npm install` (sync lockfile) → `npm run build` → `npm run scan` → then push.** The lockfile sync check in `npm run scan` catches staleness, but running `npm install` first avoids the scan having to restore the lockfile.

## Build environment

- `.env` is gitignored. The OneDrive client ID + authority are baked into `esbuild.config.mjs` as working defaults (`DEFAULT_ONEDRIVE_CLIENT_ID` / `DEFAULT_ONEDRIVE_AUTHORITY` via esbuild `define`), so a clean clone builds and authenticates with **no `.env`**. Copy `.env.example.txt` → `.env` only to override (e.g. test a different app registration).
- `VAULT_PATH` in `.env` enables auto-deploy: on `dev` (watch) and `build`, an esbuild `onEnd` plugin copies `main.js` + `manifest.json` + `styles.css` to `<vault>/.obsidian/plugins/onedrive-vault-sync/` (mirrors `scripts/deploy.mjs`, which `npm run deploy` invokes directly).
- `main.js` and `data.json` (runtime plugin data) are gitignored.

## Architecture

- Entry point `src/main.ts` (~2.3k lines) — the Obsidian `Plugin` subclass, the only stateful file / only place with side effects.
- All code lives in flat `src/`.
- **License split within `src/`**: most of `src/` is Apache-2.0 (`src/LICENSE`). Five files are **PolyForm Strict 1.0.0** (source-available, see root `LICENSE.pro`): `src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts` (each carries a `// License: PolyForm Strict` header). Personal use is fine; distribution must respect the PolyForm terms. Never copy these into Apache-licensed derived works without honoring the license.
- Per-cloud filesystem modules follow the `fs*.ts` pattern, all in `src/`:
  - `fsLocal` — vault local filesystem
  - `fsOnedrive` — the only real cloud backend (Microsoft Graph App Folder)
  - `fsAll` — `FakeFs` abstract base
  - `fsGetter` — `getClient` selector (separate file to avoid a `fsAll`↔`fsOnedrive` circular dependency: `fsOnedrive` extends `FakeFs` from `fsAll`, while `getClient` instantiates `FakeFsOnedrive`)
  - `fsEncrypt` — rclone-crypt wrapper around any `FakeFs`
- Sync algorithm (v3) lives in `src/sync.ts`, supported by `src/copyLogic.ts` (copy primitives), `src/metadataOnRemote.ts` (remote metadata file naming), `src/syncAlgoV3Notice.ts` (v3 migration modal). `src/conflictLogic.ts` = smart-conflict 3-way merge (node-diff3). `src/fileContentHistory.ts` = file-content-history backing for smart-conflict (sole consumer: `src/sync.ts`). `src/clearDupFiles.ts` + `src/settingsClearDupFiles.ts` = clear-duplicate-files feature.
- Runtime state: `src/settings.ts` (plugin settings UI), `src/configPersist.ts` (settings serialization), `src/localdb.ts` (localforage wrapper, sync-record persistence). Plugin data is persisted to `data.json` (gitignored).
- Utilities: `src/misc.ts` (must-not-depend-on-internal layer), `src/encryptOpenSSL.ts` + `src/encryptRClone.ts` (+`.worker.ts`) (encryption), `src/baseTypes.ts` (shared types + Obsidian API version constants), `src/importExport.ts` (QR config import/export), `src/obsFolderLister.ts`, `src/profiler.ts`, `src/regexListSetting.ts`, `src/debugMode.ts` (sync plan export for debugging).
- i18n lives in `src/i18n.ts` + `src/langs/` (a single directory — `en` / `zh_cn` / `zh_tw` JSON + `index.ts`). To add a language: copy `en.json` → `<lang>.json`, translate, then register it in `src/langs/index.ts`.
- Web workers use the `*.worker.ts` suffix (e.g. `encryptRClone.worker.ts`); inlined by esbuild `esbuild-plugin-inline-worker`.

## Conventions

- Keep functions pure except inside `main.ts`; pass state via parameters. (see `docs/architecture/code_design.md`)
- `src/misc.ts` must not depend on any other internal module.
- Storage modules (`fs*.ts`) must not import `sync.ts`.
- Folders are always represented by strings ending with `/`.
- Biome style: 2-space indent, LF, 80-col width, double quotes for JSX, semicolons, `es5` trailing commas. `noExplicitAny`, `noNonNullAssertion`, and several other defaults are **off** — `any` and non-null assertions are accepted here; don't "fix" them.
- Versioning: keep `package.json`, `manifest.json`, and `manifest-beta.json` versions in sync. `versions.json` is Obsidian's version history.
- **Desktop + mobile parity.** This plugin runs on both Obsidian desktop and mobile; keep the UX, settings, and sync behavior consistent across both. Avoid desktop-only or mobile-only assumptions (window APIs, file-system capabilities, network conditions) — test changes against both targets.
- **Call-mode changes require a contract re-audit.** When changing HOW an external API is invoked (e.g. full→incremental delta, `/children`→`/delta`, v1→beta), re-read the endpoint's Remarks for the new mode and confirm every field the code depends on is still guaranteed present — neither diff, typecheck, nor happy-path tests will catch omitted fields. See [`docs/lessons/onedrive-delta-parentreference-path.md`](docs/lessons/onedrive-delta-parentreference-path.md).

## Contributing

- This is a personal project. Pull requests are welcome; there is **no CLA**. See the split license in [`LICENSE`](LICENSE) / [`LICENSE.pro`](LICENSE.pro).

## Key docs

- [`docs/architecture/code_design.md`](docs/architecture/code_design.md) — code organization rules (purity, deps, folder strings).
- [`docs/sync_algorithm/v3/`](docs/sync_algorithm/v3/) — sync algorithm design (`intro.md`, `design.md`).
- [`docs/remote_services/onedrive/`](docs/remote_services/onedrive/) — OneDrive setup notes and CORS/quirks (the only service).
- [`docs/how_to_debug/`](docs/how_to_debug/) — debugging flows (logs, sync plans export, console/vconsole).
- [`docs/lessons/`](docs/lessons/) — postmortems / lessons learned (start with `onedrive-delta-parentreference-path.md`, in Chinese).
