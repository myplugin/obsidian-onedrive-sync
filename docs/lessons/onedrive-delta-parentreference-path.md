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
