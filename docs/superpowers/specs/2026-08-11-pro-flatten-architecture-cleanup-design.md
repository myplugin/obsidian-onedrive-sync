# pro/ 展平 + 架构清理 重构设计稿

- **日期**: 2026-08-11
- **状态**: 已通过用户审批（逐节确认 + 进一步精简范围确认 A+B，不拆 settings.ts）
- **项目**: `E:\Code\others\obsidian-remotely-save\remotely-save-onedrive`（OneDrive 专用分叉）
- **前序文档**: `2026-08-10-remotely-save-onedrive-refactor-design.md`（上次重构，方案 A，决定保留 `pro/`）
- **本次范围**: 覆盖旧稿"保留 `pro/`"的决定——展平 `pro/` + 全面清理残留 + 进一步精简

---

## 1. 背景与动机

上次重构（2026-08-10）选了**方案 A — 保留 `pro/` 目录**（PolyForm 许可证理由），并标注"已通过用户审批"，把"不把 `sync.ts` 迁出 `pro/`"列为 YAGNI 非目标。但用户实际意图一直是**展开 `pro/` 目录**（"上次移植时就要求展开 PRO 目录"）。两者矛盾，本次明确覆盖旧决定：**展平 `pro/`**。

用户目标：在**保持功能不变**的前提下，做架构优化，使代码"清晰、简单、易维护、易测试和验收"。所谓"金融代码"指 `pro/` 原有的商业账号/订阅门禁（`account.ts` / `settingsPro.ts`），已在上次 prune 中删除——recon 确认零金融残留。目前 `pro/` 只剩 sync 引擎 + smart_conflict + cleardup + oauth2 + baseTypesPro，以及一批死代码和 stale 文档。

## 2. 已确认决策（来自澄清问答）

| 决策项 | 结果 |
|---|---|
| `pro/` 目录 | **展平**（覆盖旧稿"保留"决定）。`pro/src/*.ts` 全部并入扁平 `src/`，`pro/` 目录整体解散 |
| `sync.ts` 内部逻辑 | 一行不改（仅 import 路径改写 + 顶部许可证注释） |
| 进一步精简范围 | **A+B**：删 3 个死文件 + 2 个许可证干净的合并；**不拆** `settings.ts`（沿用旧稿 YAGNI） |
| 许可证 | PolyForm Strict 代码迁移后许可不变；`pro/LICENSE` → 根 `LICENSE.pro`；迁移文件加顶部注释 |
| 目录结构 | **扁平 `src/`**，不引入子目录（沿用既有扁平约定） |
| 文档清理 | stale 文档删除；根 `AGENTS.md` 重写为 OneDrive-only 扁平现实 |
| manifest/身份改名 | 假设上次 prune 已做，本次**仅核实**，不改（除非用户追加） |

## 3. 目标与非目标

### 目标
- `pro/` 目录整体解散：存活代码并入 `src/`，死代码删除，`pro/tests` 并入 `tests/`
- 消除 `src/`↔`pro/` 这道人为边界及 `../../src/`、`../pro/src/` 相对路径杂技
- 删除死代码：`koofrApi.d.ts`（9952行）、`yandexApi.ts`（278行）、`oauth2.ts`（25行，零引用）、`fsMock.ts`（50行，零引用）
- 消除 `baseTypesPro.ts`（仅 `MERGABLE_SIZE` 存活，移入消费者）
- 合并两个超小共享模块：`baseTypesObs.ts`→`baseTypes.ts`、`fsGetter.ts`→`fsAll.ts`
- 合并 i18n 为单目录，去掉 `LANGS_PRO` merge
- 修 stale 配置（`tsconfig.json`、`package.json`）
- 重写 stale 文档（`AGENTS.md`、`pro/README.md`、`pro/src/add_new_service.md`、`docs/remote_services/*` 已剥服务）
- 行为不变：仅移动/删除/路径改写/注释，不改逻辑

### 非目标（YAGNI）
- 不重写 `sync.ts` 内部逻辑（1955行核心引擎）
- 不拆分 `settings.ts`（1551行，旧稿已列为 YAGNI 非目标）
- 不拆分 `main.ts`（1215行，唯一 stateful 文件，约定如此）
- 不引入 `src/` 子目录
- 不做 OneDrive API 现代化（那是旧稿 §4.2 的独立工作）
- 不做 manifest/身份改名（除非用户追加）

## 4. 设计详情

### 4.1 目标结构 — 扁平 src/，无子目录

`pro/` 目录**整体解散**。所有存活代码并入现有**扁平** `src/`。

`src/` 本就是扁平结构（30 文件），且 AGENTS.md 把"src/misc.ts 不依赖任何内部模块"等约束写进了扁平约定。引入子目录会破坏约定、成倍增加 import 改写量。架构收益来自消除 `pro/` 边界本身，而非新增分组。

### 4.2 模块迁移 + 重命名

**`pro/src/` → `src/` 迁移表：**

| pro/src 文件 | 去向 | 说明 |
|---|---|---|
| `sync.ts` (1955) | `src/sync.ts` | 名字不变；逻辑一行不改；加 PolyForm 顶部注释 |
| `conflictLogic.ts` (351) | `src/conflictLogic.ts` | 加 PolyForm 注释；**吸收 `MERGABLE_SIZE` 常量**（从 baseTypesPro 移入，删原 import） |
| `clearDupFiles.ts` (27) | `src/clearDupFiles.ts` | 加 PolyForm 注释；独立用户命令，保留 |
| `settingsClearDupFiles.ts` (81) | `src/settingsClearDupFiles.ts` | 加 PolyForm 注释 |
| `localdb.ts` (43) | **`src/fileContentHistory.ts`** | **强制重命名**：`src/localdb.ts` 已存在（localforage 包装器，553行）；`sync.ts` 同时 import 两者，不重命名会在展平后产生两个 `./localdb` 冲突。唯一消费者是 `sync.ts`（验证：`sync.ts:42-45, 1412-1619`） |
| `oauth2.ts` (25) | **删除** | 全仓零 `import "...oauth2"`；PKCE 在 main/fsOnedrive 内联。`oauth2` 字样命中均为 Koofr API 类型（已删）或 `oauth2Info` 字段/URL 字符串，与模块无关 |
| `baseTypesPro.ts` (~40) | **删除** | `PRO_FEATURE_TYPE`/`FeatureInfo` 仅自引用（账号门禁已删→死）；`MERGABLE_SIZE` 移入 `conflictLogic.ts`（唯一消费者，:20） |
| `koofrApi.d.ts` (9952) | **删除** | 全仓零引用，auto-generated Koofr OpenAPI 类型 |
| `yandexApi.ts` (278) | **删除** | 全仓零引用，Yandex Disk API 类型 |
| `add_new_service.md` | **删除** | 引用不存在的 `generateProSettingsPart.ts` |
| `langs/{en,zh_cn,zh_tw}.json` | **内容合并**进 `src/langs/` 对应文件 | 见 4.4 |

**`pro/tests/` → `tests/`：**
- `conflictLogic.test.ts` → `tests/conflictLogic.test.ts`
- `sync.test.ts` → `tests/sync.test.ts`
- 两文件的 `../src/X` import 从 `tests/` 仍指向根 `src/`——展平后目标就在根 `src/`，**零改写**。

**`src/` 内进一步精简（B 合并）：**

| 操作 | 许可证 | 理由 |
|---|---|---|
| `baseTypesObs.ts` (11) → 合并入 `baseTypes.ts`；删 `baseTypesObs.ts` | Apache+Apache | 3 消费者（`fsOnedrive:20`、`main:29`、`settings:22`）改 `./baseTypesObs`→`./baseTypes`；Obsidian API 版本常量并入主类型文件 |
| `fsGetter.ts` (22) → 合并入 `fsAll.ts` (60)；删 `fsGetter.ts` | Apache+Apache | `fsAll` 定义 `FakeFs` 接口，`fsGetter` 返回一个 `FakeFs` 实例——天然内聚；2 消费者（`main:33`、`settings:28`）改 `./fsGetter`→`./fsAll` |
| `fsMock.ts` (50) → **删除** | — | 全仓零 import；测试消费者在上次 prune 删 pro 服务时一并删了 |

**净效果**：`src/` 从 30 文件 → 32 文件（吸收 pro/ 全部存活代码 + 净减 3 个小文件），而非不精简时的 37 个。`baseTypesPro`/`oauth2`/`fsMock` 彻底消失。

### 4.3 死代码 + stale 配置清理

- 删 `pro/src/{koofrApi.d.ts, yandexApi.ts, oauth2.ts}` + `src/fsMock.ts` + `pro/src/baseTypesPro.ts`（上述）
- 删 `baseTypesPro.ts` 里 12 个 `DEFAULT_*` 全局声明（webpack/esbuild 都不注入，纯死声明；随文件删除一并消失）
- `tsconfig.json`：`include` 里去掉不存在的 `src/global.d.ts`；`**/*.ts` 已覆盖一切
- `package.json`：修 stale `"source": "main.ts"`（指错，真实入口在 webpack `entryPoints`）→ 改 `"src/main.ts"`
- `package.json` test 脚本：`'tests/**/*.ts' 'pro/tests/**/*.ts'` → `'tests/**/*.ts'`

### 4.4 i18n 合并为单目录

- 把 `pro/src/langs/{en,zh_cn,zh_tw}.json` 的字符串**深合并**进 `src/langs/{en,zh_cn,zh_tw}.json`（pro 的 `smart_conflict`/`clear_dup_files` 键并入）
- 删 `pro/src/langs/`
- 精简 `src/i18n.ts`：去掉 `LANGS_PRO` import 和 `merge(LANGS_BASIC, LANGS_PRO)` 调用，直接 `import { LANGS } from "./langs"`

### 4.5 Import 改写（机械，共 14 条跨边界 + 若干内部 + B 合并）

**src/ → pro/（5 条）：`../pro/src/X` → `./X`**
| 文件:行 | 原 | 新 |
|---|---|---|
| `src/main.ts:19` | `../pro/src/sync` | `./sync` |
| `src/settings.ts:21` | `../pro/src/settingsClearDupFiles` | `./settingsClearDupFiles` |
| `src/i18n.ts:5` | `../pro/src/langs` | 移除（直接用 `./langs`，无 merge） |
| `src/localdb.ts:9` | `../pro/src/sync` | `./sync`（type SyncPlanType） |
| `src/debugMode.ts:3` | `../pro/src/sync` | `./sync`（type SyncPlanType） |

**pro/src/ → src/（9 条，文件移入 src/ 后其 import 变 `./X`）：`../../src/X` → `./X`**
| 文件:行 | 原 | 新 |
|---|---|---|
| `sync.ts:14` | `../../src/baseTypes` | `./baseTypes` |
| `sync.ts:15` | `../../src/copyLogic` | `./copyLogic` |
| `sync.ts:16` | `../../src/fsAll` | `./fsAll` |
| `sync.ts:17` | `../../src/fsEncrypt` | `./fsEncrypt` |
| `sync.ts:24` | `../../src/localdb` | `./localdb`（localforage 包装器——正确，sync 用 `InternalDBs`） |
| `sync.ts:28` | `../../src/metadataOnRemote` | `./metadataOnRemote` |
| `sync.ts:38` | `../../src/misc` | `./misc` |
| `sync.ts:39` | `../../src/profiler` | `./profiler` |
| `conflictLogic.ts:17` | `../../src/baseTypes` | `./baseTypes` |
| `conflictLogic.ts:18` | `../../src/copyLogic` | `./copyLogic` |
| `conflictLogic.ts:19` | `../../src/fsAll` | `./fsAll` |
| `fileContentHistory.ts:1` | `../../src/baseTypes` | `./baseTypes` |
| `fileContentHistory.ts:2` | `../../src/localdb` | `./localdb`（localforage——正确，本文件已重命名故无冲突） |
| `settingsClearDupFiles.ts:2` | `../../src/fsLocal` | `./fsLocal` |
| `settingsClearDupFiles.ts:3` | `../../src/i18n` | `./i18n` |
| `settingsClearDupFiles.ts:4` | `../../src/main` | `./main` |
| `settingsClearDupFiles.ts:5` | `../../src/misc` | `./misc` |
| `clearDupFiles.ts:1` | `../../src/fsLocal` | `./fsLocal` |

**pro/src 内部（重命名相关）：**
| 文件:行 | 原 | 新 |
|---|---|---|
| `sync.ts:42-45` | `./localdb`（= fileContentHistory） | `./fileContentHistory` |
| `conflictLogic.ts:20` | `./baseTypesPro`（`MERGABLE_SIZE`） | **移除**（常量改为本文件顶部 `const MERGABLE_SIZE = 1000 * 1000;`） |
| `settingsClearDupFiles.ts:1` | `./clearDupFiles` | 不变（同在 src/） |
| `clearDupFiles.ts:2` | `./conflictLogic` | 不变（同在 src/） |

**B 合并引发的 import 改写：**
| 文件:行 | 原 | 新 |
|---|---|---|
| `src/fsOnedrive.ts:20` | `./baseTypesObs` | `./baseTypes` |
| `src/main.ts:29` | `./baseTypesObs` | `./baseTypes` |
| `src/settings.ts:22` | `./baseTypesObs` | `./baseTypes` |
| `src/main.ts:33` | `./fsGetter` | `./fsAll` |
| `src/settings.ts:28` | `./fsGetter` | `./fsAll` |

**构建配置**：`webpack.config.js` / `esbuild.config.mjs` / `biome.json` / `.github/workflows/*.yml` 均无 `pro/` 路径字面量，**零改动**（recon 已确认）。

### 4.6 许可证保全（PolyForm Strict）

- `pro/LICENSE` → 根目录 `LICENSE.pro`（原文保留，不改）
- 7 个迁移文件各加**顶部注释**（纯注释，逻辑不动）：
  ```
  // License: PolyForm Strict 1.0.0 (source-available). See LICENSE.pro.
  ```
  适用：`sync.ts`、`conflictLogic.ts`、`fileContentHistory.ts`、`clearDupFiles.ts`、`settingsClearDupFiles.ts`
  （`oauth2.ts`/`baseTypesPro.ts` 删除，不需注释）
- 这也是不合并 `baseTypesPro.ts` 进 `baseTypes.ts` 的原因：整文件 PolyForm 许可归属清晰；合并进 Apache 文件会许可证混淆。本次直接删除 `baseTypesPro.ts`，把唯一存活常量 `MERGABLE_SIZE` 移入同样 PolyForm 的 `conflictLogic.ts`——许可证干净。

### 4.7 文档清理

- **重写根 `AGENTS.md`**：改为 OneDrive-only、扁平 `src/`、无 `pro/` 的现实——删掉所有已剥服务（S3/Dropbox/WebDAV/Webdis/Google Drive/Box/pCloud/Yandex/Koofr/Azure Blob/OneDrive Full）、`pro/` 引用、对应环境变量、`pro/src/fs*.ts` 列表
- **删** `pro/README.md`（宣传已剥服务）、`pro/src/add_new_service.md`（stale）
- **删** `docs/remote_services/{googledrive,box,pcloud,yandexdisk,koofr,azureblobstorage,onedrivefull}/` 7 个文件夹
- **保留** `docs/remote_services/onedrive/`（如内容准确）
- **核实**：manifest/身份改名（id→`remotely-save-onedrive`）是否上次 prune 已做；已做则跳过，未做则报告（不擅自改）

## 5. 验证（行为不变）

| 项 | 命令 | 通过标准 |
|---|---|---|
| 类型检查 | `npm run build2`（含 `tsc -noEmit -skipLibCheck`） | 零类型错误、零悬空 import |
| 生产构建 | `npm run build`（webpack） | 生成 `main.js` 无报错 |
| 测试 | `npm test`（mocha + tsx） | 全部现有测试通过（`pro/tests` 已并入 `tests/`，glob 已精简） |
| 悬空引用 | grep `../pro/\|pro/src` in `src/` | 零命中 |
| 死服务名 | grep `koofr\|yandex\|googledrive\|box\|pcloud\|azureblob` in `src/` | 零命中 |
| stale 文档 | grep 已剥服务名 in `AGENTS.md`/`docs/` | 零命中 |

**诚实说明**：`koofrApi.d.ts`（类型声明，编译期擦除）、`yandexApi.ts`（零引用，已被 tree-shake）、`oauth2.ts`/`fsMock.ts`（零引用）的删除**不会缩小 `main.js`**——本次收益是源码树清晰度，不是包体积。真机同步验证（旧稿 §4.4）是用户验收关，无法自动化。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `pro/src/localdb.ts` 与 `src/localdb.ts` 重名 | 展平后 `sync.ts` 两个 `./localdb` 冲突 | 强制重命名为 `fileContentHistory.ts`（已验证唯一消费者是 sync.ts） |
| `baseTypesPro.ts` 误删存活声明 | 类型缺失 | grep 已确认仅 `MERGABLE_SIZE` 存活（1 消费者）；移入 conflictLogic 后再删 |
| PolyForm 许可证归属模糊 | 分发合规风险 | `LICENSE.pro` + 每文件顶部注释；`MERGABLE_SIZE` 仅在 PolyForm 文件间移动 |
| `sync.ts` import 改写笔误 | 编译失败 | `build2` typecheck 每步验证；sync.ts 内部逻辑零改动 |
| i18n 深合并丢键 | 翻译缺失 | 合并后对比键集；`npm test` 覆盖 misc；手动核 `smart_conflict`/`clear_dup_files` 键 |
| stale 文档误删有用内容 | 文档丢失 | 删的是描述已剥服务的内容（与 OneDrive fork 无关）；`AGENTS.md` 重写后保留 OneDrive 扁平架构说明 |

## 7. 实现顺序建议（供 writing-plans 参考）

1. **移动 + 重命名**（机械、低风险）：`pro/src/*.ts` → `src/`（含 `localdb.ts`→`fileContentHistory.ts` 重命名）；`pro/tests/*` → `tests/`；`pro/LICENSE` → `LICENSE.pro`
2. **删死代码**：`koofrApi.d.ts`、`yandexApi.ts`、`oauth2.ts`、`fsMock.ts`、`baseTypesPro.ts`（先把 `MERGABLE_SIZE` 移入 `conflictLogic.ts`）
3. **B 合并**：`baseTypesObs.ts`→`baseTypes.ts`；`fsGetter.ts`→`fsAll.ts`
4. **import 改写**：按 4.5 表逐条改（14 跨边界 + 内部重命名 + B 合并）
5. **i18n 合并**：深合并 JSON、删 `pro/src/langs/`、精简 `i18n.ts`
6. **PolyForm 注释**：给 5 个迁移文件加顶部许可证注释
7. **配置清理**：`tsconfig.json`、`package.json`（source + test glob）
8. **文档清理**：重写 `AGENTS.md`、删 stale 文档/文件夹、核实 manifest 身份
9. **验证**：`npm run build2` → `npm run build` → `npm test` → grep 审计
10. **commit**：分阶段提交（移动/删除/改写/文档），便于回溯

## 8. 备注

- 本稿与旧稿 `2026-08-10-remotely-save-onedrive-refactor-design.md` 的关系：旧稿决定"保留 pro/"，本稿覆盖为"展平"。旧稿的 OneDrive API 现代化（§4.2）、设置 UI 5 分区重组（§4.3.1）属独立工作，**不在本次范围**。
- `2026-08-11-regex-list-settings-ui-design.md` 也是独立 UI 特性，不在本次范围。
- 本次纯属架构清理：移动 + 删除 + 路径改写 + 注释 + 文档，行为不变。
