# OneDrive delta `parentReference.path` 缺失复盘

## 一句话总结

一次"增量 delta"性能优化，把同一个 `/delta` 端点从全量枚举切成增量 token 查询，悄悄跨入了一个文档早已写明（2015 年起）的响应契约——增量 delta 会省略 `parentReference.path`——而既有的转换函数是为全量模式写的、假定 path 永远存在，未随切换重新核对契约，导致仓库根文件夹条目被静默跳过并打出告警。

## 症状

```
classifyDeltaItems: skipping added/modified item (parse failed)
x.parentReference.path is undefinded or null
{"id":"...!s354...","size":0,"parentReference":{"driveType":"personal","driveId":"...","id":"...!sc6a..."}}
```

（另有一条 `504` 重试，是独立的瞬时网关错误，已被重试逻辑处理，与此无关。）

## 根本原因（两层）

### 1. 潜在假设（上游 remotely-save v0.5.25 / 提交 fd38bca）

`fromDriveItemToEntity` 假定 `parentReference.path` 永远存在。这**从来不是文档保证**，只是在"全量 delta"（不带 token）调用方式下经验上成立。`fd38bca` 的 `walk()` 虽然保存了 `deltaLink`，但从未复用它——每次都走全量枚举：

```ts
// fd38bca: 调用 /delta 但不带 token（全量）
let res = await this._getJson(`/drive/special/approot:/${this.remoteBaseDir}:/delta`);
if (DELTA_LINK_KEY in res) { this.onedriveConfig.deltaLink = res[DELTA_LINK_KEY]; } // 存了不用
```

### 2. 触发（本 fork，提交 1ade31d "sync performance optimization"）

这次改动真正引入了增量 delta——通过 `buildDeltaStartUrl(canIncremental, deltaLink, …)` 复用 `deltaLink` 作为 token，只取变更项。从此进入微软 Graph delta 协议的**另一个响应契约**：带 token 的增量 delta 会省略 `parentReference.path`（尤其父级是特殊文件夹 approot 的条目，即仓库根文件夹）。转换函数没有跟着新契约更新，对根文件夹条目抛错 → `classifyDeltaItems` 静默跳过 → 用户看到的告警。

> 全量模式下要么不返回根文件夹条目，要么带 path，所以旧代码不报错；增量模式下根文件夹在其自身子树变化时会作为变更项返回，且不带 path。

## 这是一个可复用的模式

> 同一 API、同一端点、同一字段名，只因"调用方式"切换（全量→增量、list→delta、item→batch、v1→beta），就跨入了不同的响应契约；而既有代码的字段假设是为旧调用方式写的，从未与新契约核对。

危险在于：diff 看不到（字段名没变）、typecheck 看不到（都是 string）、happy-path 测试看不到（fixture 带 path）。唯一能看到的地方是**文档的 Remarks/备注**——恰恰是大家最不爱读的段落。

## 证据

### Git 考古

- `fd38bca`（上游 v0.5.25 基线）：`/delta` + `deltaLink` 已存在，但 `deltaLink` 存而不用，走全量枚举。
- `1ade31d` "feat: sync performance optimization"（`fsOnedrive.ts` 改了 510 行）：引入 `buildDeltaStartUrl` / `prevRemoteEntities` / 增量合并，真正把 delta 改成增量。
- `a169151` / `b751528`：后续在增量基础上补 `classifyDeltaItems` 删除检测与 404 自愈。

### 文档史（@librarian + Wayback Machine）

"`parentReference.path` 在 delta 中会被省略、应始终用 id 追踪"这条 Remarks **自 2015-09-10 就写在文档里，10 年未变**：

- 2015-09-10 `dev.onedrive.com/items/view_delta.htm`（原始 OneDrive API，pre-Graph）已含该条；
- 2016-04、2016-11 快照同文；
- Graph v1.0 迁移后（`ms.date: 09/10/2017`）由 `view.delta` 改为 `delta` 措辞，内容不变；
- 至今 `learn.microsoft.com/en-us/graph/api/driveitem-delta` 仍在。

原文：

> The `parentReference` property on items won't include a value for `path`. This occurs because renaming a folder doesn't result in any descendants of the folder being returned from delta. When using delta you should always track items by id.

## 为什么没被拦住

- 测试用的是真实条目（都带 path），测的是 happy path，不是文档声明的边界。
- typecheck、diff、类型都绿——失败只藏在文档 Remarks 里。
- "性能优化"被当成不改变响应形状的改动，没有触发对字段假设的重新核对。

## 已应用的修复

- `src/deltaMerge.ts`：新增纯函数 `isApprootRootDriveItem(item, remoteBaseDir)`，识别 approot 根文件夹（无 path + `name === remoteBaseDir` + `folder` 属性）。
- `src/fsOnedrive.ts`：转换函数识别到根文件夹时返回 `key: "/"`，由既有的 `entity.key !== "/"` 过滤器干净丢弃，不再抛错。非根的缺 path 条目仍走原逻辑（无回归）。
- `tests/deltaMerge.test.ts`：7 条 spec-driven fixture，含告警里那条数据的精确形态。

## 防范 checklist

任何改动若改变了"如何调用一个外部 API"（全量→增量、list→delta、item→batch、v1→beta、换端点、换权限），必须过这四关：

1. **重读端点 Remarks**：针对新的调用方式，重新读该端点文档的 Remarks/备注，尤其是 "may be omitted / nullable / conditional / track by id / you should always" 这类句子。
2. **字段依赖核对**：列出代码依赖的每个字段；逐字段确认在新调用方式下是否仍被文档保证存在。若某字段无文档保证、只是"经验上存在"，标记为脆弱并配 fallback。
3. **契约 delta**：产出"旧响应契约 vs 新响应契约"的差异说明；没有这个 delta，优化/重构应被拦下。
4. **spec-driven fixture**：为文档里每一条"may be absent / nullable"补一条 fixture 测试，在切换落地当天就会红。

对 code agent 的硬约束：

- 写对接外部 API 的代码前，必须先 fetch 官方文档（context7/librarian）并在计划里引用相关 Remarks 原文，禁止凭记忆写集成代码。
- 把文档里的 "you should always / may be omitted / nullable / conditional" 当成硬约束，读完若仍写无 fallback 的字段访问，视为契约违反、自检报红。

## 引用

- 微软文档：https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- 2015-09-10 快照：https://web.archive.org/web/20150910133941id_/https://dev.onedrive.com/items/view_delta.htm
- 触发提交：`1ade31d` feat: sync performance optimization
- 基线：`fd38bca` scaffold from v0.5.25
- 修复：`src/deltaMerge.ts` `isApprootRootDriveItem`、`src/fsOnedrive.ts` 转换函数、`tests/deltaMerge.test.ts`

---

## 后续（2026-09-21）：非根项 id 回查 fallback

本复盘的"防范 checklist"第 2 条要求"若某字段无文档保证…标记为脆弱并配 fallback"。134aac9 只补了根文件夹一个实例；非根项的 path 缺失仍走 throw→跳过→自愈。这次按 checklist 把 fallback 补全。

### 修复（增量式，path 在时行为不变）

- `Entity` 加 `remoteId?: string`（Graph `driveItem.id`，稳定）。
- 转换器拆分（行为保持）：`extractDriveItemMetadata`（纯，path 缺失不 throw）+ `deriveKeyFromPath`（path 缺失 throw）+ `fromDriveItemToEntityWithIdFallback`（path 缺失时用 `item.id` 去 prev 的 `id→key` 映射查已知 key 复用——覆盖修改场景）。
- `classifyDeltaItems` 加可选 `idToKeyMap`；`buildIdToKeyMap` 从 `prevRemoteEntities` 建 `remoteId→keyRaw` 映射。
- `walk()` 增量分支建映射 + 传 fallback 转换器 lambda。全量/walkPartial 不变（经验上有 path，且无 prev 可建映射）。
- 新文件 path 缺失（无 prev 条目）仍自愈（无 path 无法定位，罕见）。

### 新教训

1. **行为保持的 throw 顺序**：转换器拆分必须保持 `approot根 → remoteItem/package → path缺失 → mtime` 的 throw 顺序。一个"无 path 且无 fileSystemInfo"的项必须 throw "path undefinded" 而非 "cannot parse mtime"——`tests/driveItemConvert.test.ts` 的 `assert.throws` 测试钉死了这一点。拆分时 `deriveKeyFromPath`（path throw）必须在 `extractDriveItemMetadata`（mtime throw）之前调用。

2. **测试绑定的闭包陷阱**：把 4 参数函数当 3 参数 converter 类型传入不工作（多出的参数落错位；删除分支传 `false` 会落到 `requireMtime`）。正确做法是用闭包 lambda 捕获映射：`(item, dir, req) => fromDriveItemToEntityWithIdFallback(item, dir, idToKeyMap, req)`——与运行时接线一致 + 类型安全。

3. **错误耦合用 `.code` 不用 message 字符串**：catch 匹配 throw 时用稳定的 `.code`（如 `ONEDRIVE_PATH_MISSING`），不用 `e.message.includes("...")`。message 里可能有历史拼写错误（"undefinded"），若有人只修了 throw 里的拼写而忘了改 catch，fallback 会静默失效（退回 re-throw→自愈，不丢数据但修改场景的 id 回查就不工作了）。镜像 `remoteEtagMismatchError`/`remoteNotFoundError` 的 `Error + .code` 模式。

4. **`prevRemoteEntities` 是 session 级的**：每次 plugin load 都清空（`main.ts:712`）→ 新增 Entity 字段无需长期迁移；session 首次全量即填充。

5. **流程**：systematic-debugging（Phase 1 根因）→ brainstorming（方案）→ spec → writing-plans → subagent-driven（单次 fixer 跑完 + 末尾 oracle 审）→ 硬化。对小计划（4 task、多为行为保持重构）比逐 task SDD 轻。

### 环境踩坑

- **commit hash 重写异常**：本环境每次 commit 后 hash 被外部重写（内容逐字一致，`git diff` 空）。信任 HEAD，不信打印的 hash。review 范围用 `base..HEAD`。
- **PowerShell temp-dir 权限**：`C:\Users\...\Temp\opencode` 写入被 PermissionDenied 拒。改用 repo 内 `.superpowers/sdd/` 放 review diff 包。
- **`.gitignore` 忽略 `.*`**：`.superpowers/`（scratch）被忽略；`docs/superpowers/`（不以 `.` 开头）不被忽略→会被 commit。设计文档放 `docs/superpowers/`，scratch 放 `.superpowers/`。

### 引用

- spec：`docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md`
- plan：`docs/superpowers/plans/2026-09-21-onedrive-delta-id-fallback.md`
- commits：`9338c99`→`a99553e`→`9c5ff76`→`bd01d02`→`b64f720`（.code 硬化）
