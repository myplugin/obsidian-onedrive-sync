# AGENTS.md

Guidance for AI agents working in `remotely-save` — an Obsidian plugin that syncs a vault to cloud services (S3, OneDrive, Dropbox, WebDAV, Webdis, and paid Google Drive / Box / pCloud / Yandex / Koofr / Azure Blob).

## Commands

- `npm run dev` — webpack watch (the active dev toolchain)
- `npm run build` — webpack production build → `main.js`
- `npm run dev2` / `npm run build2` — esbuild alternative; `build2` also runs `tsc -noEmit -skipLibCheck` (the only standalone typecheck)
- `npm run format` — `biome check --write .` (formatter + linter)
- `npm run clean` — `rimraf main.js`
- `npm test` — mocha + tsx over `tests/**/*.ts` **and** `pro/tests/**/*.ts`
- Single test file: `npx mocha --import=tsx tests/misc.test.ts`
- No standalone lint or typecheck script; typecheck only runs via `build2` or webpack's ts-loader.

## Build environment

- `.env` is gitignored (`.gitignore` ignores `.*`). Copy from `.env.example.txt` and fill OAuth client IDs/secrets (Dropbox, OneDrive, Google Drive, Box, pCloud, Yandex, Koofr, RemotelySave site).
- These are injected at build time as `global.DEFAULT_*` constants (see `webpack.config.js` `DefinePlugin` and `esbuild.config.mjs` `define`). Empty values build fine, but the matching services can't connect.
- webpack and esbuild configs define the **same** `global.DEFAULT_*` map — keep them in sync when adding a new service.
- Obsidian loads `main.js` + `manifest.json` + `styles.css`. Both `main.js` and `data.json` (runtime plugin data) are gitignored.

## Architecture

- Entry point `src/main.ts` (~2k lines) — the Obsidian `Plugin` subclass, and the only place with side effects / stateful code.
- `src/` is open source (Apache-2.0). `pro/` is source-available paid features (PolyForm Strict) — **not** OSS; never copy `pro/` code into `src/` or treat it as freely reusable.
- `pro/` is **not** a separate package: `src/main.ts` imports directly from `../pro/src/*`, and both are bundled into one `main.js`.
- Per-cloud filesystem modules follow the `fs*.ts` pattern:
  - `src/`: `fsLocal`, `fsS3`, `fsOnedrive`, `fsDropbox`, `fsWebdav`, `fsWebdis`, `fsMock` (tests), `fsGetter` (selector), `fsAll`, `fsEncrypt`
  - `pro/src/`: `fsGoogleDrive`, `fsBox`, `fsPCloud`, `fsYandexDisk`, `fsKoofr`, `fsAzureBlobStorage`, `fsOnedriveFull`
- Sync algorithm (v3) lives in `pro/src/sync.ts`, supported by `src/copyLogic.ts`, `src/metadataOnRemote.ts`, `src/syncAlgoV3Notice.ts`.
- Runtime state: `src/settings.ts` (Obsidian plugin settings), `src/configPersist.ts`, `src/localdb.ts` (localforage wrapper). Plugin data is persisted to `data.json` (gitignored).
- i18n lives in `src/langs/` — to add a language, copy `en.json` → `<lang>.json`, translate, then register it in `src/langs/index.ts`.
- Web workers use the `*.worker.ts` suffix (e.g. `encryptRClone.worker.ts`); inlined by webpack `worker-loader` / esbuild `inline-worker`.

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
- `docs/remote_services/<service>/` — per-service setup notes and CORS/quirks.
- `docs/how_to_debug/` — debugging flows (logs, sync plans export, console/vconsole).
- `pro/src/add_new_service.md` — how to add a new cloud service.
