# Remotely Save (OneDrive) 重构设计稿

- **日期**: 2026-08-10
- **状态**: 已通过用户审批（4 节设计逐节确认）
- **源项目**: `E:\Code\others\obsidian-remotely-save\remotely-save`（v0.5.25，多年未更新）
- **目标项目**: `E:\Code\others\obsidian-remotely-save\remotely-save-onedrive`（新分叉，空目录起步）
- **方案**: 方案 1 — 务实精简 + 定向现代化

---

## 1. 背景与动机

`remotely-save` 是一个 Obsidian 笔记同步插件，支持 12 个云服务（5 免费 + 7 pro），多年未更新。用户希望重构为一个**专注 OneDrive 个人版**的精简插件，解决四个痛点：

1. **pro 功能**：去掉或解锁（能实现的解锁，不需要的如其他网盘直接删）
2. **服务精简**：重点保留 OneDrive 个人版，其他隐藏/删除
3. **OneDrive API 更新**：调查官方文档，提升使用体验
4. **设置界面**：太杂乱，重构优化

## 2. 已确认决策（来自澄清问答）

| 决策项 | 结果 |
|---|---|
| 重构范围 | 方案 A：精简 + 解锁 pro，保留 `pro/` 文件夹（PolyForm 许可证，个人使用没问题） |
| 保留并解锁的 pro 功能 | Smart Conflict（智能冲突合并）、ClearDupFiles（去重工具） |
| 删除的 pro 功能 | 7 个非 OneDrive pro 云盘 + OneDrive Full Access（根目录访问） |
| OneDrive 访问模式 | 仅 App Folder（沙箱目录 `/Apps/remotely-save-onedrive/`） |
| 非 OneDrive 免费服务 | S3 / Dropbox / WebDAV / Webdis 全部删除（代码 + 依赖） |
| 插件身份 | 改名为 `remotely-save-onedrive` / "Remotely Save (OneDrive)"，不写数据迁移逻辑 |

## 3. 目标与非目标

### 目标
- 一个专注 OneDrive 个人版（App Folder）的 Obsidian 同步插件
- 删除 11 个非 OneDrive 服务（7 pro 云盘 + 4 免费服务）及其代码、依赖、类型、设置块
- 解锁 Smart Conflict + ClearDupFiles（移除 pro 账号门禁）
- OneDrive API 现代化：msal 处理、`approot` 端点修正、delta 同步、可恢复上传、节流退避
- 设置 UI 从 3029 行 12 服务块平铺重组为 5 个聚焦折叠分区
- 插件改名为 `remotely-save-onedrive`
- 构建产物 `main.js` 显著减小

### 非目标（YAGNI）
- 不重写 `pro/src/sync.ts`（2094 行核心同步引擎）内部逻辑
- 不把 `sync.ts` 迁出 `pro/`（许可证不变，保留 PolyForm）
- 不拆分 `settings.ts` / `main.ts` 为多文件（那是方案 2）
- 不做 JSON 批处理 `$batch`（收益小复杂度高）
- 不迁移到 Graph SDK v6/Kiota（JS 官方仍推荐 v3）
- 不写数据迁移逻辑（用户选了纯改名）
- 不支持 OneDrive Full Access / Business

## 4. 设计详情

### 4.1 第 1 节：删除范围 + pro 解锁

#### 4.1.1 删除的文件

**`pro/` 目录：**
- 删除：`fsGoogleDrive.ts`+`settingsGoogleDrive.ts`、`fsBox.ts`+`settingsBox.ts`、`fsPCloud.ts`+`settingsPCloud.ts`、`fsYandexDisk.ts`+`settingsYandexDisk.ts`、`fsKoofr.ts`+`settingsKoofr.ts`、`fsAzureBlobStorage.ts`+`settingsAzureBlobStorage.ts`、`fsOnedriveFull.ts`+`settingsOnedriveFull.ts`、`account.ts`（pro 账号/订阅门禁）、`settingsPro.ts`（pro 账号登录 UI）
- 保留：`sync.ts`（核心引擎）、`conflictLogic.ts`（smart_conflict，解锁）、`localdb.ts`（smart_conflict 内容历史库）、`clearDupFiles.ts`+`settingsClearDupFiles.ts`（解锁）、`oauth2.ts`（PKCE 助手，核实免费 fsOnedrive 是否依赖，是则保留）、`baseTypesPro.ts`（修改，删多余服务类型，留 smart_conflict/cleardup）

**`src/` 目录：**
- 删除：`fsS3.ts`、`fsDropbox.ts`、`fsWebdav.ts`、`fsWebdis.ts`
- 保留：`fsOnedrive.ts`（核心，待 API 现代化）、`fsLocal.ts`、`fsMock.ts`（测试）、`fsAll.ts`（FakeFs 基类）、`fsGetter.ts`（修改）、`fsEncrypt.ts`

#### 4.1.2 删除的依赖（package.json）

- 删除：`@aws-sdk/*`(4个) + `aws-crt`、`@azure/storage-blob`、`dropbox`、`box-typescript-sdk-gen`、`pcloud-sdk-js`、`webdav`、`@smithy/*`(3个)、`crypto-browserify`/`stream-browserify`/`path-browserify`（仅 AWS/WebDAV 需要的 polyfill，核实后删）
- 保留：`@microsoft/microsoft-graph-client` + `@microsoft/microsoft-graph-types`、`@azure/msal-node`（待核实实际用途，见 4.2.1）、`localforage`、`lodash`、`nanoid`、`p-queue`、`node-diff3`、`@sanity/diff-match-patch`、`@fyears/rclone-crypt`、`@fyears/tsqueue` 等

#### 4.1.3 类型与注册表精简

- `baseTypes.ts` 的 `SUPPORTED_SERVICES_TYPE`：12 个 → 仅 `"onedrive"`（+ `"local"`/`"mock"` 供测试）
- `baseTypesPro.ts` 的 `PRO_FEATURE_TYPE`：仅留 `"feature-smart_conflict"` + `"feature-clear_dup_files"`
- `RemotelySavePluginSettings`：删除 11 个服务配置字段，仅留 `onedrive` + 通用字段
- `DEFAULT_SETTINGS`：删除 11 个服务默认配置，`serviceType` 默认改 `"onedrive"`
- `fsGetter.ts` 的 `getClient` switch：12 case → 仅 `onedrive`/`local`/`mock`
- `settings.ts`：删除 11 个服务设置块 + pro 账号登录块

#### 4.1.4 pro 解锁方案

核心：移除 `pro/src/account.ts` 的 remotelysave.com 账号门禁，让保留的 pro 功能直接可用。

- `checkProRunnableAndFixInplace`（`account.ts:221`）：删除整个函数及其在 `sync.ts`/`settings.ts` 的调用点。smart_conflict 不再校验订阅。
- `config.pro` 字段：从 `RemotelySavePluginSettings` 类型移除。旧 `data.json` 里的 `pro` 键会被 Obsidian 的 `loadSettings` 自动忽略（多余键无害），无需迁移代码。
- `main.ts`：删除 pro 账号 OAuth 回调（`COMMAND_CALLBACK_PRO`）+ `getAndSaveProFeatures`/`getAndSaveProEmail` 调用。
- smart_conflict 分支：`sync.ts` 里 `conflictAction === "smart_conflict"` 的条件分支保留，只是不再被门禁拦截。
- ClearDupFiles：命令与设置项保留，移除门禁校验。

#### 4.1.5 许可证注意

`pro/` 仍是 PolyForm Strict（source-available）。个人使用没问题；若日后分发需遵守该许可证条款。本文档及 README 会标注。

#### 4.1.6 main.ts 入口清理

- 删除 ~14 个 `../pro/src/*` 中已删服务的 import
- 删除 6 个 pro 服务 + pro 账号的 `obsidian://` 协议回调注册
- 保留：sync 命令、ribbon、statusbar、`RemotelySaveSettingTab` 注册、OneDrive 回调

### 4.2 第 2 节：OneDrive API 现代化

基于 lib-1 调研（Microsoft Graph 官方文档）+ codegraph 对 `fsOnedriveFull.ts` 源码核对。

**关键发现**：OneDrive 路径实际用原始 `request()`（Obsidian 的 request，绕过 CORS）直连 `${authority}/oauth2/v2.0/token` + PKCE，而非 msal-node 直连（见 `fsOnedriveFull.ts:128`）。

#### 4.2.1 认证现代化

实现时先核实 `fsOnedrive.ts` 的认证路径：
- **若也用原始 `request()`**（大概率）→ `@azure/msal-node` 可能没在 OneDrive 路径用，直接删除该依赖（比升级 v2→v5 更干净）。PKCE 用 `pro/src/oauth2.ts` 的 `codeVerifier2CodeChallenge` 或内联。
- **若确实用了 msal-node**（token 缓存/刷新）→ 升级 v2→v5（v2 已停止支持，active=v5.x，LTS=v1.x）。
- scope 收紧为 `Files.ReadWrite.AppFolder`（最小权限，非 `Files.ReadWrite`）。
- redirect URI 保持 `http://localhost`（loopback）+ `msal{clientId}://auth`（移动端）。

#### 4.2.2 端点正确性修复

App Folder 端点段是 `approot`（大小写敏感），不是 `appfolder`。实现时 grep `fsOnedrive.ts` 实际字符串，若用了 `appfolder` 则修正为 `/me/drive/special/approot` 及 `/me/drive/special/approot/children`。正确性 bug 修复，无行为变化。

#### 4.2.3 Delta 同步（头号 UX 改进，最高风险）

**现状**：每次同步全量枚举远程目录，大 vault 慢。
**目标**：用 `GET /me/drive/special/approot/delta` + 持久化 `@odata.deltaLink`，只拉变更。

**集成策略 — 缓存封装法**（关键设计决策）：
不让 delta 侵入 `sync.ts`。`fsOnedrive.ts` 内部维护远程元数据缓存（存 localdb），对外接口不变：
1. `fsOnedrive.list()` 被调用时：
   - 有 `deltaLink` → 调 delta 端点 → 把变更（added/updated/deleted）应用到本地缓存 → 返回完整缓存给 `sync.ts`
   - 无 `deltaLink` 或收到 `410 Gone` → 全量枚举 → 重建缓存 → 返回全量（即现状，零回退风险）
2. `sync.ts` 完全不动，仍收到完整远程列表，diff 算法不变。
3. 缓存丢失/损坏 → 自动回退全量重建。

**收益**：`sync.ts` 零改动（低风险），delta 逻辑封装在 `fsOnedrive` 内。

**不确定性（必须实测）**：approot + MSA 个人版的 delta 端点未在官方文档明确列出。实现时先 live-test `GET /me/drive/special/approot/delta` 是否对个人账号可用。若不可用 → 保持全量枚举（无回退）。**此为条件性特性**。

#### 4.2.4 可恢复上传（移动端大文件痛点）

**现状**：移动端 ≥50MB 文件有性能问题，设置里有"跳过大文件"。
**目标**：`createUploadSession` 分片续传。
- `fsOnedrive` 上传路径检查文件大小：>10MiB 用 `POST /me/drive/items/{parentItemId}:/{fileName}:/createUploadSession`，分片 5-10MiB（必须是 320KiB 倍数），单 PUT 最大 60MiB。
- 失败时按 `nextExpectedRanges` 续传。支持 `deferCommit`（OneDrive Personal 支持）。
- 集成：`fsOnedrive` 内部，不动 `sync.ts`。提高"跳过大文件"阈值（如从现有值提到 100MiB），保留作移动端安全阀，不彻底移除。

#### 4.2.5 节流与退避

- Graph API 返回 `429` + `Retry-After`（秒）→ 读取 header，等待后重试。
- `5xx` → 指数退避。
- 封装 `graphRequestWithRetry()` helper，包裹所有 Graph 调用。
- 实现时核实现有 `fsOnedrive` 是否已处理 `Retry-After`。

#### 4.2.6 不做的事（YAGNI）

- JSON 批处理 `$batch`（收益小复杂度高）
- Graph SDK v6/Kiota 迁移（JS 官方仍推荐 v3）
- 重写 `sync.ts` 内部

### 4.3 第 3 节：设置 UI + 插件身份 + 构建配置

#### 4.3.1 设置 UI 新结构（单 Tab，5 个折叠分区）

**现状**：`settings.ts` 3029 行单文件，12 服务块用 `xxx-hide` toggle 切换，~40+ 字段平铺。
**新结构**：删除 11 服务块 + pro 账号块后，重组为 5 分区。**不拆文件**，只重排 + 加折叠标题。

| 分区 | 内容 |
|---|---|
| ① 账户与连接 | OneDrive 授权状态（已连接/邮箱 + 断开按钮）、"连接 OneDrive" 按钮。删除服务选择下拉。 |
| ② 同步选项 | 同步方向（双向/仅上传/仅下载）、并发数、自动同步间隔、保存时同步、跳过大文件阈值（因有可恢复上传，提高到如 100MiB，保留作安全阀）、跳过路径正则。 |
| ③ 冲突处理 | 冲突动作下拉（保留较新/保留较大/smart_conflict——已解锁，附说明）、ClearDupFiles 入口（已解锁）。 |
| ④ 加密 | 密码设置、加密格式（rclone crypt / openssl）。 |
| ⑤ 高级 | 配置文件夹同步（.obsidian）、书签同步、隐藏文件规则（./_ 前缀）、状态栏显示、性能分析器、语言、导入/导出设置（QR 码）、调试模式。 |

**实现**：`settings.ts` 的 `display()` 重排为 5 个分区函数（`generateAccountSection()` 等），每个用 Obsidian 的 `heading` + 折叠容器。预计从 3029 行降到 ~600-800 行。

#### 4.3.2 插件身份（改名）

| 文件 | 改动 |
|---|---|
| `manifest.json` | `id`: `remotely-save` → `remotely-save-onedrive`；`name`: → `Remotely Save (OneDrive)`；`fundingUrl` 删除 |
| `manifest-beta.json` | 同上 |
| `versions.json` | 新增版本条目（如 `0.6.0`） |
| `package.json` | `name` 同步，版本号同步 |

**数据迁移说明**：id 变了，Obsidian 视为新插件，旧 `data.json` 不自动迁移。文档标注：用户可手动复制 `.obsidian/plugins/remotely-save/data.json` 到新插件目录（字段兼容，删服务有默认值）。

#### 4.3.3 构建配置清理

**`webpack.config.js`（主构建器）：**
- `DefinePlugin` 删除 ~11 个 `DEFAULT_*` 环境变量，仅保留 `DEFAULT_ONEDRIVE_CLIENT_ID`、`DEFAULT_ONEDRIVE_AUTHORITY`、`DEFAULT_ONEDRIVE_REDIRECT_URI`。
- `resolve.fallback` 删除仅 AWS/WebDAV 需要的 polyfill（核实后删）。
- `package.json` 的 `browser` 字段同步精简。

**`esbuild.config.mjs`（备用）：** 同步 `define` 清理（AGENTS.md 要求两配置一致）。

**`.env.example.txt`：** 删除已删服务配置项，仅留 OneDrive 相关。

**依赖清理结果**：`dependencies` 从 ~40 个降到 ~15 个，`main.js` 体积大幅减小。

### 4.4 第 4 节：测试与验证

#### 4.4.1 构建验证（机械性，最先做）

| 验证项 | 命令 | 通过标准 |
|---|---|---|
| 类型检查 | `npm run build2`（含 `tsc -noEmit -skipLibCheck`） | 无类型错误（无悬空 import/类型引用） |
| 生产构建 | `npm run build`（webpack） | 生成 `main.js`，无报错 |
| 体积对比 | 对比新旧 `main.js` | 显著减小（AWS SDK 等删除后降数 MB） |
| 悬空引用扫描 | grep 已删服务名 | 源码无残留引用 |

#### 4.4.2 真机同步测试（核心功能）

需 Obsidian + 真实 OneDrive 个人账号：

| 验证项 | 通过标准 |
|---|---|
| App Folder 授权 | OAuth 成功，显示邮箱，App Folder 出现在 `/Apps/remotely-save-onedrive/` |
| 基础同步 | 小 vault 双向同步，上传+下载正确 |
| 端点正确性 | 日志/网络显示 `/me/drive/special/approot` |

#### 4.4.3 Delta 同步实测（关键不确定性，必须做）

| 验证项 | 通过标准 |
|---|---|
| Delta 端点可用性 | 改 1 文件再同步，日志显示"增量同步"，`deltaLink` 持久化 |
| 回退安全 | delta 不可用时自动回退全量，无崩溃 |
| 缓存一致性 | 多轮增量后缓存与远程一致 |

**决策点**：若实测 delta 对 approot+MSA 不可用 → 保持全量（现状），delta 降级为"未来工作"。

#### 4.4.4 可恢复上传测试

| 验证项 | 通过标准 |
|---|---|
| 大文件续传 | >10MiB 文件走 `createUploadSession` 分片上传，成功 |
| 断点续传 | 中断后恢复，从 `nextExpectedRanges` 续传，完整 |

#### 4.4.5 回归测试（保留功能不退化）

| 验证项 | 通过标准 |
|---|---|
| 加密 | OneDrive 上文件为密文，本地解密正常 |
| Smart Conflict（已解锁） | 制造冲突，smart_conflict 合并/复制，**无需 pro 账号** |
| ClearDupFiles（已解锁） | 去重命令正常，**无需 pro 账号** |
| 节流退避 | 429 时读 `Retry-After` 等待重试（代码审查为主） |

#### 4.4.6 设置 UI 验证

| 验证项 | 通过标准 |
|---|---|
| 5 分区渲染 | 账户/连接、同步选项、冲突处理、加密、高级 均正确显示 |
| 无残留服务 | 下拉无 S3/Dropbox/WebDAV/Webdis/pro 云盘选项 |
| OneDrive 操作 | 设置内连接/断开正常 |

#### 4.4.7 验证策略说明

- 构建+类型检查：自动化，每次改动后跑。
- 真机同步/delta/续传/回归：需手动在 Obsidian + 真实 OneDrive 测试，无法自动化。
- delta 实测是唯一"可能不成立"的特性，优先做，结果决定是否保留 delta 代码路径。

## 5. 风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|---|---|---|
| approot+MSA delta 端点未官方确认 | delta 同步可能不可用 | 实测优先；不可用则回退全量（零回退风险） |
| `@azure/msal-node` 实际用途未核实 | 认证现代化方案有分支 | 实现时先核实，按情况选删除或升级 |
| `pro/` PolyForm 许可证 | 分发受限 | 个人使用 OK；分发需遵守条款，文档标注 |
| `sync.ts` 在 `pro/` 且 2094 行 | 不可改动核心 | 缓存封装法隔离 delta 风险，sync.ts 零改动 |
| 旧 `data.json` 不自动迁移 | 升级用户需手动复制 | 文档说明，不写迁移逻辑（用户选择） |

## 6. 实现顺序建议（供 writing-plans 参考）

1. **脚手架**：把源项目复制到工作目录，改 manifest/package 身份
2. **删除阶段**（机械、低风险）：删文件、删依赖、删类型/注册表/设置块、删 pro 账号门禁
3. **构建验证**：确保删除后能编译通过
4. **pro 解锁**：移除门禁调用，验证 smart_conflict/cleardup 可用
5. **设置 UI 重排**：5 分区结构
6. **OneDrive API 现代化**（按风险递增）：端点修正 → 节流退避 → 认证核实 → 可恢复上传 → delta 同步（实测）
7. **真机验证**：按 4.4 全流程

## 7. 参考资料

- Microsoft Graph App Folder: https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
- Delta query: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- createUploadSession: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- MSAL Node v5 迁移: https://learn.microsoft.com/en-us/entra/msal/node/v5-migration
- Graph 节流: https://learn.microsoft.com/en-us/graph/throttling
- 权限参考: https://learn.microsoft.com/en-us/graph/permissions-reference
