# OneDrive 并发保护:If-Match 乐观并发控制改造设计

- **日期**:2026-09-20
- **状态**:草案,待用户 review
- **关联会话**:ora-1(并发分析)、lib-1(OneDrive If-Match 文档核验)
- **相关文件(PolyForm 授权,改造需尊重许可证)**:`src/sync.ts`、`src/conflictLogic.ts`;以及 `src/fsOnedrive.ts`、`src/driveItemConvert.ts`、`src/baseTypes.ts`、`src/localdb.ts`、`src/main.ts`、`src/syncOptimize.ts`

---

## 1. 背景与问题

当两台设备同时安装并运行本插件、同步到同一个 OneDrive App Folder,且同时(或时间重叠地)修改文件时,存在**静默丢数据**风险。

### 1.1 失败模式 A:盲覆盖(本设计的主要防御对象)

时间线(两台设备 A、B,同一个文件 X,上次共同同步点为 P):

1. T0:A、B 都同步过,`prevSync[X] = P`
2. T1:A 改 X→X_A;B 改 X→X_B
3. T2:A 开始同步,walk 看到 `remote X = P`(还没人动)→ 判 `local_is_modified_then_push`(`sync.ts:887`),上传 X_A
4. T2.5:B 开始同步(与 A 重叠),walk 仍看到 `remote X = P`(A 还没传完,或 OneDrive 最终一致性延迟未暴露)→ 也判 `local_is_modified_then_push`
5. T4:B 上传 X_B,`conflictBehavior:"replace"`(`fsOnedrive.ts:1049,1078`)→ **X_A 被覆盖,A 的编辑静默丢失,无报错、无冲突、无 .dup**
6. 下一轮:A 的 walk 看到 `remote X = X_B`,`remoteEqualPrevSync=false`,`localEqualPrevSync=true` → `remote_is_modified_then_pull`(`sync.ts:860`)→ A 下载 X_B,本地的 X_A 也被覆盖。**系统静默收敛,数据丢失无任何痕迹。**

### 1.2 根因

- **无跨设备锁**:唯一的 mutex 是单设备内的 token 刷新锁(`fsOnedrive.ts:325`),与跨设备协调无关。
- **快照-执行模型**:`syncer`(`sync.ts:2046-2256`)在 step 3 walk 一次远端(`sync.ts:2107`),step 6 建计划(`sync.ts:2154-2184`),step 7 执行(`sync.ts:2206-2221`),**执行期间不再重读远端**。
- **写入用盲覆盖**:所有写操作 `@microsoft.graph.conflictBehavior:"replace"`(`fsOnedrive.ts:441,953,1049,1078,1084`)。
- **无乐观并发控制**:全仓 grep `If-Match|if-match|lockFile|\.lock` 无任何命中。

### 1.3 已被保护的部分(不在本设计范围内)

- **可见冲突**(`prevSync` 存在 + 双向都改):已走 `conflict_modified_then_smart_conflict`(`sync.ts:997-1001`)→ `mergeFile`(`conflictLogic.ts:113-178`)做 3-way 合并(.md≤1MB)或 `tryDuplicateFile`(`conflictLogic.ts:344-395`)双存 `.dup`。本设计不重复造这部分,只是**让盲覆盖路径也能被导流到这里**。
- **walk 与 stat/download 间的删除竞态**(`fsOnedrive.ts:89-101`):已有 `REMOTE_NOT_FOUND` 自愈机制(`main.ts:388-400`)。

---

## 2. 目标 / 非目标

### 2.1 目标

1. **不静默丢数据**:两台设备并发写同一文件时,被覆盖的一方内容必须被保留(合并或 `.dup`),且**用户有感知**(通知 + 日志)。
2. **平时零额外开销**:单设备、无并发时,每次上传不引入显著的额外网络往返。
3. **复用已有冲突处理**:412 触发后,复用现有 `mergeFile` / `tryDuplicateFile`,不另写一套备份逻辑。
4. **补 OneDrive 并发机制 reference 文档缺口**:把"OneDrive 提供哪些并发机制 + 本插件如何使用它们"落地为 `docs/remote_services/onedrive/concurrency.md`。

### 2.2 非目标

- 不实现真正的跨设备分布式锁(OneDrive App Folder 无文件锁原语,自建锁文件不可靠且高延迟)。
- 不重写同步算法的快照-执行模型(仅在写入点加预检,不重排 walk/plan/execute)。
- 不解决 `keep_newer` / `keep_larger` 冲突策略下的丢数据(那是用户显式选择,不在本设计范围;本设计聚焦 `smart_conflict` + 默认 push 路径)。
- 不保证 100% 无丢数据(理论 TOCTOU 窗口见 §8.1),目标是把"静默"变"有声"、把概率从"高"降到"极低"。

---

## 3. 现状审计(改造前基线)

| 项 | 现状 | 证据 |
|---|---|---|
| 跨设备锁 | 无 | grep 全仓无 `If-Match\|lockFile\|\.lock` |
| 写入冲突行为 | `replace`(盲覆盖) | `fsOnedrive.ts:441,953,1049,1078,1084` |
| 小文件/大文件阈值 | 4 MB | `fsOnedrive.ts:1039` `DIRECT_UPLOAD_MAX_SIZE = 1000*1000*4` |
| 小文件上传路径 | `PUT /content` 一次直传 | `fsOnedrive.ts:1041` |
| 大文件上传路径 | `createUploadSession` 分块 | `fsOnedrive.ts:1074-1099` |
| `Entity.etag` 字段 | 已声明但**死代码**(未接通) | `baseTypes.ts:200` 声明;`driveItemConvert.ts` 无 `eTag` 映射;唯一赋值 `localdb.ts:106` 来自本地 DB 非 Graph |
| etag 从 delta 获取 | **优化 delta 路径丢弃了 eTag** | `syncOptimize.ts:8` 注释"drops cTag, eTag, etc." |
| etag 从 stat 获取 | 已有 stat 带 `$select=cTag,eTag,...` | `fsOnedrive.ts:920` |
| 写后 fileSystemInfo | 小文件 PUT 后**单独 PATCH** 设 mtime | `fsOnedrive.ts:1047-1059` |
| `deferCommit` | 未使用 | `fsOnedrive.ts` 无 `deferCommit` |

---

## 4. OneDrive 并发机制 reference(草稿,实施时抽到 `docs/remote_services/onedrive/concurrency.md`)

> 本节内容在实施阶段落地为独立 reference 文档 `docs/remote_services/onedrive/concurrency.md`,补 `docs/remote_services/onedrive/README.md`(目前仅 33 行 FAQ)的缺口。下为草稿。

### 4.1 etag / cTag(版本号)

- **etag**:OneDrive 自动给每个 driveItem 维护的版本号,格式如 `012345819293.1`,**不透明,按字节精确比较**。
  - `eTag` = "eTag for the **entire item (metadata + content)**" → 元数据**或**内容变都变。
  - `cTag` = "eTag for the **content** of the item" → 仅内容变才变;**文件夹不返回 cTag**。
- **来源**:https://learn.microsoft.com/en-us/graph/api/resources/driveitem
- **持久性**:持久。存在 OneDrive 上,是文件自带属性,查文件信息时一并返回。文件被改,版本号自动变。
- **App Folder 可靠返回**:本插件 `fsOnedrive.ts:920` 已在 stat 调用带 `$select=cTag,eTag,...` 证实 App Folder 内容会返回 etag。`appRoot` 是 `/Apps/{AppName}` 的 special-folder 别名,写端点就是普通 driveItem 端点,无 scope 级差异。

### 4.2 If-Match / If-None-Match(乐观并发预检)

- 上传/改时在请求头带 `If-Match: <etag>`,OneDrive 在"核对版本号 + 写入"**一个原子操作**里完成:匹配→写入并轮转新 etag;不匹配→**返回 `412 Precondition Failed`,不写入**。
- **createUploadSession 明确文档支持**(`if-match` / `if-none-match` 列在请求头表):https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- **PATCH 明确文档支持**:https://learn.microsoft.com/en-us/graph/api/driveitem-update ;move 同理:https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/api-reference/v1.0/api/driveitem-move.md
- **PUT /content 文档缺口**:https://learn.microsoft.com/en-us/graph/api/driveitem-put-content 的请求头表只列 `Authorization`/`Content-Type`,**未文档化** `If-Match`。底层是同一 driveItem 写操作,大概率可用,但属未文档化行为 → 见 §6.2 取舍。

### 4.3 @microsoft.graph.conflictBehavior(名字冲突,非内容版本)

- `fail` / `replace` / `rename`:处理**同名文件已存在**时的名字冲突,**不是内容版本**预检。
- 与 `If-Match` **正交且共存**:createUploadSession Example 7 明确"can use `conflictBehavior` and `if-match` headers as expected in the same call"。
- 语义:`If-Match` 是版本预检门控,优先于 `conflictBehavior`。etag 不匹配 → 412,**不**走 replace。
- 来源:https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession (Example 7)

### 4.4 delta(变更跟踪)

- `/delta` 端点跟踪 App Folder 的**所有**变更,不区分哪个客户端产生 → B 的 delta 会包含 A 的上传。问题只是**时序**:A 上传是否落在 B 的 delta 查询之前。
- `deltaLink` 是**每设备**独立状态(`localdb.ts:684`),明确不进 `data.json`(`localdb.ts:673-688`)。
- 优化 delta 路径丢弃 eTag(`syncOptimize.ts:8`)→ **预检用 etag 必须来自 stat 调用,不能依赖 delta**。

### 4.5 /versions(版本历史)

- 某文件的历史版本,可回滚。本设计**不用**(重,且 App Folder 个人版支持有限),作为兜底备选。

### 4.6 生产参考实现

- PnP SDK `packages/graph/files/resumableUpload.ts:46`:`createUploadSession` 同时设 `If-Match` 与 `conflictBehavior`。
- `simstudioai/sim` `apps/sim/lib/internal/microsoft-word/client.ts:250`:`replaceContentIfUnchanged(...)` 带 `if-match`。
- `rocketride-org/rocketride-server` `nodes/.../word/client.py:71`:`upload_docx` 用 `If-Match` "so concurrent edits fail readably, not last-writer-wins"。

---

## 5. 方案设计(总览)

**核心**:在所有 OneDrive 写入点加 `If-Match` 预检;收到 `412` 时,把该文件从盲覆盖路径**导流**到已有的 `mergeFile` / `tryDuplicateFile`(即 §1.3 的可见冲突路径),并触发通知 + 日志。

### 5.1 数据流(改造后)

```
walk (拿 remote etag,记入 Entity.etag)        ← §6.1 接通 etag
  ↓
getSyncPlanInplace (用 prevSync + remote etag 判冲突)
  ↓
local_is_modified_then_push:
  ↓ 上传带 If-Match: <walk时的etag>           ← §6.2/6.3 写入加预检
  ├─ 200/201 (etag 匹配,无人中间动) → 正常完成,re-stat 拿新 etag 入 prevSync
  └─ 412 (etag 不匹配,有人中间动过)
       ↓
     改判为 conflict_modified_then_smart_conflict
       ↓
     mergeFile / tryDuplicateFile (已有,§1.3)  ← 备份(.dup)/ 合并
       ↓
     通知 + 日志                                ← §7
```

### 5.2 三条写入路径的改造点

| 路径 | 现状 | 改造 |
|---|---|---|
| 大文件(≥4MB)upload session | `createUploadSession` 无 If-Match(`fsOnedrive.ts:1095`) | 创建 session 时带 `If-Match: <walk etag>`(文档明确支持)。**零额外往返**(只在创建请求加头) |
| 小文件(<4MB)PUT /content | `PUT` 无 If-Match(`fsOnedrive.ts:1041`) | PUT 请求加 `If-Match` 头(文档未明说,实测)。**零额外往返**。实测不行 → 小文件改走 createUploadSession(每文件多一次创建往返,见 §6.2) |
| PATCH 设 mtime | PUT 后单独 PATCH(`fsOnedrive.ts:1047-1059`) | 用 PUT 响应返回的**新 etag** 作 PATCH 的 If-Match;或把 `fileSystemInfo` 折进 upload session 的 `item` body(大文件路径已这么做 `fsOnedrive.ts:1081-1092`),消除单独 PATCH |

### 5.3 412 导流逻辑(关键新增)

在 `fsOnedrive` 的写入方法捕获 412,向上层(同步执行器)返回一个**可识别的码**(如 `REMOTE_ETAG_MISMATCH`,沿用 `fsAll.ts:29-36` 的 `remoteNotFoundError` 模式)。同步执行器(`dispatchOperationToActualV3` / `sync.ts` push 分支)识别该码后,**改判该文件为 `conflict_modified_then_smart_conflict`**,调用 `mergeFile` / `tryDuplicateFile`,与正常可见冲突走完全相同的后续路径。

> 设计要点:导流而非新写。复用 `conflictLogic.ts` 已有的备份/合并,只是把"原本盲覆盖"的文件也送进这条路径。

---

## 6. 实现细节与陷阱

### 6.1 接通 etag(前置工作)

1. `driveItemConvert.ts` 的 `fromDriveItemToEntity` 把 `driveItem.eTag`(及文件场景的 `cTag`)映射到 `Entity.etag`。
2. `prevSync` 记录写入时带上 etag(`localdb.ts` prevSync 结构),供下一轮 walk 后比对(现有 `mtimeCli/mtimeSvr/sizeEnc` 判等不变,etag 仅用于写入预检,**不**改 `getSyncPlanInplace` 的判等逻辑,避免回归)。
3. **walk 必须能拿到 etag**:优化 delta 路径丢弃了 eTag(`syncOptimize.ts:8`),所以预检 etag 来源是 walk 后对**待写文件**做一次带 `$select` 的 stat(已有 `fsOnedrive.ts:920` 模式),或从非优化 delta 取。这是**唯一**新增的常规往返(仅对待写文件,非全量)。
   - 取舍:可只对 `local_is_modified_then_push` 分支的文件补 stat,跳过 `equal` / `remote pull` 等不写远端的分支,把额外往返降到最小。

### 6.2 小文件 If-Match 取舍(待实测定案)

- **阶段 1(首选)**:小文件 PUT /content 直接加 `If-Match` 头。文档未明说,但底层同 driveItem 写,大概率可用。零额外往返。
- **阶段 2(若阶段 1 实测不可靠)**:小文件也走 `createUploadSession`(文档明确支持 If-Match)。代价:每个小文件多一次"创建会话"的 POST 往返。
- 对本仓库(笔记 md 几乎全 <4MB)影响:小文件是主路径,故阶段 1 成败直接决定整体开销。**实测优先,有退路。**

### 6.3 upload session 的竞态窗口

- createUploadSession 在**创建时**检查 If-Match,不是每分片 PUT。分片上传期间仍可能被别人覆盖。
- 彻底关闭竞态(可选增强):`deferCommit:true` + Example-7 commit 模式(用 `@microsoft.graph.sourceUrl` 的 PUT 带 `If-Match` 在 commit 时再检一次)。本插件现未用 `deferCommit`,作为**可选第二阶段增强**,非 MVP 必需。

### 6.4 PUT-then-PATCH 的 etag 轮转陷阱

- 小文件走 PUT /content:PUT 改内容 → etag 变 → 若 PATCH(设 mtime)还带 PUT 前的 etag → 412 误报。
- 解法(择一,按路径分):
  - (a) PATCH 的 If-Match 用 **PUT 响应返回的新 etag**(适用于**小文件走 PUT /content** 的路径——PUT /content 是裸内容上传,无 `item` body 可折,只能用响应新 etag 续 PATCH);
  - (b) 把 `fileSystemInfo.lastModifiedDateTime` 折进 upload session 的 `item` body,单次提交,消除单独 PATCH(适用于**走 createUploadSession** 的路径:大文件已如此 `fsOnedrive.ts:1081-1092`;若小文件按 §6.2 阶段 2 退到 createUploadSession 也适用)。
- 大文件:(b) 已就绪,无需改。小文件走 PUT:用 (a);若退到 createUploadSession:用 (b)。

### 6.5 写后 re-stat

- 写入完成后 OneDrive 轮转了 etag;上传响应可能不完整带全字段(App Folder 有 `downloadUrl` 不可靠的先例 `fsOnedrive.ts:1224-1227`)。
- 写后对刚写文件 re-stat 一次,拿**新 etag** 入 `prevSync`,供下一轮预检。可借 §6.1 的 stat 通路,合并请求(写后立即 stat)。

### 6.6 eTag vs cTag 选择

- 保守用 **eTag**(任何变更——含元数据——都使预检失败),避免"内容没变但元数据变了"漏检。
- 文件夹无 cTag;本设计预检对象是**文件**,故 cTag 可选,但默认用 eTag 简化。

### 6.7 空文件 / 新建文件

- 空文件:OneDrive 不允许上传空文件(`README.md` 已记),现已有 skip/raise 设置,不受本设计影响。
- 新建文件(远端不存在,首次上传):**无 etag 可带** → 用 `If-None-Match: *` 或不带预检(首次创建本无冲突风险,盲覆盖的是"已存在文件")。此路径保持现状。

---

## 7. 通知与日志设计

**默认推荐:两者都要(Notice + 日志)**——用户可在设置里关其一。

### 7.1 Obsidian Notice(即时感知)

- 收到 412 并导流到 merge/dup 后,弹 Obsidian `Notice`:`"并发冲突: <文件名> 两端都改过,已 <合并/存为.dup>,请查看"`。
- 多文件冲突合并为一条 Notice,避免刷屏。
- 沿用 `main.ts` 现有 Notice 模式。

### 7.2 冲突日志(可回溯)

- 写入固定文件:`<vault>/.remotely-save-onedrive-conflicts.log`(或复用 `_remotely-save-sync-plans` 机制,见 `localdb.ts:17` / `debugMode.ts`)。
- 每条记录:时间戳、文件 key、本地 mtime/size、远端 etag(walk 时 vs 写时)、处置(merge/dup)、结果文件名。
- 设置项:保留天数(默认 30 天)、是否详细。
- **不**写进 vault 同步目录(否则会被当普通文件同步,造成日志本身也冲突)——放 vault 根但加到 sync ignore,或放 `.obsidian/plugins/remotely-save-onedrive/` 下。

---

## 8. 风险与取舍

### 8.1 残余 TOCTOU 窗口(已大幅缩小,未归零)

- upload session:创建时检 etag,分片期间仍可被覆盖(§6.3)。需 `deferCommit` 才彻底关。
- 小文件 PUT+If-Match:OneDrive 原子核对+写入,窗口近乎为零(若 PUT 支持 If-Match)。
- **结论**:MVP 把 Failure Mode A 从"高概率静默丢失"降到"极窄窗口才可能";增强阶段(§6.3)可进一步归零。残余丢失至少有日志痕迹(若 walk etag 与写时 etag 不同 → 记录),不再是"完全无感知"。

### 8.2 etag 未接通的回归风险

- 改 `driveItemConvert.ts` / `localdb.ts` prevSync 结构可能影响既有判等。**对策**:etag 仅用于写入预检,**不改 `getSyncPlanInplace` 的 `mtimeCli/mtimeSvr/sizeEnc` 判等**(§6.1),把改造隔离在写入点 + prevSync 附加字段,降低回归面。

### 8.3 小文件改走 upload session 的开销

- 若 §6.2 阶段 2 启用,每个小文件多一次 createUploadSession POST。对本仓库(单次同步常几个 md)可接受;对大量小文件批量同步(累积数百)有累积延迟。
- 缓解:会话可批量预创建;或仅在"检测到另一设备近期活动"(delta 非空)时启用 If-Match 严格模式,否则走快路径。作为可选优化,非 MVP。

### 8.4 PolyForm 许可证

- `src/sync.ts`、`src/conflictLogic.ts` 为 PolyForm Strict 1.0.0。本设计**新增**导流逻辑到 sync.ts push 分支、**复用** conflictLogic.ts(不改其合并算法)。实施时确认改动的文件清单与许可证一致,PR 按规签署 CLA。

### 8.5 调用方式契约重审(AGENTS.md 规矩)

- 本设计**改了写入调用方式**(裸 PUT → PUT+If-Match,或 PUT → createUploadSession)。按 AGENTS.md "call-mode changes require a contract re-audit",实施时必须对每个改动的端点重读 Remarks,确认 412 响应体、etag 字段在新调用模式下仍保证返回。lib-1 已核验 createUploadSession / PATCH,PUT/content 的文档缺口须实测补齐。

---

## 9. 实施分阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0 前置** | 接通 etag:`driveItemConvert.ts` 映射 eTag→`Entity.etag`;prevSync 带 etag;walk 后对待写文件 stat 取 etag | typecheck + 单测:Entity.etag 正确填充 |
| **P1 大文件** | createUploadSession 加 If-Match;412 捕获与导流到 merge/dup;写后 re-stat | 两设备并发改同一 ≥4MB 文件,验证不静默丢 |
| **P2 小文件(实测)** | PUT/content 加 If-Match 实测;通过则落地,412 同 P1 导流 | 两设备并发改同一 md,验证不静默丢 |
| **P2-fallback(若需)** | 小文件改走 createUploadSession + If-Match | 同 P2 验证 |
| **P3 通知+日志** | Notice + `.log`;设置项 | 手动触发冲突,验证通知 + 日志落地 |
| **P4 reference 文档** | 本 spec §4 抽到 `docs/remote_services/onedrive/concurrency.md` | 文档 review |
| **P5(可选增强)** | deferCommit + Example-7 commit 再检;批量会话预创建 | 竞态窗口归零验证 |

---

## 10. 测试策略

- **单元**:etag 映射;412 码识别与导流判等切换;prevSync etag 读写。
- **集成(两设备并发)**:
  - 不同文件并发 → 不受影响(回归)。
  - 同文件并发,walk 错过 → 验证 412 → merge/dup + 通知。
  - 同文件并发,walk 命中 → 验证原有 smart_conflict 不回归。
  - 删除 + 并发编辑(§Failure Mode E)→ 不静默丢。
- **回归**:单设备正常同步全流程(无 412)开销不显著上升(对比同步耗时)。
- **契约重审**:按 §8.5,重读 createUploadSession / PUT-content / PATCH 的 Remarks。

---

## 11. 回退方案

- 若 If-Match 全路径不可行(理论不会,lib-1 已证可行),退到**读改写 stat 预检**(写前 stat 对比 walk etag,缩小但不归零竞态)+ `.dup` 兜底。
- 极端退路:`conflictBehavior:"fail"`(仅防新建同名冲突,不防覆盖,作为部分兜底,不推荐单独使用)。

---

## 12. 参考链接

- OneDrive etag/cTag:https://learn.microsoft.com/en-us/graph/api/resources/driveitem
- createUploadSession If-Match:https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- driveitem-update If-Match:https://learn.microsoft.com/en-us/graph/api/driveitem-update
- PUT /content(文档缺口):https://learn.microsoft.com/en-us/graph/api/driveitem-put-content
- App Folder 概念:https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/onedrive-sharepoint-appfolder.md
- 生产参考:PnP SDK `resumableUpload.ts`、`simstudioai/sim`、`rocketride-org/rocketride-server`
- 本仓教训:`docs/lessons/onedrive-delta-parentreference-path.md`(call-mode 契约重审先例)

---

## 已确认决策(2026-09-20 用户拍板)

1. **通知形式**:Notice + 日志两者都要(§7.1 + §7.2 全做)。
2. **小文件 If-Match 策略**:阶段 1 实测 PUT/content + If-Match(零额外往返);实测不可靠才退到阶段 2 createUploadSession(§6.2)。
3. **P5 deferCommit 增强**:MVP 不做,竞态窗口不归零(§6.3 / §8.1);留作后续可选增强。
4. **日志位置**:`<vault 根>/.remotely-save-onedrive-conflicts.log`,并加入 sync ignore 列表避免日志本身被同步(§7.2)。
