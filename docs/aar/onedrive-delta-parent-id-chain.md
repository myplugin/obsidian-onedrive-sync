# AAR: OneDrive delta `parentReference.id`-chain fallback

**Session:** 2026-09-22
**Related:** `docs/lessons/onedrive-delta-parentreference-path.md`（复盘主线）、`docs/superpowers/plans/2026-09-22-onedrive-delta-parent-id-chain.md`（plan）、`docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md` §7（延期项）

## 触发

用户报反复告警：
```
classifyDeltaItems: skipping added/modified item (parse failed)
x.parentReference.path is undefinded or null
{"id":"...!se6cfd1...","size":0,"parentReference":{"driveType":"personal","driveId":"...","id":"...!sc4ea15..."}}   ← 非根文件夹 A
{"id":"...!sc8816884...","size":0,"parentReference":{...,"id":"...!se6cfd1..."}}                                     ← 非根文件夹 B，父=A
walk: 2 added/modified delta item(s) could not be parsed — invalidating deltaLink; next sync will do a full re-enumeration.
```

## 根因

上一轮 id-fallback（`9338c99`→`b64f720`）只覆盖**修改场景**——条目**自己的 `id`** 在 prev `idToKeyMap` 命中则复用 `keyRaw`。告警两条是**非根**文件夹（`name !== remoteBaseDir`，`isApprootRootDriveItem` 不接）、自己 `id` 不在 prev map（新增项）、互为父子链。三层 fallback 全穿透 → throw → skip → 清空 deltaLink → 自愈。**反复发作**说明全量重枚举也没把它们带 `path` 舔回（spec 当时把"全量带 path"当侥幸经验），于是它们永驻"新增无 path"状态，每轮增量重现。

这正是上一轮 spec §7 明确**延期**的 case：
> New path-missing items (no prev id): self-heal only. **Future: walk `parentReference.id` chains or cache approot anchor id to resolve direct-children.**

## 修复设计（契约正确：track by id）

`path` 缺且 own-id 未命中时，沿 `parentReference.id` 向上回溯重建 vault-relative key（`docs/notes/microsoft-graph-delta-api.md:56-73` 已记契约 + 微软 `vscode-onedrive-browser` 参考）：

1. **基线**：`parentReference.id === approotRootId` → `name(+"/")`（直属根的子项）
2. **链式**：父在 `lookupMap`（prev ∪ root anchor ∪ 本批已解析）→ `parentKey+name(+"/")`（`parentKey=="/"` 退化不产生 `//`）
3. **不可达** → throw `ONEDRIVE_PATH_MISSING` → skip + 自愈（契约上无法定位，罕见）

关键设计点：
- **根 id 捕获**：`FakeFsOnedrive._init()` 行 518 已 `_getJson("/drive/special/approot/children")` 并 filter `x.name === remoteBaseDir`——天然捕获位置，加 `this.approotRootId = x.id`，无需额外请求。每 session 首次 sync 的 `_init()` 即填；首次 sync 是全量（prev null）不依赖根 id，无时序冲突。
- **批内父子链（B 的父是同批 A）**：`classifyDeltaItems` 两趟回扫——第一趟顺序解析，失败项入 `pending`；回扫趟重试直到无进展（不依赖 delta 返回顺序，契约安全）。每解析一项把 `id→keyRaw` 加入共享 `lookupMap`。
- **纯函数边界**：`deriveKeyFromParentChain` / `fromDriveItemToEntityWithChainFallback` 经参数注入 map+rootId，无 I/O。`classifyDeltaItems` in-place mutate 的是调用方传入的 `new Map(idToKeyMap)` 副本，不泄漏到 `prevRemoteEntities`。
- **行为保持**：path 在→主路径不变；modify 的 own-id 命中→chain 变体第 1 步等价 `fromDriveItemToEntityWithIdFallback`；throw 顺序钉死（approot根→remoteItem/package→path-missing→mtime）。

## 验证

- TDD：27 新测试（含告警数据精确形态 fixture：ROOT_ID/folderA/folderB + 逆序 + 3 层最坏顺序 + 不可达退化）RED→GREEN。
- `npm run typecheck` exit 0；`npm test` **534 passing**（507 旧 + 27 新，无回归）；`npm run build` exit 0。
- @oracle 复审 **APPROVE-WITH-NITS**，无 must-fix。nits：`fromDriveItemToEntityWithIdFallback` 现零生产调用方（plan 授权保留）、`deriveKeyFromParentChain` 的 `remoteBaseDir` 未用、第 4 参名 `idToKeyMap` 略误导、双重 root-anchor seed 冗余但幂等——纯风格，非阻塞。

## 工作流经验

对 PolyForm 同步代码的高风险改动，**spec→plan→@fixer(TDD)→@oracle 复审→orchestrator 验证**的流程比逐 task SDD 轻、比无结构直改稳。本次 plan 195 行钉死设计（含行为保持论证 + 防范 checklist 自检），fixer 机械执行一次跑完，oracle 把关契约/纯函数/行为保持，orchestrator 核读关键 diff + 跑三道验证门。关键前提：plan 要把设计钉到"fixer 无需做架构决策"的程度（根 id 捕获位置、闭包绑定模式、throw 顺序、不改 `$select`/全量路径 都明确）。

## 旁支：部署/重载诊断（非本次修复范围）

修完代码后 build 自动重载失败（"obsidian CLI did not confirm reload"）。诊断链：
- `where obsidian` → `D:\Obsidian\Obsidian.com` + `.exe`（Obsidian 自带 CLI，PATHEXT 解析 `.com` 优先）。
- `obsidian version` → `1.13.7`（CLI 连上了某个 Obsidian 实例）。
- `obsidian plugin:reload id=onedrive-sync` → `Error: Plugin "..." is not enabled.`（spawnSync shell:false / shell:true / 显式 .com 三种方式都同此结果）。
- 真因：部署目标 vault（`VAULT_PATH=...\Obsidian\Lab`）的 `community-plugins.json` 只有 `["lazy-plugins"]`——**Lab vault 没启用本插件**。Obsidian 插件启用是 per-vault 的；用户启用的是另一个 vault。
- **工具链坑**：`esbuild.config.mjs` 的 `reloadPlugin`（行 57-83）失败时只打通用 warn（"did not confirm reload"），**吞了 CLI 的真实 stdout**（`Error: ... is not enabled`），逼得手动 spawnSync 才看到真相。改进点（未做）：失败时透传 CLI 真实 stdout/stderr，让这类原因立即可见。

## commit hash 重写异常（再印证）

`docs/lessons/onedrive-delta-parentreference-path.md` §后续已记"本环境每次 commit 后 hash 被外部重写（内容逐字一致）"。本次再印证：`git commit` 打印 `46ba429`/`28a4591`，`git log` 显示 `2f9d8d3`/`a035b1a`。**信任 HEAD，不信打印的 hash；review 范围用 `base..HEAD`。**

## commits

- `feat(onedrive): parent-id-chain fallback for new path-missing delta items`（5 src/tests）
- `docs(onedrive): parent-id-chain fallback design + plan`（plan doc）

上一轮遗留未提交文档（lesson 2026-09-21 后续章节 / `docs/CONVENTIONS.md` / `docs/notes/`）本次未纳入 commit，待单独处理。
