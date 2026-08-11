# pro/ 展平 + 架构清理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `pro/` 目录整体展平进扁平 `src/`，删除死代码与 stale 残留，行为不变。

**Architecture:** 纯机械重构——移动/重命名文件 + import 路径改写 + 删死代码 + 两处小合并 + i18n 单目录化 + 许可证注释 + 配置/文档清理。`sync.ts` 内部逻辑零改动。回归保护靠现有 mocha 测试套 + `npm run build2` 类型检查（非新写失败测试）。

**Tech Stack:** TypeScript, webpack（主）+ esbuild（备）, mocha + tsx, biome, Obsidian plugin API, localforage, lodash, @azure/msal-node, @microsoft/microsoft-graph-client.

## Global Constraints

（来自 spec §2-3 + AGENTS.md，所有任务隐含遵守）
- Biome 风格：2 空格缩进、LF、80 列、双引号、分号、`es5` 尾逗号
- `noExplicitAny`/`noNonNullAssertion` 关闭——`any` 和 `!` 在本仓被接受，**不要"修复"它们**
- `src/misc.ts` 不得依赖任何内部模块
- 文件夹一律用 `/` 结尾的字符串表示
- **`sync.ts` 内部逻辑零改动**（仅 import 路径改写 + 顶部许可证注释）
- `package.json` / `manifest.json` / `manifest-beta.json` / `versions.json` 版本号保持同步（本次不改版本号）
- 行为不变：仅移动/删除/路径改写/注释/文档
- 每个 .ts 文件顶部已有的 import 顺序：外部包 → 内部模块（保持）

---

## File Structure

**移动（pro/ → src/，名字不变除特别注明）：**
- `pro/src/sync.ts` → `src/sync.ts`
- `pro/src/conflictLogic.ts` → `src/conflictLogic.ts`（同时：移除 `MERGABLE_SIZE` 的 import，在本文件顶部加局部 `const`）
- `pro/src/clearDupFiles.ts` → `src/clearDupFiles.ts`
- `pro/src/settingsClearDupFiles.ts` → `src/settingsClearDupFiles.ts`
- `pro/src/localdb.ts` → **`src/fileContentHistory.ts`**（强制重命名，避免与 `src/localdb.ts` 冲突）
- `pro/tests/sync.test.ts` → `tests/sync.test.ts`
- `pro/tests/conflictLogic.test.ts` → `tests/conflictLogic.test.ts`
- `pro/LICENSE` → `LICENSE.pro`（根目录）

**删除：**
- `pro/src/koofrApi.d.ts`（9952 行，零引用）
- `pro/src/yandexApi.ts`（278 行，零引用）
- `pro/src/oauth2.ts`（25 行，零引用）
- `pro/src/baseTypesPro.ts`（`MERGABLE_SIZE` 移走后全文件死）
- `src/fsMock.ts`（50 行，零引用）
- `pro/README.md`、`pro/src/add_new_service.md`（stale）
- `docs/remote_services/{googledrive,box,pcloud,yandexdisk,koofr,azureblobstorage,onedrivefull}/`
- `pro/` 目录本身（清空后）

**修改（import 改写 + 合并 + 注释 + 配置 + 文档）：**
- `src/main.ts`、`src/settings.ts`、`src/localdb.ts`、`src/debugMode.ts`、`src/i18n.ts`
- `src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/settingsClearDupFiles.ts`、`src/clearDupFiles.ts`（移动后内容）
- `src/fsOnedrive.ts`（B 合并改 import）
- `src/baseTypes.ts`（吸收 `baseTypesObs`）、`src/fsAll.ts`（吸收 `fsGetter`）
- `src/langs/{en,zh_cn,zh_tw}.json`（吸收 pro/langs 内容）
- `tsconfig.json`、`package.json`
- `AGENTS.md`（重写）

---

## Task 1: 核心展平 — 移动 + 重命名 + import 改写

**Files:**
- Move: `pro/src/{sync,conflictLogic,clearDupFiles,settingsClearDupFiles}.ts` → `src/`
- Move+Rename: `pro/src/localdb.ts` → `src/fileContentHistory.ts`
- Move: `pro/tests/{sync,conflictLogic}.test.ts` → `tests/`
- Modify: `src/main.ts`、`src/settings.ts`、`src/localdb.ts`、`src/debugMode.ts`、移动后的 5 个文件

**Interfaces:**
- Consumes: spec §4.5 的 import 改写表（逐条照搬）
- Produces: `src/sync.ts`、`src/fileContentHistory.ts` 等；`pro/src/` 只剩死代码与 langs/（本任务不动）

**注意：本任务不改 `src/i18n.ts:5` 的 `../pro/src/langs` import，也不动 `pro/src/langs/`——留给 Task 4。Task 1 后 `pro/src/langs/` 仍存在，该 import 仍有效，build 保持绿。**

- [ ] **Step 1: 移动 5 个存活 .ts 文件到 src/（含 1 个重命名）**

```bash
git mv pro/src/sync.ts src/sync.ts
git mv pro/src/conflictLogic.ts src/conflictLogic.ts
git mv pro/src/clearDupFiles.ts src/clearDupFiles.ts
git mv pro/src/settingsClearDupFiles.ts src/settingsClearDupFiles.ts
git mv pro/src/localdb.ts src/fileContentHistory.ts
```

- [ ] **Step 2: 移动 2 个测试文件到 tests/**

```bash
git mv pro/tests/sync.test.ts tests/sync.test.ts
git mv pro/tests/conflictLogic.test.ts tests/conflictLogic.test.ts
```
（两文件的 `../src/X` import 从 `tests/` 仍指向根 `src/`，目标已移到 `src/`，零改写。）

- [ ] **Step 3: 改写 src/ → pro/ 的 4 条 import（i18n.ts 留给 Task 4）**

`src/main.ts:19`：
```ts
// 旧: import { syncer } from "../pro/src/sync";
import { syncer } from "./sync";
```
`src/settings.ts:21`：
```ts
// 旧: import { generateClearDupFilesSettingsPart } from "../pro/src/settingsClearDupFiles";
import { generateClearDupFilesSettingsPart } from "./settingsClearDupFiles";
```
`src/localdb.ts:9`：
```ts
// 旧: import { type SyncPlanType } from "../pro/src/sync";  // (确认是否 type-only)
import { type SyncPlanType } from "./sync";
```
`src/debugMode.ts:3`：
```ts
// 旧: import { type SyncPlanType } from "../pro/src/sync";
import { type SyncPlanType } from "./sync";
```

- [ ] **Step 4: 改写 src/sync.ts 的 import（9 条跨边界 + 1 条内部重命名）**

`src/sync.ts:14-17`：
```ts
import { ConflictActionType, EmptyFolderCleanType, Entity, MixedEntity, RemotelySavePluginSettings, SUPPORTED_SERVICES_TYPE, SyncDirectionType, SyncTriggerSourceType } from "./baseTypes";
import { copyFile, copyFileOrFolder, copyFolder } from "./copyLogic";
import { type FakeFs } from "./fsAll";
import { type FakeFsEncrypt } from "./fsEncrypt";
```
`src/sync.ts:24`：
```ts
import { InternalDBs, clearPrevSyncRecordByVaultAndProfile, getAllPrevSyncRecordsByVaultAndProfile, insertSyncPlanRecordByVault, upsertPrevSyncRecordByVaultAndProfile } from "./localdb";
```
`src/sync.ts:28`：
```ts
import { DEFAULT_FILE_NAME_FOR_METADATAONREMOTE, DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 } from "./metadataOnRemote";
```
`src/sync.ts:38-39`：
```ts
import { atWhichLevel, checkValidName, getFolderLevels, getParentFolder, isHiddenPath, isSpecialFolderNameToSkip, roughSizeOfObject, unixTimeToStr } from "./misc";
import { type Profiler } from "./profiler";
```
`src/sync.ts:42-45`（原 `from "./localdb"` 即 pro 的 fileContentHistory）：
```ts
import {
  clearFileContentHistoryByVaultAndProfile,
  getFileContentHistoryByVaultAndProfile,
  upsertFileContentHistoryByVaultAndProfile,
} from "./fileContentHistory";
```

- [ ] **Step 5: 改写 src/conflictLogic.ts 的 import + 内联 MERGABLE_SIZE**

`src/conflictLogic.ts:17-19`：
```ts
import { type Entity } from "./baseTypes";
import { copyFile } from "./copyLogic";
import { type FakeFs } from "./fsAll";
```
`src/conflictLogic.ts:20` **删除整行**：
```ts
// 删除: import { MERGABLE_SIZE } from "./baseTypesPro";
```
在 conflictLogic.ts 顶部 import 块之后加入：
```ts
const MERGABLE_SIZE = 1000 * 1000; // 1 MB
```

- [ ] **Step 6: 改写 src/fileContentHistory.ts 的 import**

`src/fileContentHistory.ts:1-2`：
```ts
import { type Entity } from "./baseTypes";
import { type InternalDBs } from "./localdb";
```
（注：`./localdb` 此处指 localforage 包装器——本文件已重命名，故无冲突。）

- [ ] **Step 7: 改写 src/settingsClearDupFiles.ts 的 import**

`src/settingsClearDupFiles.ts:2-5`：
```ts
import { FakeFsLocal } from "./fsLocal";
import { type TransItemType } from "./i18n";
import { type RemotelySavePlugin } from "./main";
import { stringToFragment } from "./misc";
```
（`./clearDupFiles` 第 1 行不变。）

- [ ] **Step 8: 改写 src/clearDupFiles.ts 的 import**

`src/clearDupFiles.ts:1`：
```ts
import { type FakeFsLocal } from "./fsLocal";
```
（`./conflictLogic` 第 2 行不变。）

- [ ] **Step 9: 类型检查**

Run: `npm run build2`
Expected: PASS（零类型错误、零悬空 import）。若报错，核对 spec §4.5 表逐条比对。

- [ ] **Step 10: 生产构建**

Run: `npm run build`
Expected: 生成 `main.js` 无报错。

- [ ] **Step 11: 测试**

Run: `npm test`
Expected: 全部现有测试通过（`tests/` 现含原 pro/tests 的 2 个文件）。

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "refactor: flatten pro/src into src/ + rewrite imports (sync, conflictLogic, clearDupFiles, settingsClearDupFiles, fileContentHistory)"
```

---

## Task 2: 删死代码

**Files:**
- Delete: `pro/src/koofrApi.d.ts`、`pro/src/yandexApi.ts`、`pro/src/oauth2.ts`、`pro/src/baseTypesPro.ts`、`src/fsMock.ts`

**Interfaces:**
- Consumes: Task 1 已把 `MERGABLE_SIZE` 移出 `baseTypesPro.ts` → 该文件全死
- Produces: 无（仅删除）

- [ ] **Step 1: 核实 5 个文件零引用**

Run: `grep -r --include=*.ts -E "koofrApi|yandexApi|from \"(.*\/)?oauth2\"|from \"(.*\/)?fsMock\"|from \"(.*\/)?baseTypesPro\"" src/ tests/`
Expected: 零命中（`oauth2` 字样命中 `oauth2Info` 字段或 URL 不算——只看 import 语句）。若命中 import 语句，**停止**并报告。

- [ ] **Step 2: 删除 5 个文件**

```bash
git rm pro/src/koofrApi.d.ts
git rm pro/src/yandexApi.ts
git rm pro/src/oauth2.ts
git rm pro/src/baseTypesPro.ts
git rm src/fsMock.ts
```

- [ ] **Step 3: 类型检查 + 构建 + 测试**

Run: `npm run build2`; if pass → `npm run build`; if pass → `npm test`
Expected: 全 PASS（删死代码不影响行为）。

- [ ] **Step 4: 提交**

```bash
git commit -am "refactor: delete dead code (koofrApi.d.ts, yandexApi.ts, oauth2.ts, baseTypesPro.ts, fsMock.ts)"
```

---

## Task 3: B 合并 — baseTypesObs→baseTypes, fsGetter→fsAll

**Files:**
- Modify: `src/baseTypes.ts`（吸收 `baseTypesObs.ts` 内容）、`src/fsAll.ts`（吸收 `fsGetter.ts` 内容）
- Modify: `src/fsOnedrive.ts`、`src/main.ts`、`src/settings.ts`（改 import 路径）
- Delete: `src/baseTypesObs.ts`、`src/fsGetter.ts`

**Interfaces:**
- Consumes: spec §4.5 B-合并表
- Produces: `src/baseTypes.ts` 含原 `API_VER_ENSURE_REQURL_OK`/`VALID_REQURL`；`src/fsAll.ts` 含原 `getClient`

- [ ] **Step 1: 把 baseTypesObs.ts 内容并入 baseTypes.ts**

Read `src/baseTypesObs.ts`（11 行：导出 `API_VER_ENSURE_REQURL_OK` 和 `VALID_REQURL` 两个常量）。把这两个常量（及其注释）追加到 `src/baseTypes.ts` 末尾。保持 Apache 许可（两文件均 Apache，许可证干净）。

- [ ] **Step 2: 删 baseTypesObs.ts，改 3 处 import**

```bash
git rm src/baseTypesObs.ts
```
`src/fsOnedrive.ts:20`：
```ts
// 旧: import { VALID_REQURL } from "./baseTypesObs";
import { VALID_REQURL } from "./baseTypes";
```
`src/main.ts:29`：
```ts
// 旧: import { API_VER_ENSURE_REQURL_OK } from "./baseTypesObs";
import { API_VER_ENSURE_REQURL_OK } from "./baseTypes";
```
`src/settings.ts:22`：
```ts
// 旧: import { API_VER_ENSURE_REQURL_OK, VALID_REQURL } from "./baseTypesObs";
import { API_VER_ENSURE_REQURL_OK, VALID_REQURL } from "./baseTypes";
```

- [ ] **Step 3: 把 fsGetter.ts 内容并入 fsAll.ts**

Read `src/fsGetter.ts`（22 行：导出 `getClient` 函数）。把 `getClient` 函数（及其依赖的 import）追加到 `src/fsAll.ts`。`fsAll.ts` 已定义 `FakeFs` 接口，`getClient` 返回 `FakeFs` 实例——天然内聚。

- [ ] **Step 4: 删 fsGetter.ts，改 2 处 import**

```bash
git rm src/fsGetter.ts
```
`src/main.ts:33`：
```ts
// 旧: import { getClient } from "./fsGetter";
import { getClient } from "./fsAll";
```
`src/settings.ts:28`：
```ts
// 旧: import { getClient } from "./fsGetter";
import { getClient } from "./fsAll";
```

- [ ] **Step 5: 类型检查 + 构建 + 测试**

Run: `npm run build2`; → `npm run build`; → `npm test`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "refactor: merge baseTypesObs→baseTypes, fsGetter→fsAll (eliminate 2 tiny files)"
```

---

## Task 4: i18n 合并为单目录

**Files:**
- Modify: `src/langs/{en,zh_cn,zh_tw}.json`（深合并 pro 内容）、`src/i18n.ts`
- Delete: `pro/src/langs/`（整个目录）

**Interfaces:**
- Consumes: `src/i18n.ts` 当前 `merge(LANGS_BASIC, LANGS_PRO)`（lodash/merge）
- Produces: `src/langs/*.json` 含全部键；`src/i18n.ts` 不再依赖 `../pro/src/langs`

- [ ] **Step 1: 深合并 pro/src/langs 的 JSON 进 src/langs**

对 `en`、`zh_cn`、`zh_tw` 三个 locale 各做一次：
- 读 `pro/src/langs/<locale>.json` 与 `src/langs/<locale>.json`
- 把 pro 文件的**每一个顶层键**（如 `setting_smart_conflict_description` 等 smart_conflict/clear_dup_files 特性键）加进 src 文件。pro 键与 basic 键不冲突（运行时 merge 已验证）。
- 用 `JSON.stringify(obj, null, 2) + "\n"` 写回（保持 2 空格缩进 + 末尾换行）。

可脚本化：
```bash
node -e "
const fs=require('fs');const locs=['en','zh_cn','zh_tw'];
for(const l of locs){const b=require('./src/langs/'+l+'.json');const p=require('./pro/src/langs/'+l+'.json');const out=Object.assign({},b,p);fs.writeFileSync('./src/langs/'+l+'.json',JSON.stringify(out,null,2)+'\n');}
"
```
（`Object.assign` 是浅合并；pro 顶层键是扁平特性键，浅合并已足够。若发现嵌套键，改用 `lodash.merge` 手动一次性合并。）

- [ ] **Step 2: 核实键集不丢**

Run: `node -e "const l=require('./src/langs/en.json');console.log('smart_conflict' in JSON.stringify(l)?'Y':'N')"`（或直接 grep `smart_conflict\|clear_dup` in `src/langs/en.json`）
Expected: 命中——pro 键已并入。

- [ ] **Step 3: 删 pro/src/langs/ 目录**

```bash
git rm -r pro/src/langs
```

- [ ] **Step 4: 精简 src/i18n.ts（去掉 merge 与 LANGS_PRO）**

对 `src/i18n.ts` 做 4 处外科手术式编辑（不要重写整个文件——其余行保持原样）：

1. **删除第 1 行**：
   ```ts
   import merge from "lodash/merge";
   ```
2. **删除第 5 行**：
   ```ts
   import { LANGS as LANGS_PRO } from "../pro/src/langs";
   ```
3. **改第 6 行**：
   ```ts
   // 旧: import { LANGS as LANGS_BASIC } from "./langs";
   import { LANGS } from "./langs";
   ```
4. **删除第 8 行**：
   ```ts
   const LANGS = merge(LANGS_BASIC, LANGS_PRO);
   ```

编辑后，`LANGS` 来自 import（不再需要局部 const），`merge`/`LANGS_BASIC`/`LANGS_PRO` 不再被引用，删除安全。文件其余部分（`I18n` 类、`_get`、`t` 等）**一字不改**。预期最终文件约 44 行。

- [ ] **Step 5: 类型检查 + 构建 + 测试**

Run: `npm run build2`; → `npm run build`; → `npm test`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "refactor(i18n): merge pro/langs into src/langs, drop LANGS_PRO merge"
```

---

## Task 5: PolyForm 许可证注释 + LICENSE.pro

**Files:**
- Create: `LICENSE.pro`（根目录，从 `pro/LICENSE` 复制）
- Modify: `src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts`（仅加顶部注释，逻辑不动）
- Delete: `pro/LICENSE`

**Interfaces:**
- Consumes: `pro/LICENSE`（PolyForm Strict 1.0.0 原文）
- Produces: 根 `LICENSE.pro`；5 文件顶部许可证注释

- [ ] **Step 1: 移动 LICENSE 文件**

```bash
git mv pro/LICENSE LICENSE.pro
```

- [ ] **Step 2: 给 5 个 PolyForm 文件加顶部注释**

在 `src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts` 的**第 1 行之前**插入：
```ts
// License: PolyForm Strict 1.0.0 (source-available). See LICENSE.pro.

```
（纯注释，不改任何代码逻辑。）

- [ ] **Step 3: 类型检查（注释不影响类型，但跑一遍防意外）**

Run: `npm run build2`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs(license): move pro/LICENSE→LICENSE.pro + add PolyForm header to 5 moved files"
```

---

## Task 6: 配置清理

**Files:**
- Modify: `tsconfig.json`、`package.json`

**Interfaces:**
- Consumes: spec §4.3
- Produces: 干净的 tsconfig include；正确的 package.json source + test glob

- [ ] **Step 1: 修 tsconfig.json 的 include**

把：
```jsonc
"include": ["src/global.d.ts", "**/*.ts"]
```
改为：
```jsonc
"include": ["**/*.ts"]
```
（`src/global.d.ts` 不存在；`**/*.ts` 已覆盖 src/ + tests/。）

- [ ] **Step 2: 修 package.json 的 source 字段**

把：
```json
"source": "main.ts"
```
改为：
```json
"source": "src/main.ts"
```

- [ ] **Step 3: 修 package.json 的 test 脚本**

把：
```json
"test": "mocha --import=tsx 'tests/**/*.ts' 'pro/tests/**/*.ts'"
```
改为：
```json
"test": "mocha --import=tsx 'tests/**/*.ts'"
```
（`pro/tests/*` 已并入 `tests/`。）

- [ ] **Step 4: 类型检查 + 构建 + 测试**

Run: `npm run build2`; → `npm run build`; → `npm test`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: fix stale tsconfig include + package.json source/test glob"
```

---

## Task 7: 文档清理 + pro/ 目录解散

**Files:**
- Modify: `AGENTS.md`（重写）
- Delete: `pro/README.md`、`pro/src/add_new_service.md`、`docs/remote_services/{googledrive,box,pcloud,yandexdisk,koofr,azureblobstorage,onedrivefull}/`、`pro/` 目录本身

**Interfaces:**
- Consumes: spec §4.7
- Produces: OneDrive-only 扁平架构的 AGENTS.md

- [ ] **Step 1: 删 stale 文档/文件夹**

```bash
git rm pro/README.md
git rm pro/src/add_new_service.md
git rm -r docs/remote_services/googledrive
git rm -r docs/remote_services/box
git rm -r docs/remote_services/pcloud
git rm -r docs/remote_services/yandexdisk
git rm -r docs/remote_services/koofr
git rm -r docs/remote_services/azureblobstorage
git rm -r docs/remote_services/onedrivefull
```
（保留 `docs/remote_services/onedrive/`。若 onedrive/ 内容也已 stale，核实后单独处理。）

- [ ] **Step 2: 删空的 pro/ 目录**

确认 `pro/` 已空（src/ 和 tests/ 都清空）：
```bash
git rm -r pro
```

- [ ] **Step 3: 重写根 AGENTS.md**

把 `AGENTS.md` 重写为 OneDrive-only 扁平 `src/`、无 `pro/` 的现实。要点：
- 删除所有已剥服务的提及（S3/Dropbox/WebDAV/Webdis/Google Drive/Box/pCloud/Yandex/Koofr/Azure Blob/OneDrive Full）
- 删除 `pro/` 目录的所有引用（它已不存在）
- 删除 Dropbox/Google/Box/pCloud/Yandex/Koofr/RemotelySave 的环境变量说明
- `pro/src/fs*.ts` 列表删除
- 架构段改为：`src/` 扁平，存活模块（fsOnedrive/fsLocal/fsAll/fsEncrypt/sync/conflictLogic/fileContentHistory/clearDupFiles/settingsClearDupFiles/main/settings/...）
- 许可证段：标注 `src/` 中 5 个文件为 PolyForm Strict（见 `LICENSE.pro`），其余 Apache
- 命令/构建/约定段保留（仍适用）

- [ ] **Step 4: 核实 manifest 身份（不改）**

Run: `grep -E "\"id\"|\"name\"" manifest.json manifest-beta.json`
Expected: `id` = `remotely-save-onedrive`，`name` 含 `OneDrive`。若**未**改名，**停止并报告**（不擅自改身份）。若已改名，跳过。

- [ ] **Step 5: 类型检查 + 构建 + 测试（文档改不影响，但跑一遍防意外）**

Run: `npm run build2`; → `npm run build`; → `npm test`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "docs: rewrite AGENTS.md to OneDrive-only flat reality + dissolve pro/ dir + delete stale service docs"
```

---

## Task 8: 最终验证 + grep 审计

**Files:** 无改动（纯验证；若审计发现残留则回填前序任务）

- [ ] **Step 1: 类型检查 + 构建 + 测试**

Run: `npm run build2`; → `npm run build`; → `npm test`
Expected: 全 PASS。

- [ ] **Step 2: 悬空引用审计**

Run: `grep -rE "\.\./pro/|pro/src" src/ tests/`
Expected: 零命中。

- [ ] **Step 3: 死服务名审计**

Run: `grep -rEi "koofr|yandex|googledrive|pcloud|azureblob|dropbox|webdav|webdis|onedrivefull" src/`
Expected: 零命中（注释/字符串里的端点 URL 除外——人工核）。

- [ ] **Step 4: stale 全局审计**

Run: `grep -rE "DEFAULT_(GOOGLEDRIVE|BOX|PCLOUD|YANDEXDISK|KOOFR|REMOTELYSAVE|AZURE)" src/`
Expected: 零命中。

- [ ] **Step 5: i18n 键完整性审计**

Run: `grep -c "smart_conflict\|clear_dup" src/langs/en.json`
Expected: ≥1（pro 键已并入）。

- [ ] **Step 6: pro/ 目录已消失审计**

Run: `Test-Path pro`（PowerShell）或 `ls pro`
Expected: 不存在。

- [ ] **Step 7: 若全绿，确认无需补交**

```bash
git status --short
```
Expected: clean（或仅剩与本次重构无关的预存改动）。

---

## Self-Review（writing-plans 内置检查）

**1. Spec coverage**（spec §4 各节 → task）：
- §4.1 扁平 src/ → Task 1（移动不分子目录）✓
- §4.2 模块迁移+重命名 → Task 1 ✓
- §4.3 死代码+stale 配置 → Task 2（死代码）+ Task 6（配置）✓
- §4.4 i18n 合并 → Task 4 ✓
- §4.5 import 改写 → Task 1（14 跨边界+内部）+ Task 3（B 合并 5 处）✓
- §4.6 许可证 → Task 5 ✓
- §4.7 文档 → Task 7 ✓
- §5 验证 → Task 8（+ 各 task 内 build2/test 门）✓

**2. Placeholder scan**：无 TBD/TODO；每步含具体命令或代码。i18n 合并 Step 1 给了脚本 + 备选 lodash.merge 说明。AGENTS.md 重写 Step 3 给了要点清单（文档重写非代码，要点清单是具体指令非占位）。

**3. Type consistency**：
- `MERGABLE_SIZE` 在 Task 1 Step 5 内联进 conflictLogic，Task 2 删 baseTypesPro —— 顺序正确（先移走再删）✓
- `fileContentHistory` 命名在 Task 1 Step 1（git mv 重命名）+ Step 4（sync.ts import 改 `./fileContentHistory`）一致 ✓
- `getClient` 在 Task 3 Step 3 并入 fsAll，Step 4 改 main/settings import 一致 ✓
- i18n.ts 最终态在 Task 4 Step 4 完整给出 ✓
