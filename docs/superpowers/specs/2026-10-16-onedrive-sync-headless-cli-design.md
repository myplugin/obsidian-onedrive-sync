# OneDrive Sync Headless CLI:从 Obsidian 插件派生 Node CLI 的适配设计

- **日期**:2026-10-16
- **状态**:草案,待用户 review
- **关联**:派生自 `2026-10-14-multi-audience-onedrive-support-design.md`——其 **Phase 3(手机 DCF)被本 spec 的"共享 DCF 模块"吸收**(见 §4.2);personal-only 决定沿用。另一会话的 `sync.ts` 类型清理 WIP 不在本 spec 范围。
- **官方文档核验**:@librarian(ses_ebc1aff55ffeP2L4UzGDclPMzC),learn.microsoft.com + msal-node 源码(见 §2)。
- **代码基线核验**:codegraph_explore(fsLocal/fsOnedrive/fsGetter/fsAll/localdb/baseTypes/esbuild.config.mjs 逐字源码,见 §5)。

---

## 1. 背景与问题

### 1.1 现状
插件 `onedrive-vault-sync` 在 Obsidian 内双向同步 vault ↔ OneDrive **个人版** App Folder(`Files.ReadWrite.AppFolder`)。架构上已有若干对 headless 友好的资产(均经 codegraph 核实):

- `FakeFs` 抽象端口(`fsAll.ts`)——本地与远端各一实现,CLI 只需再写一个 `NodeFs extends FakeFs`。
- `tests/_obsidianStub.ts`——已用 `Module._load` 劫持把 `obsidian` 换成桩,src 在纯 Node 下能被 import(机制已跑通)。
- `tests/_dbMock.ts` / `tests/_fsMock.ts`——`InternalDBs` 与 `FakeFs` 的内存实现,接口形状现成。
- `@azure/msal-node ^7.1.0` 已是依赖;`graphRequest`(`fsOnedrive.ts:93`)是单一 HTTP 瓶颈,包了 Obsidian `requestUrl` 成 `GraphResponse` facade。

### 1.2 需求
在**纯 Node**(无 Obsidian、无浏览器)下跑同一套同步——用于容器化/服务器/无头场景(如对方提到的 Hermes 容器 + 群晖共享 vault)。

### 1.3 外部分析的修正
外部分析(已核对可信)提出 7 步落地,但有两处误判/遗漏,本 spec 修正:

1. **`fsGetter` 不是接缝点**:它选的是**云端**后端(CLI 仍用 onedrive,不加 case)。真正接缝有 **5** 条(见 §4.1),其中"独立 node 构建"一条分析没点出。
2. **DCF 与手机 Phase 3 是同一件事**:分析把 CLI-DCF 当独立项;实则我们 2026-10-14 spec 的 Phase 3(手机 DCF,修 `AADSTS165000`)与 CLI-DCF 可共用一个手写模块(见 §4.2),一次设计交付两处。

---

## 2. 官方文档核验(@librarian)

### 2.1 Device Code Flow 端点契约 ✅
来源:[learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code)

- 设备授权:`POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`,body `client_id`+`scope`,`tenant`∈`/common`/`/consumers`/`/organizations`/GUID。
- 响应字段:`device_code`、`user_code`、`verification_uri`、`expires_in`、`interval`、`message`。⚠️ `verification_uri_complete` 微软**不支持**。
- token 轮询:`POST .../oauth2/v2.0/token`,body `grant_type=urn:ietf:params:oauth:grant-type:device_code`+`client_id`(须与首次一致)+`device_code`+`tenant`(须与首次一致)。
- 轮询错误(官方表 4 个):`authorization_pending`(等 `interval` 重试)、`authorization_declined`(终止)、`bad_verification_code`、`expired_token`(终止)。
- ⚠️ **`slow_down` 不在官方 device-code 错误表**(仅 RFC 8628 §5.5 + AAD 实践 + msal-node 处理)。spec 要求:实现须认 `slow_down` 并按 RFC 增加 `interval`,但文档标注此 gap。

### 2.2 `/common` + 个人 MSA ✅
官方:个人账户经 `/common` 或 `/consumers` 鉴权时会被要求再次登录以把认证态转到设备。→ `/common` 对个人 MSA 有效(插件已用)。

### 2.3 msal-node `acquireTokenByDeviceCode` + 持久化 ✅(关键 nuance)
来源:msal-node API ref + 官方 sample。

- 调用:`pca.acquireTokenByDeviceCode({ scopes, deviceCodeCallback, cancel?, timeout? })`。
- ⚠️ **`AuthenticationResult` 上无 `refreshToken` 字段**——msal-node 故意不暴露裸 RT。`offline_access` 在 scope 时 token 端点会返回 RT,但 msal 内部缓存为 `RefreshTokenEntity`,只能经 `acquireTokenSilent({account, scopes})` 对同一 cache 消费,不能从 result 直接读。
- 持久化:`ICachePlugin`(`beforeCacheAccess` 加载→`deserialize`、`afterCacheAccess` 若 `cacheHasChanged`→`serialize` 落盘),或 `msal-node-extensions` 的 `PersistenceCachePlugin`(加跨平台文件锁)。

### 2.4 msal-node 不能在 webview 运行 ✅(源码级,决定性)
结论:**msal-node 未经改造不能在浏览器/Capacitor webview 跑**。证据(当前 `dev` 分支源码):

- `msal-node/src/crypto/PkceGenerator.ts`:`import crypto from "crypto"` + `crypto.randomBytes`。
- `msal-node/src/crypto/GuidGenerator.ts`:`import { randomUUID } from "node:crypto"`。
- `msal-node/package.json`:仅依赖 `@azure/msal-common`+`jsonwebtoken`(后者依赖 Node crypto),**无 `browser` field**。
- 网络层 `HttpClient.ts` 用原生 `fetch`(webview 也有)——**不是瓶颈**;瓶颈是 PKCE/GUID 生成处的 `node:crypto`/`crypto`/`jsonwebtoken`,在 `PublicClientApplication` 构造/取 token 时触发,webview 必抛。

⚠️ 残留:未能找到官方"msal-node 不支持浏览器"的原句,结论靠源码 import(对"不能原样跑"是决定性的,仅缺一句官方免责声明)。

**spec 含义(决定性)**:Obsidian 手机(Capacitor webview)的 DCF **必须手写** `/devicecode`+`/token`(原生 fetch 可用;device-code grant **无需 PKCE/code_challenge**,故无需 crypto)。msal-node 仅留 Node CLI 路径(本 spec 进一步选不依赖它,见 §4.2)。

### 2.5 App Folder 与 client_id ✅(安全规则)
来源:[drive-get-specialfolder](https://learn.microsoft.com/graph/api/drive-get-specialfolder) + [specialfolder resource](https://learn.microsoft.com/graph/api/resources/specialfolder)。

- `GET /me/drive/special/approot` → `/Apps/{Application Name}`。scope 为 `Files.ReadWrite.AppFolder`(插件已用)。
- ⚠️ 残留:官方未明文"`{Application Name}` = 应用注册显示名(故 per `client_id`)",但与注册模型一致且实践普遍。**安全规则不依赖该明文**:CLI **必须复用插件同一 `client_id`**(与同一 authority),否则 `/special/approot` 解析到不同文件夹。经验交叉验证(一行):`GET /me/drive/special/approot` 比对 `parentReference.path`。

---

## 3. 目标与范围

### 3.1 目标
派生一个 Node CLI,复用插件同步核心(`sync.ts`/`conflictLogic.ts`/`FakeFs`/`FakeFsOnedrive`),在纯 Node 下双向同步 vault ↔ OneDrive 个人版 App Folder。

### 3.2 IN
- 5 条接缝适配(§4.1)+ 共享 DCF 模块(§4.2)+ 独立 node 构建(§4.1⑤)+ CLI 状态库(§4.1②)+ 基本命令(`login`/`sync`/`status`/`resolve`)。
- 顺带交付手机 Phase 3(共享 DCF 模块可被 Obsidian 手机运行时 import)。

### 3.3 OUT
- **Obsidian-config-sync 功能**:CLI 只管 vault 内容,**不**同步 `.obsidian` 配置/插件/外观(bookmarks 等)。这些是 Obsidian 专属,CLI 场景无意义。
- **企业/工作或学校账户**:沿用 personal-only 决定(2026-10-14 spec)。
- **与插件并发运行**:见 §4.3,CLI 与插件不得同时跑同一 vault。
- **替换桌面插件**:CLI 是补充,用于无头场景。

---

## 4. 设计

### 4.1 五条接缝(现状 → CLI 替换 → 难度)

| # | 接缝 | 现状 | CLI 替换 | 难度 |
|---|---|---|---|---|
| ① | 本地 fs | `FakeFsLocal extends FakeFs`,全经 `vault.adapter.*`(`getAllLoadedFiles`/`readBinary`/`writeBinary`/`rename`/`trash*`) | `NodeFs extends FakeFs`,`node:fs/promises` 递归 `readdir`/`stat`/`readFile`/`writeFile`+`utimes`;`rm` 走 `fs.rm`(或 trash lib)。**仅 vault 内容,放弃 Obsidian-config-sync** | 中 |
| ② | 状态库 | `localdb` localforage,`InternalDBs` 10 表(2 legacy) | `NodeDb`:实现 `InternalDBs`,每个 `LocalForage` 字段由文件 KV 支持(JSON+debounce 落盘,复用 `_dbMock` 的 Map 形状) | 中高 |
| ③ | 鉴权 | msal-node 仅 `getAuthCodeUrl`+`CryptoProvider` PKCE;token 手写 fetch;回调 `obsidian://` | **共享手写 DCF 模块** `acquireByDeviceCode()`(§4.2),填现有 `OnedriveConfig` 形状 | 中 |
| ④ | HTTP | `graphRequest`(`fsOnedrive.ts:93`)包 `requestUrl`→`GraphResponse` | `graphRequest` 内 `requestUrl`→node `fetch`(单一瓶颈,~40 行;`request` 用法待确认) | 低 |
| ⑤ | 构建 | esbuild + `browser` stubs(`node:crypto`→crypto-browserify 等)+ `package.json` `browser` field(`fs/http/crypto=false`) | **独立 node-platform esbuild target**(去 stub,真 node 内建,`platform:"node"`) | 中 |

### 4.2 DCF 共享设计(核心决策)

**方案**(已核验 `fsOnedrive.ts:435-568` 现有契约):新写 `acquireByDeviceCode(clientID, authority, httpPost, opts)`(`src/deviceCode.ts`,flat):
- `httpPost` **注入**(Obsidian 传 `request` 封装、Node 传 `fetch` 封装)——规避 webview CORS 未验证项 + 模块纯逻辑可测。
- `POST /devicecode`(body `client_id`+`scope`;**无 body tenant**,/common 路径权威,对齐 Tier-1)→ 回调打印 `user_code`+`verification_uri`。
- 按 `interval` 轮询 `POST /token`(body `grant_type=urn:ietf:params:oauth:grant-type:device_code`+`client_id`+`device_code`;无 body tenant)。
- **返回 `AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType`**(与 `sendAuthReq` 同型,`fsOnedrive.ts:435-451`)→ 调用方**复用现有** `setConfigBySuccessfullAuthInplace`(`fsOnedrive.ts:547`)填 `OnedriveConfig`。
- `username` 经现有 `getUserDisplayName`(Graph /me,不变)——DCF 不碰。
- refresh 复用现有 `sendRefreshTokenReq`(不变)。
- 轮询:`authorization_pending`→续、`slow_down`→增 interval、`authorization_declined`/`expired_token`/`bad_verification_code`→返失败型;`cancel` 信号 + `expires_in` 截止。
- **type-only** import 响应类型 from `fsOnedrive`;**无 runtime import** from `fsOnedrive`/obsidian(模块须在纯 Node 可加载)。

**谁用**:
- **CLI(Node)**:本模块。
- **手机 Obsidian(Capacitor,2026-10-14 Phase 3)**:本模块——因 §2.4 msal-node 不能跑 webview,手机 DCF 只能手写;本模块用原生 fetch、无 PKCE/crypto,webview 可跑。→ **一次设计交付 CLI + 手机 Phase 3**。

**msal-node 去留**:仅保留桌面浏览器流 `getAuthCodeUrl`+`CryptoProvider.generatePkceCodes`(`getAuthUrlAndVerifier:396`,不变)。不引入 `acquireTokenByDeviceCode`/`ICachePlugin`(避免 msal-cache 与现有 `OnedriveConfig` 双轨)。

**理由**:
1. §2.4:msal-node 不能跑手机 → 手机 DCF 必手写;与其 CLI 用 msal-node、手机另写一套,不如共用一个手写模块。
2. 现有 `sendAuthReq`/`sendRefreshTokenReq` 已是手写 token fetch,风格一致;`OnedriveConfig` 已有 `refreshToken` 字段,手写 DCF 直接填,无架构错位。
3. device-code grant 无需 PKCE → 无 crypto → 手机可跑(§2.4 瓶颈正是 crypto)。

**轮询健壮性**:认 `authorization_pending`/`authorization_declined`/`bad_verification_code`/`expired_token`(§2.1 官方表)+ `slow_down`(§2.1 gap,按 RFC 增 `interval`)。`cancel` 信号支持(Ctrl-C)。

### 4.3 状态分叉:选项 A(决定)

`minimal_intrusive_design.md`:0.4.1 起不往远端传 metadata,"上次同步状态"本地存。CLI 与插件会各自维护本地状态 → 认知分叉 → 互判新增/删除 → 假冲突。

**选 A**:CLI 状态初始化为空 → 每次启动当**首次同步全量对账**(已有逻辑:`deltaLink` 空则全量枚举),且**不与插件并发运行**。
- 尊重 `minimal_intrusive_design`(不往远端写 metadata)。
- 复用现有首次同步 reconcile 路径。
- 否决 C(远端共享快照):与该设计原则打架 + 最重 + `FakeFs` 的会话级字段往远端写需大改。
- 否决 B(单向):有用但限价值;留作日后选项,不阻塞 v1。

**操作约束(文档化)**:CLI 与插件不得同时跑同一 vault;推荐"插件关 → CLI 跑 → 插件开"或容器独占。

### 4.4 许可证门(开放,gate 分发)

`LICENSE`+`LICENSE.pro`:`PolyForm Strict` 覆盖 `src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts`。CLI 的**核心**(同步算法+三方合并)正活在 `sync.ts`+`conflictLogic.ts`。

- **个人自用**:OK。
- **公开发布(npm/Docker)**:会打包 PolyForm Strict 代码 → 须先定许可策略(保持 source-available PolyForm / 私有 / 洽商)。**gate Phase E**(§8)。

### 4.5 client_id 复用(决定)
CLI 必须用插件同一 `client_id`(`5be03f08-...`)与 authority(`/common`),否则 App Folder 不同(§2.5)。注入:CLI 走 **env/配置文件**,不依赖 esbuild `define`(CLI 构建可沿用同一 define,但运行时也可 env 覆盖,便于多注册测试)。

### 4.6 CLI 形态(建议)
```
odsync login --device-code
odsync sync --vault <path> --once | --watch [--dry-run] [--verbose]
odsync status
odsync resolve --list | --keep-local <p> | --keep-remote <p>
```

### 4.7 token 持久化(建议)
CLI 配置文件(如 `~/.config/ods/config.json`,`0600`)存 `OnedriveConfig` 等价 JSON(可复用 `configPersist.ts` 的 `normalConfigToMessy` 混淆,或明文+0600)。`0600`/XDG 为通用 POSIX 约定(非 MS 文档要求,§2.5 Q5 残留)。

---

## 5. 现状审计(改造前基线,codegraph 逐字核实)

| 项 | 现状 | 证据 |
|---|---|---|
| 本地 fs | `FakeFsLocal extends FakeFs`,全经 `vault.adapter.*`+`statFix`/`mkdirpInVault` | `fsLocal.ts:9-247` |
| 状态库 | localforage,`InternalDBs` 10 表(`versionTbl`/`syncPlansTbl`/`vaultRandomIDMappingTbl`/`loggerOutputTbl`/`simpleKVForMiscTbl`/`prevSyncRecordsTbl`/`profilerResultsTbl`/`fileContentHistoryTbl`/`fileHistoryTbl`†/`syncMappingTbl`†) | `localdb.ts:51-70`;†legacy 留迁移 |
| localforage 扩展 | `localforage-getitems`/`localforage-removeitems` 原型扩展 | `localdb.ts:3-5` |
| auth(URL) | msal-node `getAuthCodeUrl`+`CryptoProvider.generatePkceCodes` | `fsOnedrive.ts:396-428` |
| auth(token) | 手写 fetch(`sendAuthReq`/`sendRefreshTokenReq`) | `fsOnedrive.ts:453/510` |
| auth 回调 | `obsidian://${COMMAND_CALLBACK_ONEDRIVE}` | `fsOnedrive.ts:38` |
| `OnedriveConfig` 形状 | `accessToken`/`clientID`/`authority`/`refreshToken`/`accessTokenExpiresAtTime`/`deltaLink`/`username`/`emptyFile`/`kind` | `baseTypes.ts:38-51` |
| HTTP 瓶颈 | `graphRequest`(`requestUrl`→`GraphResponse`:status/ok/headers/text/json/arrayBuffer) | `fsOnedrive.ts:93-134` |
| `InternalDBs` 消费 | 51 处调用(debugMode/fileContentHistory/profiler/sync…) | blast radius |
| 状态 KV 用法 | auth/`prevRemoteEntities` 存 `simpleKVForMiscTbl`(`${vaultRandomID}-*` 键) | `localdb.ts:681-728` |
| 构建 stubs | `nodeCryptoStubPlugin`(node:crypto→crypto-browserify)、`nodeUrlStubPlugin`、`localforageScriptStubPlugin`、`inlineWorkerPlugin` | `esbuild.config.mjs:139-154,275-281` |
| `browser` field | `fs/http/https/net/tls/vm=false`;`path/crypto/stream/url` shim | `package.json:15-27` |
| client_id/authority | esbuild `define` 全局,env(`ONEDRIVE_CLIENT_ID`/`ONEDRIVE_AUTHORITY`)可覆盖 | `esbuild.config.mjs:34-37` |
| obsidian 桩(test) | `tests/_obsidianStub.ts`(`Module._load` 劫持) | `tests/` |
| config 混淆 | `messyConfigToNormal`/`normalConfigToMessy`(base64+reverse) | `configPersist.ts:17-66` |
| approot 布局/SCOPES/authority/token body | 见 2026-10-14 spec §5(沿用,Tier-1 已删 body `tenant`) | — |

---

## 6. 风险

1. **状态分叉**(§4.3):并发运行 → 数据冲突。缓解:文档警告 + (可选)CLI 启动检测插件锁文件。
2. **PolyForm 分发**(§4.4):公开发布打包 PolyForm 代码。缓解:gate Phase E,先定许可策略。
3. **msal-node webview**(§2.4):已定手写 DCF 规避;残留为缺官方免责原句(不影响实现)。
4. **node 构建 stub 残留**(§4.1⑤):去 stub 不彻底 → runtime 报错。缓解:构建后 smoke test(Node import src + 真实目录 walk)。
5. **Obsidian-config-sync 缺失**(§3.3):CLI 不同步 `.obsidian`;用户预期管理(文档明示)。
6. **`request`(非 `requestUrl`)用法**(§4.1④):`fsOnedrive.ts:9` 同时 import `request`+`requestUrl`;须确认 `request` 调用点一并换 fetch。

---

## 7. 测试矩阵

| 场景 | 验证 |
|---|---|
| Node import smoke | 纯 Node 下 `import` src 不抛(stub 生效) |
| 真实目录 walk | `NodeFs.walk()` 对真实 vault 递归枚举正确 |
| DCF 单测 | mock `/devicecode`+`/token`,断言 `authorization_pending`→重试、`expired_token`→终止、`slow_down`→增 interval、返回填 `OnedriveConfig` |
| DCF 真实登录 | 个人 MSA 经 `/common` 完成,token + RT 落配置文件 |
| 双向同步 | vault↔OneDrive 双向,与插件相同语义 |
| 状态空全量对账 | CLI 首跑(`deltaLink` 空)→ 全量枚举,无假冲突 |
| refresh 续期 | RT 过期→`sendRefreshTokenReq` 续期成功 |
| 交替运行(不并发) | 插件关→CLI 跑→插件开,无状态损坏 |
| 手机 Phase 3(共享模块) | Obsidian 手机 import DCF 模块,完成设备码登录,不触发 `AADSTS165000` |

---

## 8. 分阶段

- **Phase A(共享 DCF 模块)**:手写 `acquireByDeviceCode()`+单测(mock 端点)。**顺带交付手机 Phase 3**(模块可被 Obsidian 手机运行时 import)。
- **Phase B(Node 适配四件套)**:`NodeFs`+`NodeDb`+`graphRequest` node fetch 分支+`obsidian` 桩生产化(`src/platform/node/`)。smoke:Node 下 import src + walk 真实目录。
- **Phase C(CLI 装配)**:`cli/index.ts` 装配四件套+`odsync` 命令(`login`/`sync`/`status`/`resolve`)+配置文件(`0600`)+`client_id` env。
- **Phase D(独立构建 + 集成)**:独立 node-platform esbuild target(去 stub)+ 构建 smoke + 真实个人账户 DCF 登录 + 双向同步验证。
- **Phase E(分发,gated by §4.4)**:许可决策后——Docker/公开 npm。未决策前不做。

Phase A 可**独立先行**(只动鉴权,不碰 fs/db/build);且它就是手机 Phase 3,价值独立。

---

## 9. 决策与开放问题

### 已定
- 状态分叉:**A**(空状态+全量对账,不并发)。
- DCF:**手写共享模块**(CLI+手机),不引入 msal-node `acquireTokenByDeviceCode`/`ICachePlugin`。
- `client_id`:复用插件同一 (`5be03f08-...`)+`/common`。
- personal-only(沿用 2026-10-14)。
- 范围 OUT:Obsidian-config-sync、企业、并发运行、替换桌面插件。

### 开放(待用户)
1. **许可证**:个人自用 vs 公开发布?(gate Phase E)
2. **CLI 配置文件位置**:`~/.config/ods/` vs XDG_CACHE vs 自定义?
3. **`--watch`**:先只 `--once` 还是同时做文件监听?
4. **并发检测**:CLI 启动是否检测插件锁文件(防并发)?
5. **NodeDb 后端**:单 JSON 文件(简单)vs `better-sqlite3`(性能,新依赖)?
