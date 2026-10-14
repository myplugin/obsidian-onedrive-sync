# 多账户 OneDrive 支持:从 App Folder 迁移到路径式布局设计

- **日期**:2026-10-14
- **状态**:已决定收窄范围 —— 放弃企业/工作或学校账户(含 Microsoft 365 教育版)支持,保持**个人专用**。
- **范围修订(2026-10-14,用户决定)**:§4 的 approot→路径式迁移(**Phase 2**)**取消**——其唯一目的是支持企业/工作账户,既已放弃,approot 个人架构保留。理由:支持企业须把 scope 从沙箱 `Files.ReadWrite.AppFolder` 扩成全 drive 写 `Files.ReadWrite`(微软对 Business 无最小权限沙箱替代,§2.1/§2.2),用户不愿接受该权限扩大。本 spec 的官方文档核验(§2)作为**参考资料保留**;**仅 Phase 3(手机 DCF,对个人用户也有效)作为剩余开发项**。文末 §9 决策已据此更新。
- **关联会话**:lib-1(MS 官方文档核验:approot/权限/token/DCF)、obs-1(手机 165000 截图)、本会话代码审计
- **相关文件(PolyForm 授权,改造需尊重许可证)**:`src/sync.ts`;以及 `src/fsOnedrive.ts`、`src/driveItemConvert.ts`、`src/syncOptimize.ts`、`src/baseTypes.ts`、`src/main.ts`、`src/settings.ts`、`src/importExport.ts`、`src/localdb.ts`

---

## 1. 背景与问题

当前插件**只能给个人 Microsoft 账户(OneDrive 个人版)用**,不支持企业/工作或学校账户(OneDrive for Business)。文档已明示:`docs/remote_services/onedrive/README.md:11-13` —— "This plugin only works for 'OneDrive for personal', and not works for 'OneDrive for Business' (yet)."

用户目标:**彻底支持所有 Microsoft 账户类型**(个人 MSA + 工作/学校 OneDrive for Business)。Azure 应用注册的"受支持帐户类型"已是"所有 Microsoft 帐户用户"(common 多受众),但**代码层面有个人专用的硬限制**。

### 1.1 个人专用的根因(架构层,非小修可解)

整个远程布局建在 **OneDrive App Folder** 上:

- `SCOPES = ["User.Read", "Files.ReadWrite.AppFolder", "offline_access"]`(`fsOnedrive.ts:38`)—— `Files.ReadWrite.AppFolder` 是 **App Folder 专用、个人账户专用**的委托权限。
- 所有 Graph 调用走 `/me/drive/special/approot`(approot 特殊文件夹):`fsOnedrive.ts:545/718/725/741/1462/1692`、`syncOptimize.ts:40`(delta)、`driveItemConvert.ts` 的 approot-root 锚定 + `approotRootId` 捕获(`fsOnedrive.ts:737`)。

### 1.2 次要遗留(已修,Tier-1)

token 交换 body 里塞了未文档化的 `tenant: "consumers"`(`sendAuthReq`、`sendRefreshTokenReq`)—— v2.0 auth-code/refresh 两种 grant **都没有 body `tenant` 参数**,URL 路径里的 `/common` 才是权威。已删(本会话 Tier-1,已部署、桌面个人账户测试无回归)。

### 1.3 手机端瞬时登录失败(独立于本设计,但相关)

手机点登录跳 Safari,偶发 `AADSTS165000 "Missing session context cookie"`(ESTS 会话 cookie 在 `/common`→`login.live.com` 联邦往返中没带过去),**重试即自愈**。根因与多账户支持正交,但同一个"鉴权路径"问题。

---

## 2. 官方文档核验(2026,learn.microsoft.com)

> 全部来自 MS Learn 实测可达页(多数 2026 `last_modified`)。完整引用见 lib-1 会话。

### 2.1 App Folder + `Files.ReadWrite.AppFolder` 的账户支持(⚠️ 文档自相矛盾)

- **绑定权限参考表(3 个独立来源,2026)**:明确 `Files.ReadWrite.AppFolder` **只对个人账户有效**,企业列标注 "Not currently supported":
  - https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/permissions_reference?view=odsp-graph-online
  - https://learn.microsoft.com/en-us/graph/api/drive-get-specialfolder?view=graph-rest-1.0(`Files.ReadWrite.AppFolder` 仅出现在 "Delegated (personal)" 列)
  - https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/direct-endpoint-differences?view=odsp-graph-online(Business 列 "Not currently supported")
  - 官方仓库 issue:https://github.com/OneDrive/onedrive-api-docs/issues/682("OneDrive Business does not support Files.ReadWrite.AppFolder")
- **一篇较新概念文(2025)说 both**:"App folder works across OneDrive for work or school and OneDrive for home":
  - https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
- **如何读这个矛盾**:`special/approot` 这个别名在 Business 上"可解析为一个文件夹",但**最小权限的 `Files.ReadWrite.AppFolder` 委托权限在 Business 上不授权**。绑定权限表才是生产可信来源。
- **结论(生产安全假设)**:`Files.ReadWrite.AppFolder` 视为**个人专用**。不要在 Business 上依赖它。

### 2.2 Business 的等价做法(文档推荐,跨账户)

- 用**路径式指定文件夹**(`/Apps/{AppName}/...`)+ **`Files.ReadWrite`** 委托权限。`Files.Read`/`Files.ReadWrite` "valid on both personal Microsoft accounts and work or school accounts"(permissions_reference)。
- app-folder 概念文本身说 approot "typically named after your app, and is found in the **Apps** folder" —— 路径式即复刻这个物理位置。
- **代价**:`Files.ReadWrite` 比 `Files.ReadWrite.AppFolder` **更宽**(整个 drive 根树的写权限,而非应用沙箱)。Business 上**无最小权限沙箱等价物**(文档未提供,是固有限制)。
- 端点:`GET /me/drive/root:/Apps/{AppName}:/children`、`PATCH /me/drive/root:/Apps/{AppName}/{file}:/content` 等(标准 by-path driveItem 操作)。

### 2.3 v2.0 token 端点(common 多受众)

- URL 路径 `POST https://login.microsoftonline.com/common/oauth2/v2.0/token`,`/common` 同时服务个人 + 工作/学校。
- auth-code grant 与 refresh grant 的 body 参数**均无 `tenant`**(只有 client_id/scope/code/redirect_uri/grant_type/code_verifier 或 refresh_token)。**body `tenant` 未文档化**,路径 `{tenant}` 才权威。已在 Tier-1 删除。
- 来源:https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow 、https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols

### 2.4 authority 一致性

- authorize 与 token **用同一 tenant 路径**;多受众必须 `/common`(`/consumers` 拒企业,`/organizations` 拒个人)。Mixing `/consumers` authorize + `/common` token 是错的(本会话早先回退的 `/consumers` 改法即因此被否)。
- MSAL 官方 sample:多受众 app 默认用 `/common`。

### 2.5 Device Code Flow(common 多受众,手机稳)

- DCF 对 common 注册**同时支持个人 + 工作/学校**。`/devicecode` 与 `/token` 的 `tenant` 用 `/common`。
- **手机更稳的文档依据**:DCF 协议文原话 "the device is unable to access the user's cookies" —— 插件侧 token 获取**不依赖**浏览器 cookie/会话状态,故绕开 `AADSTS165000` 那条浏览器 authorize→联邦登录链路。
- **注意**:DCF 的 `/token` 请求**有**文档化的 body `tenant` 参数("the same tenant used in the initial /devicecode request")—— 与 auth-code 流不同,这是唯一合法带 body `tenant` 的流。
- 来源:https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code 、https://learn.microsoft.com/en-us/entra/identity-platform/authentication-flows-app-scenarios
- ⚠️ `AADSTS165000` 本身**不在**当前官方错误码表(reference-error-codes)内,是运行时经验现象;但"DCF 不依赖浏览器 cookie"原则有文档背书。

### 2.6 自定义 scheme redirect URI(`obsidian://`)

- MS **推荐**的 public-client redirect:`https://login.microsoftonline.com/common/oauth2/nativeclient`(嵌入式浏览器)或 `http://localhost`/`https://127.0.0.1`(系统浏览器)。
- 自定义 scheme(如 `msal{clientId}://auth`、本插件 `obsidian://obsidian-onedrive-sync`)**可用**(MSAL 自身也用),但 Learn 协议/reply-URL 文档**未将其列为推荐** —— 是可用但非文档推荐的社区模式。
- 来源:https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow 、https://learn.microsoft.com/en-us/entra/identity-platform/reply-url

---

## 3. 目标 / 非目标

### 3.1 目标

1. **支持所有 Microsoft 账户**:个人 MSA + 工作/学校 OneDrive for Business,同一套代码、同一应用注册。
2. **不丢个人用户的数据**:现有个人用户的远程文件原地可用(见 §4.2 关键洞察)。
3. **修手机登录可靠性**:加 DCF 鉴权路径,消除/规避 `AADSTS165000`。
4. **文档先行**:本设计每条决策有 §2 官方文档背书。

### 3.2 非目标

- 不做 OneDrive for Business 的 SharePoint 站点同步(只做用户个人 OneDrive,含 Business 版个人 OneDrive)。
- 不实现真正的最小权限沙箱(Business 上文档未提供,`Files.ReadWrite` 全 drive 写权限是已知 trade-off,见 §4.3)。
- 不重写同步算法 v3(只换远程布局的"路径前缀 + 权限 + 鉴权",walk/delta/If-Match 逻辑复用)。
- 不改加密(rclone/openssl)与本地 FS 层。

---

## 4. 设计

### 4.1 决策 A:远程布局 approot → 路径式 `/Apps/{AppName}/{remoteBaseDir}/`

**统一用路径式 + `Files.ReadWrite`**(跨账户),不再用 `special/approot` + `Files.ReadWrite.AppFolder`。

- `SCOPES`:`"Files.ReadWrite.AppFolder"` → `"Files.ReadWrite"`(其余 `User.Read`/`offline_access` 不变)。**两类账户都有效**(§2.2)。
- 所有 Graph 路径前缀:`/me/drive/special/approot:/{remoteBaseDir}` → `/me/drive/root:/Apps/{AppName}/{remoteBaseDir}`(App Folder 物理位置即 `/Apps/{AppName}`,§2.2)。
- **`{AppName}` 兼容双名**(用户决定:都兼容):候选 = `onedrive-vault-sync`(新名)和 `obsidian-onedrive-sync`(老名)。walk/_init 时按候选顺序探测 `/Apps/{候选}/{remoteBaseDir}`,命中即用;新装用户用新名 `onedrive-vault-sync`;老用户命中老名 `obsidian-onedrive-sync` 原地用(不强行改名,避免数据"看不见")。命中的名字存进 settings 以复用。
- delta 端点:`/drive/special/approot:/{remoteBaseDir}:/delta` → `/drive/root:/Apps/{AppName}/{remoteBaseDir}:/delta`(`syncOptimize.ts:40`)。path-based delta 仅返回该子树变更(语义等价)。
- 写端点 PUT/PATCH/createUploadSession 的 URL 同步改路径前缀。

### 4.2 关键洞察:个人用户数据原地可用(无需数据迁移)

**approot 物理上就是 `/Apps/{AppName}`**(app-folder 概念文原话)。所以:

- 现有个人用户的文件**已经在 `/Apps/{AppName}/{remoteBaseDir}/`** —— 切到路径式访问的是**同一个物理文件夹**,数据不动。
- 只是**访问路径前缀**(`special/approot` 别名 → `root:/Apps/{AppName}` 真路径)+ **权限 scope**(`AppFolder` → `Files.ReadWrite`)变了。
- ⚠️ 已知 quirk:`docs/remote_services/onedrive/README.md:17` 提到少数用户 approot 物理落成 `/Application/Graph` 而非 `/Apps/{AppName}`(issue #517)。对这部分用户,切路径式后会"看不到"旧数据(在新路径下)。迁移期处理见 §4.5。

### 4.3 决策 B:scope 扩大的 trade-off(必须向用户明示)

- `Files.ReadWrite` 授予**整个 OneDrive 根树的写权限**,非应用沙箱。这是支持 Business 的**固有代价**(§2.2:Business 无最小权限沙箱)。
- 对个人用户也是权限扩大(从沙箱→全 drive)。**必须**:授权页/文档明示"插件可读写你 OneDrive 根目录下任意文件"(实际只读写 `/Apps/{AppName}/{remoteBaseDir}/`,但权限层面是全 drive)。
- scope 变化 → **现有个人用户必须重新授权**(重新点登录)。旧 refresh token 是按旧 scope 颁发的,换 scope 后 refresh 会因 scope 不匹配而失败 → 触发重新登录。这是迁移摩擦,需 Notice 引导。

### 4.4 决策 C:token 端点 `/common`、无 body `tenant`(已 Tier-1)

- authorize + token 都 `/common`(§2.3/§2.4)。已保持。
- auth-code/refresh 的 body **不带 `tenant`**(已删,Tier-1)。
- **DCF 的 `/token` 例外**:带 body `tenant: "common"`(§2.5,device-code 流合法且必要)。

### 4.5 决策 D:迁移期 data.json/DB 处理

- **deltaLink 作废**:旧 deltaLink 是在 `special/approot:/.../delta` 上铸造的,切到路径式 delta 后**不可用** → 首次同步走全量枚举(重新铸造 path-based deltaLink)。一次性代价,可接受。实现:迁移检测后清空 `settings.onedrive.deltaLink`(或在 IndexedDB auth 记录里清)。
- **prevRemoteEntities**:仍有效(实体列表与端点无关),但首次路径式 walk 会全量刷新;可直接清空让其重走(更稳)。
- **approotRootId 锚定逻辑**(`driveItemConvert.ts` 的 `approotRootId` + `deriveKeyFromParentChain`):path-based 下"vault 根"变成 `/Apps/{AppName}/{remoteBaseDir}`,其 id 由 GET 该路径得到(而非 `/special/approot/children` 过滤)。**id-fallback 锚点改为路径式根的 id**。逻辑平行,需重写捕获点(`fsOnedrive.ts:725-737` 的 `_init` 改成 GET `/me/drive/root:/Apps/{AppName}/{remoteBaseDir}` 拿根 id)。
- **`/Application/Graph` quirk 用户**(§4.2):迁移期提供一次性"指定旧 approot 路径"的迁移助手,或文档引导手动 rename。初版可只在文档说明,不自动迁移。

### 4.6 决策 E:手机端 Device Code Flow(独立可先行)

- 手机端加一条 DCF 鉴权路径(与现有浏览器 auth-code 并列,移动端默认用 DCF):
  - 插件 POST `/devicecode`(body `client_id`/`scope`,tenant 路径 `/common`)→ 拿 `device_code` + `user_code` + `verification_uri`。
  - 弹窗显示 `user_code` + "请在任意浏览器打开 microsoft.com/devicelogin 输码"。
  - 轮询 `/token`(body `grant_type=urn:ietf:params:oauth:grant-type:device_code`/`client_id`/`device_code`/`tenant=common`)直到成功/超时。
  - 成功 → 复用现有 `setConfigBySuccessfullAuthInplace` 落库。
- 桌面端**保留**浏览器 auth-code(已工作);可选也提供 DCF(统一)。
- DCF **不依赖**浏览器 cookie(§2.5),规避 `AADSTS165000`;且对 common 注册两类账户都支持。
- **可独立于决策 A 先做**(只动鉴权,不动远程布局)。

---

## 5. 现状审计(改造前基线)

| 项 | 现状 | 证据 |
|---|---|---|
| 远程布局 | approot(`special/approot`) | `fsOnedrive.ts:545/718/725/741/1462/1692` |
| delta 端点 | `special/approot:/{remoteBaseDir}:/delta` | `syncOptimize.ts:40` |
| SCOPES | `Files.ReadWrite.AppFolder`(个人专用) | `fsOnedrive.ts:38` |
| authority | `/common`(默认) | `esbuild.config.mjs:35` |
| token body `tenant` | 已删(Tier-1) | `fsOnedrive.ts:458/494`(已无) |
| approot 根锚定 | `approotRootId` 自 `/special/approot/children` | `fsOnedrive.ts:725-737`;`driveItemConvert.ts` 多处 |
| 手机鉴权 | 浏览器 auth-code(`<a>` 跳 Safari) | `settings.ts:348`(`OnedriveAuthModal`) |
| 文档自述 | "only works for OneDrive for personal" | `docs/remote_services/onedrive/README.md:11-13` |

---

## 6. 风险与开放问题

1. **approot 文档矛盾**(§2.1):3 个绑定权限源说个人专用,1 篇概念文说 both。本设计**不赌**这个矛盾 —— 路径式 + `Files.ReadWrite` 两类账户都能用,无论 approot 在 Business 上到底支不支持。若日后 MS 明确 approot 支持 Business 且有最小权限沙箱,可回切。
2. **scope 扩大**(§4.3):`Files.ReadWrite` 全 drive 写权限。需在授权/文档明示。是否可接受由用户定(本设计假设接受,因 Business 无替代)。
3. **重新授权摩擦**:scope 变 → 现有个人用户必须重新登录。需 Notice + 文档引导。
4. **`/Application/Graph` quirk**(§4.2/§4.5):少数用户旧数据不在 `/Apps/{AppName}`。初版文档引导 rename,不做自动迁移。
5. **path-based delta 的 id-fallback 重写**(§4.5):approotRootId 锚定逻辑是 PolyForm 文件 `driveItemConvert.ts` + `fsOnedrive.ts` 的较复杂部分,改造需尊重许可证 + 充分测试(delta id-fallback 已有测试基线可扩)。
6. **DCF 轮询 UX**:手机端轮询期间的用户提示(倒计时/超时/重试)。参考 MSAL device-code sample。
7. **`AADSTS165000` 非官方错误码**(§2.5):仅经验现象;DCF 的"不依赖浏览器 cookie"是规避它的文档化手段,但不保证 100%(DCF 自身可能有别的瞬时)。

---

## 7. 测试矩阵

| 场景 | 账户 | 验证 |
|---|---|---|
| 个人回归 | MSA | 切路径式后,旧数据原地可见、同步正常、delta 刷新一次 |
| 企业新增 | OneDrive for Business | 登录、scope 授权、`/Apps/{AppName}/` 创建、同步双向 |
| 迁移 | 个人老用户升级 | deltaLink 作废→全量重走、prevRemoteEntities 刷新、重新授权引导 |
| 手机 DCF | 个人 + 企业 | `/devicecode`→输码→轮询→落库;不触发 165000 |
| 手机浏览器 auth-code | 个人 | 仍可用(不删旧路径),观察 165000 是否仍偶发 |
| delta id-fallback | 个人 + 企业 | path-based delta 下,parentReference.path 缺失项仍能按 id 链解析 |

---

## 8. 分阶段(建议,非定案)

> ⚠️ **范围已收窄(2026-10-14)**:用户放弃企业支持,§4 的 Phase 2 **取消**。剩余开发仅 Phase 3。

- **Phase 1(token 修复)**:删 body `tenant`、保持 `/common`。✅ 已完成(Tier-1,已部署,桌面个人账户测试无回归)。
- ~~**Phase 2(远程布局迁移)**~~:~~approot → 路径式 `/Apps/{AppName}/` + `Files.ReadWrite`~~ —— **取消**(放弃企业支持后无必要;approot 个人架构保留)。相关设计 §4.1–§4.5 留作日后若重启用企业的参考。
- **Phase 3(手机 DCF)**:加 DCF 鉴权路径(`/devicecode`→轮询 `/token`,`/common`,对个人用户有效),规避手机端 `AADSTS165000`。**当前唯一剩余开发项**,独立于(已取消的)Phase 2。

---

## 9. 用户决策(记录)

1. ~~接受 `Files.ReadWrite` 全 drive 写权限的 trade-off?~~ —— **拒绝 → 放弃企业/工作或学校账户(含教育版)支持,保持个人专用。** Phase 2 取消。理由已在 README + 设置 desc + 本 spec §4.3 记录(避免用户质疑)。
2. ~~Phase 2 与 Phase 3 谁先?~~ —— Phase 2 取消,无此问题;Phase 3 为唯一剩余项。
3. ~~`{AppName}` 常量取值~~ —— 随 Phase 2 取消而 moot(若日后重启 Phase 2,沿用"双名兼容"结论)。
4. ~~`/Application/Graph` quirk 用户初版只文档引导~~ —— 随 Phase 2 取消而 moot。

---

**本设计为草案。review 通过后,再出 implementation plan(`docs/superpowers/plans/`)。未审阅前不动代码。**
