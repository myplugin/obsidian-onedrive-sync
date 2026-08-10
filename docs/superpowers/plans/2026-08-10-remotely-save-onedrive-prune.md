# Remotely Save (OneDrive) 精简重构实现计划 — Plan A (Prune)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `remotely-save` 源项目重构为专注 OneDrive 个人版的 `remotely-save-onedrive` 插件——删除 11 个非 OneDrive 服务、解锁 Smart Conflict/ClearDupFiles、设置 UI 重组为 5 分区、改名为 `remotely-save-onedrive`。

**Architecture:** 在工作目录复制源项目，然后机械删除非 OneDrive 服务的文件/依赖/类型/注册表/设置块，移除 pro 账号门禁（让 smart_conflict/cleardup 直接可用），重组设置 UI。`pro/src/sync.ts` 核心引擎零改动。每个任务以构建通过 + 无悬空引用为验证周期。

**Tech Stack:** TypeScript, Obsidian Plugin API, webpack (主构建) + esbuild (备用), Biome (格式), mocha+tsx (测试)。

## Global Constraints

- **源项目**: `E:\Code\others\obsidian-remotely-save\remotely-save` (v0.5.25)
- **目标工作目录**: `E:\Code\others\obsidian-remotely-save\remotely-save-onedrive` (当前为空)
- **保留 `pro/` 文件夹**（PolyForm Strict 许可证，个人使用 OK；`sync.ts`/`conflictLogic.ts`/`localdb.ts`/`clearDupFiles.ts`/`oauth2.ts` 保留）
- **Biome 风格**: 2 空格缩进, LF, 80 列, 双引号, 分号, `es5` 尾逗号；`any` 和非空断言可接受，不要"修复"它们
- **版本号同步**: `package.json` / `manifest.json` / `manifest-beta.json` 保持一致，新版本 `0.6.0`
- **不改 `pro/src/sync.ts` 内部**（2094 行核心引擎）
- **文件夹字符串**总是以 `/` 结尾
- **`src/misc.ts`** 不得依赖任何内部模块
- **存储模块**（`fs*.ts`）不得 import `sync.ts`
- webpack 与 esbuild 配置的 `DEFAULT_*` 定义必须保持一致

## File Structure

**删除的文件（共 21 个）：**
- `pro/src/fsGoogleDrive.ts`, `pro/src/settingsGoogleDrive.ts`
- `pro/src/fsBox.ts`, `pro/src/settingsBox.ts`
- `pro/src/fsPCloud.ts`, `pro/src/settingsPCloud.ts`
- `pro/src/fsYandexDisk.ts`, `pro/src/settingsYandexDisk.ts`
- `pro/src/fsKoofr.ts`, `pro/src/settingsKoofr.ts`
- `pro/src/fsAzureBlobStorage.ts`, `pro/src/settingsAzureBlobStorage.ts`
- `pro/src/fsOnedriveFull.ts`, `pro/src/settingsOnedriveFull.ts`
- `pro/src/account.ts`, `pro/src/settingsPro.ts`
- `src/fsS3.ts`, `src/fsDropbox.ts`, `src/fsWebdav.ts`, `src/fsWebdis.ts`

**修改的文件：**
- `manifest.json`, `manifest-beta.json`, `versions.json`, `package.json` — 身份 + 版本
- `webpack.config.js`, `esbuild.config.mjs`, `.env.example.txt` — 构建配置
- `src/baseTypes.ts` — `SUPPORTED_SERVICES_TYPE` 精简
- `pro/src/baseTypesPro.ts` — `PRO_FEATURE_TYPE` 精简
- `src/main.ts` — `DEFAULT_SETTINGS` + imports + 协议回调 + pro 门禁调用
- `src/fsGetter.ts` — `getClient` switch 精简
- `src/settings.ts` — 删服务块 + 5 分区重组
- `pro/src/sync.ts` — 仅删除 `checkProRunnableAndFixInplace` 调用点（不动核心逻辑）
- `pro/src/conflictLogic.ts` — 若有门禁引用则移除（核实）

---

### Task 1: 脚手架 — 复制源项目 + 改名

**Files:**
- Create: 整个工作目录的源项目副本（排除 `.git/`, `node_modules/`, `main.js`, `data.json`）
- Modify: `manifest.json`, `manifest-beta.json`, `package.json`, `versions.json`

**Interfaces:**
- Produces: 一个可构建的、改名的源项目副本（功能与原版相同，仅身份不同）

- [ ] **Step 1: 复制源项目到工作目录（排除 .git/node_modules/main.js/data.json）**

Run (PowerShell):
```powershell
$src = "E:\Code\others\obsidian-remotely-save\remotely-save"
$dst = "E:\Code\others\obsidian-remotely-save\remotely-save-onedrive"
robocopy $src $dst /E /XD .git node_modules /XF main.js data.json
```
Expected: 工作目录填满源项目文件，无 `.git/`/`node_modules/`/`main.js`/`data.json`。

- [ ] **Step 2: 改 manifest.json 身份**

Modify `manifest.json`:
```json
{
  "id": "remotely-save-onedrive",
  "name": "Remotely Save (OneDrive)",
  "version": "0.6.0",
  "minAppVersion": "0.13.21",
  "description": "Sync your Obsidian vault with OneDrive (personal, App Folder).",
  "author": "refactored",
  "isDesktopOnly": false
}
```
（删除 `authorUrl` 和 `fundingUrl` 字段——无 pro 付费。）

- [ ] **Step 3: 改 manifest-beta.json 同步**

Modify `manifest-beta.json`：与 `manifest.json` 相同的 `id`/`name`/`version`/`description` 改动。

- [ ] **Step 4: 改 package.json name + version**

Modify `package.json`:
- `"name": "remotely-save-onedrive"`
- `"version": "0.6.0"`

- [ ] **Step 5: versions.json 新增版本条目**

Modify `versions.json`：新增 `"0.6.0": "0.13.21"` 条目（key 是插件版本，value 是 minAppVersion）。

- [ ] **Step 6: 安装依赖 + 验证构建通过**

Run:
```powershell
npm install
npm run build2
```
Expected: `tsc -noEmit -skipLibCheck` 无错误，esbuild 生成 `main.js`。此时插件功能与原版相同（仅改名），构建通过证明副本完整。

- [ ] **Step 7: Commit**

```powershell
git init; git add -A
git commit -m "chore: scaffold remotely-save-onedrive fork from v0.5.25 (renamed)"
```

---

### Task 2: 删除 11 个非 OneDrive 服务的源文件

**Files:**
- Delete: 21 个文件（见 File Structure 的删除清单）

**Interfaces:**
- Produces: 工作目录不再含非 OneDrive 服务的实现文件（此时会有悬空 import，Task 3 修复）

- [ ] **Step 1: 删除 7 个 pro 云盘服务文件 + OneDrive Full + pro 账号系统**

Run:
```powershell
$pro = "pro\src"
Remove-Item "$pro\fsGoogleDrive.ts","$pro\settingsGoogleDrive.ts"
Remove-Item "$pro\fsBox.ts","$pro\settingsBox.ts"
Remove-Item "$pro\fsPCloud.ts","$pro\settingsPCloud.ts"
Remove-Item "$pro\fsYandexDisk.ts","$pro\settingsYandexDisk.ts"
Remove-Item "$pro\fsKoofr.ts","$pro\settingsKoofr.ts"
Remove-Item "$pro\fsAzureBlobStorage.ts","$pro\settingsAzureBlobStorage.ts"
Remove-Item "$pro\fsOnedriveFull.ts","$pro\settingsOnedriveFull.ts"
Remove-Item "$pro\account.ts","$pro\settingsPro.ts"
```
Expected: 16 个文件删除成功。

- [ ] **Step 2: 删除 4 个免费非 OneDrive 服务文件**

Run:
```powershell
Remove-Item "src\fsS3.ts","src\fsDropbox.ts","src\fsWebdav.ts","src\fsWebdis.ts"
```
Expected: 4 个文件删除成功。

- [ ] **Step 3: 验证文件已删除**

Run:
```powershell
Get-ChildItem -Recurse -Filter "fs*.ts" src,pro\src | Select-Object FullName
```
Expected: 仅剩 `fsOnedrive.ts`, `fsLocal.ts`, `fsMock.ts`, `fsAll.ts`, `fsGetter.ts`, `fsEncrypt.ts`（src）+ `sync.ts`（pro 里非 fs 但保留）, `conflictLogic.ts`, `localdb.ts`, `clearDupFiles.ts`, `oauth2.ts`（pro）。无已删服务文件。

- [ ] **Step 4: Commit（此时构建会失败，因为还有悬空 import——这是预期的，Task 3 修复）**

```powershell
git add -A
git commit -m "refactor: delete 11 non-OneDrive service files (dangling imports to fix next)"
```

---

### Task 3: 修复悬空引用 — 类型 + 注册表 + main.ts imports

**Files:**
- Modify: `src/baseTypes.ts:30-42`（`SUPPORTED_SERVICES_TYPE`）
- Modify: `pro/src/baseTypesPro.ts`（`PRO_FEATURE_TYPE`）
- Modify: `src/main.ts:115-157`（`DEFAULT_SETTINGS`）+ imports 区（`main.ts:2-113`）+ 协议回调注册（`main.ts` onload 内）
- Modify: `src/fsGetter.ts:24-83`（`getClient` switch）

**Interfaces:**
- Consumes: Task 2 的删除结果
- Produces: 无悬空引用，`tsc -noEmit` 通过

- [ ] **Step 1: 精简 `SUPPORTED_SERVICES_TYPE`（baseTypes.ts:30-42）**

Modify `src/baseTypes.ts`，把 12 项联合类型改为：
```typescript
export type SUPPORTED_SERVICES_TYPE =
  | "onedrive"
  | "local"
  | "mock";
```
同时删除该文件中 S3/Dropbox/Webdav/Webdis/GoogleDrive/Box/PCloud/YandexDisk/Koofr/AzureBlobStorage/OnedriveFull 对应的配置接口（如 `S3Config`, `DropboxConfig` 等——保留 `OnedriveConfig` 和通用类型）。

- [ ] **Step 2: 精简 `PRO_FEATURE_TYPE`（baseTypesPro.ts）**

Modify `pro/src/baseTypesPro.ts`，把 `PRO_FEATURE_TYPE` 联合改为：
```typescript
export type PRO_FEATURE_TYPE =
  | "feature-smart_conflict"
  | "feature-clear_dup_files";
```
删除 `feature-google_drive`/`feature-onedrive_full`/`feature-box`/`feature-pcloud`/`feature-yandex_disk`/`feature-koofr`/`feature-azure_blob_storage`。同时删除 `ProConfig` 中与已删服务相关的字段（核实——`ProConfig` 主要用于 pro 账号，Task 4 处理账号门禁，这里只删服务类型）。

- [ ] **Step 3: 精简 `getClient` switch（fsGetter.ts:24-83）**

Modify `src/fsGetter.ts`，把 12 case 的 switch 改为仅保留 `onedrive`/`local`/`mock` 三个 case：
```typescript
export const getClient = (serviceType: SUPPORTED_SERVICES_TYPE, ...) => {
  switch (serviceType) {
    case "onedrive":
      return new FakeFsOnedrive(...);
    case "local":
      return new FakeFsLocal(...);
    case "mock":
      return new FakeFsMock(...);
    default:
      throw Error(`unsupported serviceType: ${serviceType}`);
  }
};
```
删除 s3/dropbox/webdav/webdis/googledrive/box/pcloud/yandexdisk/koofr/azureblobstorage/onedrivefull 的 case 和对应 import。

- [ ] **Step 4: 精简 `DEFAULT_SETTINGS`（main.ts:115-157）**

Modify `src/main.ts` 的 `DEFAULT_SETTINGS`：删除 s3/dropbox/webdav/webdis/googledrive/box/pcloud/yandexdisk/koofr/azureblobstorage/onedrivefull 的配置字段，仅保留 `onedrive` 配置 + 通用字段（`serviceType`/`syncDirection`/`conflictAction`/`encryption`/`...`）。把 `serviceType` 默认值从 `"s3"` 改为 `"onedrive"`。

- [ ] **Step 5: 删除 main.ts 顶部已删服务的 import（main.ts:2-113）**

Modify `src/main.ts` imports 区：删除所有 `import ... from "../pro/src/fsGoogleDrive"` / `fsBox` / `fsPCloud` / `fsYandexDisk` / `fsKoofr` / `fsAzureBlobStorage` / `fsOnedriveFull` / `account` / `settingsPro` 等已删文件的 import。保留 `fsOnedrive`/`fsLocal`/`fsMock`/`fsAll`/`fsGetter`/`fsEncrypt` + pro 的 `sync`/`conflictLogic`/`localdb`/`clearDupFiles`/`oauth2` import。

- [ ] **Step 6: 删除 main.ts onload 里的协议回调注册**

Modify `src/main.ts` 的 `onload()`：删除 `COMMAND_CALLBACK_GOOGLEDRIVE`/`COMMAND_CALLBACK_BOX`/`COMMAND_CALLBACK_PCLOUD`/`COMMAND_CALLBACK_YANDEXDISK`/`COMMAND_CALLBACK_KOOFR`/`COMMAND_CALLBACK_AZUREBLOBSTORAGE`/`COMMAND_CALLBACK_ONEDRIVEFULL`/`COMMAND_CALLBACK_PRO` 等已删服务的 `obsidian://` 协议回调注册。保留 `COMMAND_CALLBACK_ONEDRIVE`（免费 OneDrive）和 `COMMAND_CALLBACK_DROPBOX`？——**注意：Dropbox 也删了**，所以也删 `COMMAND_CALLBACK_DROPBOX`。仅保留 `COMMAND_CALLBACK_ONEDRIVE` + `COMMAND_URI`/`COMMAND_CALLBACK`。

- [ ] **Step 7: 类型检查通过**

Run:
```powershell
npm run build2
```
Expected: `tsc -noEmit -skipLibCheck` 无错误。若有错误，按错误信息修复剩余悬空引用（常见：`RemotelySavePluginSettings` 里残留的服务字段、`baseTypesObs.ts` 里的类型守卫、`importExport.ts` 里的 QR 码导出引用了已删服务配置）。

- [ ] **Step 8: 悬空引用 grep 验证**

Run:
```powershell
rg "fsS3|fsDropbox|fsWebdav|fsWebdis|fsGoogleDrive|fsBox|fsPCloud|fsYandexDisk|fsKoofr|fsAzureBlobStorage|fsOnedriveFull|account|settingsPro" src pro\src --type ts
```
Expected: 无对已删文件的 import/引用（`account` 词可能出现在注释里，可忽略；重点是 import 语句和类型引用）。

- [ ] **Step 9: 生产构建通过**

Run:
```powershell
npm run build
```
Expected: webpack 生成 `main.js`，无报错。

- [ ] **Step 10: Commit**

```powershell
git add -A
git commit -m "refactor: fix dangling refs — simplify types, fsGetter, main.ts imports/protocol callbacks"
```

---

### Task 4: 移除 pro 门禁 — 解锁 Smart Conflict + ClearDupFiles

**Files:**
- Modify: `pro/src/sync.ts`（删除 `checkProRunnableAndFixInplace` 调用点）
- Modify: `src/settings.ts`（删除 pro 账号登录 UI 块 + 门禁校验）
- Modify: `src/main.ts`（删除 pro 账号 OAuth 流程调用）
- Modify: `pro/src/baseTypesPro.ts`（`ProConfig` 字段——核实是否还需保留）

**Interfaces:**
- Consumes: Task 3 的类型精简
- Produces: smart_conflict 和 cleardup 无需 pro 账号即可用

- [ ] **Step 1: 定位 `checkProRunnableAndFixInplace` 的所有调用点**

Run:
```powershell
rg "checkProRunnableAndFixInplace" src pro\src --type ts -n
```
Expected: 找到 `pro/src/sync.ts` 和 `src/settings.ts`（可能还有 `src/main.ts`）里的调用点。记录行号。

- [ ] **Step 2: 删除 sync.ts 里的门禁调用**

Modify `pro/src/sync.ts`：删除 `checkProRunnableAndFixInplace(...)` 调用语句（保留周围逻辑，仅移除门禁校验调用 + 其 import）。**不动 sync.ts 的同步算法逻辑**。

- [ ] **Step 3: 删除 settings.ts 里的 pro 账号登录 UI 块 + 门禁校验**

Modify `src/settings.ts`：删除 pro 账号登录/连接的设置块（原 `generateProSettingsPart` 调用——该函数在已删的 `settingsPro.ts` 里）。删除任何 `checkProRunnableAndFixInplace` 调用。smart_conflict 下拉选项保留（不再被门禁拦截）。

- [ ] **Step 4: 删除 main.ts 里的 pro 账号 OAuth 流程**

Modify `src/main.ts`：删除 `getAndSaveProFeatures`/`getAndSaveProEmail` 调用 + pro 账号 token 刷新逻辑（`sendRefreshTokenReq` for pro account——注意区分 OneDrive 的 token 刷新，后者保留）。

- [ ] **Step 5: 处理 `config.pro` 字段**

Modify `src/baseTypes.ts` 的 `RemotelySavePluginSettings`：删除 `pro?: ProConfig` 字段。旧 `data.json` 里的 `pro` 键会被 Obsidian `loadSettings` 自动忽略（多余键无害），无需迁移代码。若 `ProConfig` 类型不再被任何地方引用，从 `baseTypesPro.ts` 删除该接口。

- [ ] **Step 6: 类型检查 + 构建通过**

Run:
```powershell
npm run build2
npm run build
```
Expected: 无错误。

- [ ] **Step 7: 验证 smart_conflict 可选**

在 `src/settings.ts` 的冲突处理分区，确认 `conflictAction` 下拉包含 `"smart_conflict"` 选项，且选择它不再触发任何 pro 账号校验（代码审查——无 `checkProRunnableAndFixInplace` 调用）。

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "feat: ungate Smart Conflict + ClearDupFiles — remove pro account gating"
```

---

### Task 5: 设置 UI 重组为 5 分区

**Files:**
- Modify: `src/settings.ts`（`RemotelySaveSettingTab.display()` 及分区函数）

**Interfaces:**
- Consumes: Task 3-4 的服务块已删
- Produces: 5 个折叠分区的设置界面

- [ ] **Step 1: 重排 `display()` 为 5 个分区函数**

Modify `src/settings.ts` 的 `display()` 方法，调用 5 个分区生成函数：
```typescript
display(): void {
  const { containerEl } = this;
  containerEl.empty();
  containerEl.createEl("h1", { text: "Remotely Save (OneDrive)" });
  this.generateAccountSection(containerEl);      // ① 账户与连接
  this.generateSyncOptionsSection(containerEl);   // ② 同步选项
  this.generateConflictSection(containerEl);     // ③ 冲突处理
  this.generateEncryptionSection(containerEl);   // ④ 加密
  this.generateAdvancedSection(containerEl);     // ⑤ 高级
}
```

- [ ] **Step 2: 实现 ① 账户与连接分区**

`generateAccountSection(containerEl: HTMLElement)`：OneDrive 授权状态（已连接/邮箱 + 断开按钮）、"连接 OneDrive" 按钮。**删除服务选择下拉**（只剩 OneDrive，无需选）。用 `containerEl.createEl("h2", {text: "账户与连接"})` 作分区标题。

- [ ] **Step 3: 实现 ② 同步选项分区**

`generateSyncOptionsSection`：同步方向（双向/仅上传/仅下载）、并发数、自动同步间隔、保存时同步、跳过大文件阈值、跳过路径正则。从原 `settings.ts` 把这些通用字段的 `new Setting(...)` 调用迁移过来。

- [ ] **Step 4: 实现 ③ 冲突处理分区**

`generateConflictSection`：冲突动作下拉（`keep_newer`/`keep_larger`/`smart_conflict`——附说明"合并小 md / 复制大文件"）、ClearDupFiles 入口。smart_conflict 选项不再有 pro 标记。

- [ ] **Step 5: 实现 ④ 加密分区**

`generateEncryptionSection`：密码设置、加密格式（rclone crypt / openssl）。从原 `settings.ts` 迁移加密相关 `Setting`。

- [ ] **Step 6: 实现 ⑤ 高级分区**

`generateAdvancedSection`：配置文件夹同步（.obsidian）、书签同步、隐藏文件规则（./_ 前缀）、状态栏显示、性能分析器、语言、导入/导出设置（QR 码）、调试模式。从原 `settings.ts` 迁移这些 `Setting`。

- [ ] **Step 7: 删除残留的 `xxx-hide` toggle 逻辑**

搜索 `settings.ts` 里的 `-hide` class toggle（原 12 服务的显示/隐藏切换），全部删除（不再有多服务切换）。

- [ ] **Step 8: 类型检查 + 构建通过**

Run:
```powershell
npm run build2
npm run build
```
Expected: 无错误。`settings.ts` 行数从 ~3029 降到 ~600-800。

- [ ] **Step 9: Commit**

```powershell
git add -A
git commit -m "refactor: reorganize settings UI into 5 collapsible sections"
```

---

### Task 6: 清理构建配置 + 依赖

**Files:**
- Modify: `webpack.config.js`（`DefinePlugin` + `resolve.fallback` + `ProvidePlugin`）
- Modify: `esbuild.config.mjs`（`define`）
- Modify: `package.json`（`dependencies` + `devDependencies` + `browser` 字段）
- Modify: `.env.example.txt`

**Interfaces:**
- Produces: 依赖从 ~40 降到 ~15，`main.js` 体积显著减小

- [ ] **Step 1: webpack.config.js — 删除已删服务的 DEFAULT_* 环境变量**

Modify `webpack.config.js` 的 `DefinePlugin`：删除 `DEFAULT_S3_*`/`DEFAULT_DROPBOX_*`/`DEFAULT_WEBDAV_*`/`DEFAULT_WEBDIS_*`/`DEFAULT_GOOGLEDRIVE_*`/`DEFAULT_BOX_*`/`DEFAULT_PCLOUD_*`/`DEFAULT_YANDEXDISK_*`/`DEFAULT_KOOFR_*`/`DEFAULT_AZUREBLOBSTORAGE_*`/`DEFAULT_ONEDRIVEFULL_*`/`DEFAULT_PRO_*`。仅保留 `DEFAULT_ONEDRIVE_CLIENT_ID`/`DEFAULT_ONEDRIVE_AUTHORITY`/`DEFAULT_ONEDRIVE_REDIRECT_URI`。

- [ ] **Step 2: webpack.config.js — 删除仅 AWS/WebDAV 需要的 polyfill fallback**

Modify `webpack.config.js` 的 `resolve.fallback`：核实并删除 `crypto-browserify`/`stream-browserify`/`path-browserify`（仅 AWS SDK/WebDAV 需要）。保留 OneDrive 路径需要的（核实——OneDrive 用 Obsidian `request()`，可能不需要这些 polyfill）。

- [ ] **Step 3: esbuild.config.mjs — 同步 define 清理**

Modify `esbuild.config.mjs` 的 `define`：与 webpack `DefinePlugin` 保持一致（AGENTS.md 要求），仅保留 OneDrive 的 `DEFAULT_*`。

- [ ] **Step 4: package.json — 删除已删服务的依赖**

Modify `package.json` 的 `dependencies`：删除 `@aws-sdk/client-s3`/`@aws-sdk/lib-storage`/`@aws-sdk/signature-v4-crt`/`@aws-sdk/types`/`aws-crt`/`@azure/storage-blob`/`dropbox`/`box-typescript-sdk-gen`/`pcloud-sdk-js`/`webdav`/`@smithy/fetch-http-handler`/`@smithy/protocol-http`/`@smithy/querystring-builder`。保留 `@microsoft/microsoft-graph-client`/`@microsoft/microsoft-graph-types`/`@azure/msal-node`（待 Plan B 核实用途）/`localforage`/`lodash`/`nanoid`/`p-queue`/`node-diff3`/`@sanity/diff-match-patch`/`@fyears/rclone-crypt`/`@fyears/tsqueue` 等。

同时删除 `devDependencies` 里的 `webdav-server`（测试用，已删 webdav）/`@types/mime-types`（核实是否还需）。

- [ ] **Step 5: package.json — 精简 browser 字段**

Modify `package.json` 的 `browser` 字段：删除仅 AWS/WebDAV 需要的映射（`crypto`/`stream`/`path`），保留必要的（核实）。

- [ ] **Step 6: .env.example.txt — 删除已删服务配置项**

Modify `.env.example.txt`：删除 S3/Dropbox/WebDAV/Webdis/GoogleDrive/Box/PCloud/YandexDisk/Koofr/AzureBlobStorage/OnedriveFull/Pro 的环境变量示例，仅留 OneDrive 相关。

- [ ] **Step 7: 重新安装依赖 + 构建通过**

Run:
```powershell
Remove-Item -Recurse node_modules
npm install
npm run build2
npm run build
```
Expected: 安装成功，构建无错误。

- [ ] **Step 8: 体积对比**

Run:
```powershell
(Get-Item main.js).Length
```
对比原版 `main.js` 体积（原版在源项目 `E:\Code\others\obsidian-remotely-save\remotely-save\main.js`——若存在）。Expected: 显著减小（AWS SDK 等删除后降数 MB）。

- [ ] **Step 9: Commit**

```powershell
git add -A
git commit -m "build: remove 11 services' deps, env vars, polyfills — shrink main.js"
```

---

### Task 7: 最终验证 — 构建 + 悬空引用 + 设置 UI

**Files:**
- Verify: 全项目

**Interfaces:**
- Produces: Plan A 完成标志——可构建、无悬空引用、设置 UI 5 分区、pro 已解锁

- [ ] **Step 1: 全量类型检查 + 生产构建**

Run:
```powershell
npm run build2
npm run build
```
Expected: 均无错误。

- [ ] **Step 2: 全量悬空引用 grep**

Run:
```powershell
rg "fsS3|fsDropbox|fsWebdav|fsWebdis|fsGoogleDrive|fsBox|fsPCloud|fsYandexDisk|fsKoofr|fsAzureBlobStorage|fsOnedriveFull|settingsPro|checkProRunnableAndFixInplace|getAndSaveProFeatures|getAndSaveProEmail|COMMAND_CALLBACK_PRO|COMMAND_CALLBACK_DROPBOX|COMMAND_CALLBACK_GOOGLEDRIVE|COMMAND_CALLBACK_BOX|COMMAND_CALLBACK_PCLOUD|COMMAND_CALLBACK_YANDEXDISK|COMMAND_CALLBACK_KOOFR|COMMAND_CALLBACK_AZUREBLOBSTORAGE|COMMAND_CALLBACK_ONEDRIVEFULL" src pro\src --type ts
```
Expected: 无匹配（或仅注释里的说明性文字）。

- [ ] **Step 3: 服务类型枚举验证**

Run:
```powershell
rg "SUPPORTED_SERVICES_TYPE" src\baseTypes.ts -A 5
```
Expected: 仅 `"onedrive" | "local" | "mock"`。

- [ ] **Step 4: 设置 UI 分区验证（代码审查）**

确认 `src/settings.ts` 的 `display()` 调用 5 个分区函数，无 `xxx-hide` toggle 残留，无服务选择下拉。

- [ ] **Step 5: smart_conflict 解锁验证（代码审查）**

确认 `conflictAction === "smart_conflict"` 分支在 `pro/src/sync.ts` 保留，且无 `checkProRunnableAndFixInplace` 门禁调用。

- [ ] **Step 6: 真机冒烟测试（手动，在 Obsidian 里）**

把 `main.js` + `manifest.json` + `styles.css` 复制到 Obsidian vault 的 `.obsidian/plugins/remotely-save-onedrive/`，启用插件：
- 设置界面显示 5 分区，无 S3/Dropbox 等选项
- 能连接 OneDrive（App Folder OAuth）
- 能同步小 vault
- smart_conflict 可选（无需 pro 账号）

Expected: 以上均通过。若 OneDrive 连接失败，记录错误（Plan B 处理 API 现代化时修复）。

- [ ] **Step 7: Commit + 打 tag**

```powershell
git add -A
git commit -m "chore: Plan A complete — OneDrive-only plugin, pruned + ungated + UI reorganized"
git tag v0.6.0-plan-a
```

---

## Self-Review

**1. Spec coverage:**
- ✅ 删除 11 个非 OneDrive 服务（Task 2 删文件，Task 3 修引用，Task 6 删依赖）
- ✅ 解锁 Smart Conflict + ClearDupFiles（Task 4 移除门禁）
- ✅ 设置 UI 5 分区（Task 5）
- ✅ 插件改名（Task 1）
- ✅ 构建配置清理（Task 6）
- ✅ 构建验证（Task 3/7）
- ⏸ OneDrive API 现代化（delta/续传/退避/认证）→ **Plan B**（本计划不含，待 Plan A 验证后另写）
- ⏸ 真机 delta/续传/回归测试 → **Plan B**

**2. Placeholder scan:** 无 TBD/TODO。所有步骤含具体文件路径、命令或代码。`ProConfig` 处理标注"核实"是因为依赖 Task 4 的门禁移除结果——这是条件性步骤，非占位符。

**3. Type consistency:** `SUPPORTED_SERVICES_TYPE`（Task 3 Step 1）与 `getClient` switch（Task 3 Step 3）的 case 一致（onedrive/local/mock）。`PRO_FEATURE_TYPE`（Task 3 Step 2）与 smart_conflict 分支（Task 4）一致。

---

## 后续：Plan B（OneDrive API 现代化）

Plan A 完成并真机验证后，另写 Plan B，覆盖：
1. `approot` 端点正确性修复（grep `fsOnedrive.ts` 实际字符串）
2. `@azure/msal-node` 用途核实（删除或升级 v2→v5）
3. `graphRequestWithRetry()` 节流退避 helper
4. `createUploadSession` 可恢复上传
5. Delta 同步缓存封装法（**含 approot+MSA 实测**，决定是否保留）
6. scope 收紧 `Files.ReadWrite.AppFolder`
7. 真机全流程验证（delta/续传/回归）
