# OneDrive Delta `parentReference.id`-Chain Fallback for New Path-Missing Items

**Date:** 2026-09-22
**Status:** Plan (ready for implementation)
**Predecessor:** `docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md` §7 (deferred) + `docs/lessons/onedrive-delta-parentreference-path.md` 后续 §

## 1. 背景 / 根因

上一轮（`9338c99`→`b64f720`）给增量 delta 加了 **own-id fallback**：`parentReference.path` 缺失时，拿条目**自己的 `id`** 去上一轮 `idToKeyMap` 查，命中则复用 `keyRaw`。这只覆盖**修改场景**（条目已存在于 prev）。

spec §7 当时明确**延期**了两件事：
> - New path-missing items (no prev id): self-heal only. **Future: walk `parentReference.id` chains or cache approot anchor id to resolve direct-children.**
> - Walking `parentReference.id` chains to reconstruct paths for new direct-children of approot (the full Microsoft approach). Future enhancement; not needed for the modify-case coverage.

现在这个延期 case 在咬人。告警：
```
classifyDeltaItems: skipping added/modified item (parse failed)
x.parentReference.path is undefinded or null
{"id":"<folderId1>","size":0,"parentReference":{"driveType":"personal","driveId":"...","id":"<rootItemId>"}}  ← 非根文件夹A
{"id":"<folderId2>","size":0,"parentReference":{...,"id":"<folderId1>"}}  ← 非根文件夹B，父=A
walk: 2 added/modified delta item(s) could not be parsed — invalidating deltaLink; next sync will do a full re-enumeration.
```

两条都是**非根**文件夹（`name !== remoteBaseDir`，`isApprootRootDriveItem` 不接）、自己的 `id` 不在 `idToKeyMap`（新增/prev 无），且互为父子链（B 的 `parentReference.id` == A 的 `id`）。三层 fallback 全穿透 → throw → skip → 清空 deltaLink → 自愈。**反复发作**（"又有告警"）说明全量重枚举也没把这两条带 path 舔回（spec 当时把"全量带 path"当侥幸经验），于是它们永驻"新增无 path"状态，每轮增量都重现。

## 2. 契约依据（已存于本仓 docs）

`docs/notes/microsoft-graph-delta-api.md:56-69`（引用微软自家 `vscode-onedrive-browser`）：
> `path` 缺失时，沿 `parentReference.id` 向上回溯重建路径。
> ```ts
> if (item.parentReference.path) { return item.parentReference.path.slice(prefix) + '/' + item.name; }
> const parent = this.results.get(item.parentReference.id);
> return parent ? this.getPathForItem(parent) + '/' + item.name : item.name;
> ```

告警数据证实 `parentReference.id` 稳定存在 —— 这是文档要求"track items by id"的字段。

## 3. 目标 / 非目标

**目标：** `path` 缺失且 own-id 未命中时，**沿 `parentReference.id` 链重建 vault-relative key**，而非 throw→skip。覆盖：
- 直属根的子项（父 id == approot root id）→ `key = name (+ "/")`
- 父在 prev `idToKeyMap` → `key = parentKey + name (+ "/")`（parentKey=="/" 时退化为上条）
- 父在本 delta 批内已解析（批内父子链，如 B→A）→ 同上

**非目标（仍自愈）：**
- 父链不可达（父既不在 prev、不在批内、也不是根）→ throw→skip→自愈。契约上确实无法定位，罕见。
- 全量/walkPartial 路径不改（empirically 带 path，且无 prev 可建 map）。
- 不替换 path 派生（path 在时主路径不变）。

## 4. 设计

### 4.1 三层 fallback（新增第 3 层）
```
path 缺失
 ├─ own id 在 idToKeyMap? → 复用 keyRaw (modify, 已有, 不动)
 ├─ parentReference.id == approotRootId? → key = name (+ "/" if folder)        ← 新增基线
 ├─ parentReference.id 在 lookupMap? → key = parentKey + name (+ "/" if folder)  ← 新增链式
 │   (parentKey=="/" 时 key = name (+ "/"))
 └─ 否 → throw ONEDRIVE_PATH_MISSING → skip + self-heal (契约上不可解析)
```
`lookupMap` = `idToKeyMap`（prev）∪ `{approotRootId → "/"}` ∪ 本批已解析项的 `id → keyRaw`（拓扑多趟维护）。

### 4.2 根 id 捕获（`FakeFsOnedrive._init`）
`_init()` 行 518 已 `_getJson("/drive/special/approot/children")` 并 `filter(x => x.name === remoteBaseDir)`。在此 filter 命中时记 `this.approotRootId = x.id`。
- 根 id 稳定；每 session 首次 sync 的 `_init()` 即填充。
- `vaultFolderExists=true` 时 `_init` 跳过 children 查询，但字段已在前次 `_init` 填好（同一实例生命周期）。
- 文件夹不存在时 `_init` POST 创建（行 525），该 sync 是全量（prev null）不依赖根 id；下个 sync `_init` 走 filter 捕获。无时序冲突。

### 4.3 纯函数（`driveItemConvert.ts`，Apache，保持 PURE）
新增导出：
- `deriveKeyFromParentChain(x, lookupMap, approotRootId, remoteBaseDir): string`
  - 读 `x.parentReference?.id`；基线/链式按 4.1；父不在 map → throw `pathMissingError()`（`.code=ONEDRIVE_PATH_MISSING`，复用现有，保证 catch 匹配）。
  - 文件夹加尾 `/`。
- `fromDriveItemToEntityWithChainFallback(x, remoteBaseDir, lookupMap, approotRootId, requireMtime=true): Entity`
  - approot 根 → `key "/"`（复用 `isApprootRootDriveItem`，先于一切）。
  - `remoteItem`/`package`/`bundle` 守卫（同序）。
  - 先 `deriveKeyFromPath`（path 在→主路径，不变）；catch `ONEDRIVE_PATH_MISSING`：
    1. own-id 命中 `lookupMap` → 复用 keyRaw（等价现有 `fromDriveItemToEntityWithIdFallback` 行为，保持 modify 覆盖）
    2. 否则 `deriveKeyFromParentChain` → 命中则用
    3. 否则 re-throw → 自愈
  - 再 `extractDriveItemMetadata`（mtime throw 顺序在 path 之后，不变）。
  - **`fromDriveItemToEntityWithIdFallback` 保留不删**（其它调用点/测试依赖；新接线用 chain 变体）。

**纯函数边界**（CONVENTIONS.md 行 7）：`lookupMap` 与 `approotRootId` 经参数注入，无 I/O、无 `obsidian`/`msal` 导入。

### 4.4 `classifyDeltaItems` 拓扑多趟（`deltaMerge.ts`，Apache）
问题：批内父子链（B 的父 A 也在本批、A 也无 path）。单趟顺序处理时，若 A 排在 B 之后，B 解析时 A 尚未入 map。

方案：**两趟回扫**（不依赖 delta 返回顺序，契约安全）：
1. **第一趟**：顺序遍历。每项用闭包绑定的 `lookupMap`（初值 = prev `idToKeyMap` ∪ `{approotRootId→"/"}`）走 converter。
   - 解析成功 → `deltaEntities`/`deletedKeys` + 把 `item.id → keyRaw` 加入 `lookupMap`（mutate 闭包内的 map）。
   - 解析失败（throw）→ 暂存进 `pending`（带 `isDeleted` 标记）。
2. **回扫趟**（重复直到本轮无进展）：遍历 `pending`，重试 converter。成功 → 出队入结果 + 加 map；失败 → 留。
3. **终止**：`pending` 非空且无进展 → 剩余计入 `skippedAddedOrModified`（新增分支）或 warn-skip（删除分支，走 404 自愈，不计 skippedAddedOrModified——与现有行为一致）。

闭包绑定（与上轮 `bindMap` 同模式，类型安全）：
```ts
const lookupMap = new Map(idToKeyMap);
if (approotRootId) lookupMap.set(approotRootId, "/");
const converter = (item, dir, req) =>
  fromDriveItemToEntityWithChainFallback(item, dir, lookupMap, approotRootId, req);
```
`classifyDeltaItems` 签名加可选 `approotRootId?: string`（第 5 参，文档化调用方意图，实际由闭包 converter 消费，与第 4 参 `idToKeyMap` 同模式）。

### 4.5 接线（`fsOnedrive.ts`，PolyForm）
`walk()` 增量分支（行 916-937）：
- 保留 `buildIdToKeyMap(this.prevRemoteEntities)`。
- 新增：传 `this.approotRootId` 给 `classifyDeltaItems` 第 5 参 + 闭包绑定 chain 变体 converter。
- `skippedAddedOrModified>0` 的自愈逻辑不变（现在只会因"父链真不可达"触发，更罕见）。
- 全量分支（行 964-991）与 `walkPartial` 不变。

### 4.6 数据流
1. session 首次 sync（prev null）→ 全量 → `_init` 捕获 `approotRootId`；converter 填 `remoteId`；存 prev + deltaLink。
2. 后续 sync（prev 有，deltaLink 有）→ 增量：
   - 修改项无 path → own-id 命中 → 复用 keyRaw（上轮覆盖，不变）。
   - 新增项无 path、父是根 → 链式基线 → `key = name (+ "/")`。**（告警 case 1：文件夹 A）**
   - 新增项无 path、父在本批已解析（A）→ 链式 → `key = A.key + name (+ "/")`。**（告警 case 2：文件夹 B）**
   - 父链不可达 → throw → skip → 自愈（罕见）。

## 5. 文件级改动清单

| 文件 | License | 改动 |
|---|---|---|
| `src/fsOnedrive.ts` | PolyForm | `FakeFsOnedrive` 加 `approotRootId?: string`；`_init` 行 518-522 filter 命中时记 id；`walk()` 增量分支传 `approotRootId` + 闭包 chain converter |
| `src/driveItemConvert.ts` | Apache | 新增导出 `deriveKeyFromParentChain` + `fromDriveItemToEntityWithChainFallback`（均 PURE） |
| `src/deltaMerge.ts` | Apache | `classifyDeltaItems` 加 `approotRootId?` 第 5 参；两趟回扫；闭包绑定 chain converter |
| `tests/deltaMerge.test.ts` | — | 新增 spec-driven fixture（告警数据精确形态）+ 批内父子链 + 基线 + 不可达自愈 |
| `tests/driveItemConvert.test.ts` | — | `deriveKeyFromParentChain` 单元：基线/链式/parentKey=="/"/父不在 map throw |

**不改**：`syncOptimize.ts`（`DELTA_SELECT` 已含所需字段）、`baseTypes.ts`（`remoteId` 已存在）、全量/walkPartial 路径。

## 6. TDD（RED → GREEN）

### 6.1 `tests/driveItemConvert.test.ts`（新增 describe）
- `deriveKeyFromParentChain`：
  - 父 id == approotRootId + folder → `name + "/"`。
  - 父 id == approotRootId + file → `name`。
  - 父在 map（keyRaw `sub/`）+ file → `sub/name`。
  - 父在 map（keyRaw `sub/`）+ folder → `sub/name/`。
  - 父 keyRaw == "/"（根直接子项经 map）+ file → `name`（不产生 `//`）。
  - 父不在 map、非 rootId → throw `.code === "ONEDRIVE_PATH_MISSING"`。
- `fromDriveItemToEntityWithChainFallback`：
  - path 在 → 主路径（行为同 `fromDriveItemToEntity`）。
  - path 缺 + own-id 命中 → 复用 keyRaw（等价现 fallback）。
  - path 缺 + own-id miss + 父是 root → `name (+ "/")`。
  - path 缺 + own-id miss + 父在 map → 链式。
  - path 缺 + 全 miss → throw `.code==="ONEDRIVE_PATH_MISSING"`。
  - throw 顺序：approot根 → remoteItem/package → path-missing → mtime（钉死，与现有 `assert.throws` 一致）。

### 6.2 `tests/deltaMerge.test.ts`（新增 describe「parent-id-chain fallback」）
fixture（**告警数据的精确形态**）：
```ts
const ROOT_ID = "<rootItemId>";
const folderA = { id:"<folderId1>", name:"A", size:0, folder:{},
  parentReference:{ driveType:"personal", driveId:"...", id: ROOT_ID } }; // 无 path
const folderB = { id:"<folderId2>", name:"B", size:0, folder:{},
  parentReference:{ driveType:"personal", driveId:"...", id: folderA.id } }; // 无 path, 父=A
```
- `[folderA, folderB]` + `approotRootId=ROOT_ID` + 空 prev map → 两条全解析，`keyRaw` 为 `A/` 与 `A/B/`，`skippedAddedOrModified===0`，无 warn。
- `[folderB, folderA]`（**逆序**，B 在前）→ 两趟回扫后仍全解析（证明不依赖顺序）。
- 父链不可达（folderA 的 parentReference.id 改成既非 rootId、不在 map 的值）→ folderA skip+self-heal（`skippedAddedOrModified===1`）；folderB 因父 A 未入 map 也 skip（`===1`，共 2）。**注意**：folderB 的父 A 在本批但 A 解析失败 → B 也失败，两条都计入（契约上 A 不可解析则 B 也不可解析，正确退化）。
- 删除项无 path + 父是 root → `deletedKeys` 含 `name + "/"`，不进 phantom。
- 行为保持：path 在的项仍走主路径（回归现有用例）。

## 7. 行为保持论证

- **path 在**：`deriveKeyFromPath` 主路径，不动。所有现有 path-bearing fixture 不变。
- **path 缺 + own-id 命中**（modify）：新 chain converter 的第 1 步等价 `fromDriveItemToEntityWithIdFallback`，命中 keyRaw 一致。现有 modify fixture 不变。
- **path 缺 + own-id miss**（原 self-heal case）：原 throw→skip→自愈；现优先尝试链式。**行为变化只在"原 skip 现解析成功"** —— 这是修复目标，非回归。链式仍 miss 的项保持原 throw→skip→自愈。
- **throw 顺序**：approot根→remoteItem/package→path-missing→mtime 钉死（现有 `assert.throws` 测试守护）。
- **纯函数**：新函数参数注入 map+rootId，无 I/O；`classifyDeltaItems` 内 mutate 的是自己构造的 `lookupMap` 副本，不泄漏到 prev。
- **全量/walkPartial**：不改，仍 warn-and-skip。

## 8. 验证

```powershell
npm run typecheck        # tsc -noEmit -skipLibCheck
npm test                 # mocha + tsx over tests/**/*.ts（含新 fixture）
npm run build            # typecheck + esbuild → main.js
```
- 新 fixture 在实现前应 RED（当前代码对 folderA/folderB 会 warn+skip）。
- 实现后 GREEN：两条解析、`skippedAddedOrModified===0`、无 warn。
- 全量现有套件（492+）不回归。

## 9. 防范 checklist 自检（call-mode 契约）
- **未改调用方式**：delta 端点、`$select`、token 复用方式全不动。仅改客户端对响应字段的**消费方式**（path 缺时改用 parentReference.id）。
- **字段依赖核对**：`parentReference.id` —— 文档"track items by id"明示；无 always-present 保证但有 fallback（不在 map→throw）。`approotRootId` 来自 `_init` 的 `/approot/children` 实测，稳定。
- **契约 delta**：无（未改调用模式）。
- **spec-driven fixture**：告警数据精确形态入测，切换当天即红。

## 10. 引用
- spec：`docs/superpowers/specs/2026-09-21-onedrive-delta-id-fallback-design.md` §7（deferred）
- 契约笔记：`docs/notes/microsoft-graph-delta-api.md:56-69`
- 复盘：`docs/lessons/onedrive-delta-parentreference-path.md`
- 微软 id-walk：https://github.com/microsoft/vscode-onedrive-browser
