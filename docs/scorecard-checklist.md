# OneDrive Vault Sync — 社区 Scorecard Review 检查清单

> 来源：<https://community.obsidian.md/plugins/onedrive-vault-sync> → Scorecard → Review
> 扫描对象：最新发布版本（v0.6.9）的 `main.js` 源码自动审计
> 总览：**Risks — 757 issues**（= Warnings 701 + Other 56；Passed / Disclosures 不计入 issues）
> 更新日期：2026-10-13

## 使用说明

- `[ ]` 未处理 / `[x]` 已处理
- 状态标签含义：
  - **`[CONVENTION]`** 项目约定明确接受，**禁止盲目“修复”**（见 `AGENTS.md`：`noExplicitAny` / `noNonNullAssertion` 已关闭，`any` 与非空断言是被接受的）
  - **`[ACTIONABLE]`** 可动手修复的真实问题
  - **`[INTENTIONAL]`** 有意为之的迁移垫片 / 兼容代码，保留即可（必要时补注释）
  - **`[INHERENT]`** 同步插件固有能力，无法消除，仅需在文档中说明
  - **`[INFO]`** 纯信息披露，无源码动作

---

## 汇总

| 分类 | 去重规则数 | 出现次数 | 性质 |
|------|----------:|--------:|------|
| ✅ Passed | 5 | 5 | 全部通过，无需动作 |
| ℹ️ Disclosures | 6 | 6 | 信息披露，部分扫描不可用 |
| ⚠️ Warnings | 34 | 701 | 含大量按约定接受的 `any` 类项 |
| 📋 Other | 34 | 56 | 含废弃垫片 + 未用变量 + 能力披露 |
| **Issues 合计 (Warnings+Other)** | **68** | **757** | |

---

## ✅ Passed（5 项 · 全部通过）

- [x] `main.js` 发布资产有经过验证的 GitHub artifact attestation
- [x] `styles.css` 发布资产有经过验证的 GitHub artifact attestation
- [x] Vault Read：通过 Obsidian API 读取单个 vault 文件（`vault.read` / `vault.cachedRead`）
- [x] Vault Write：通过 Obsidian API 创建或修改 vault 文件（`vault.modify` / `vault.create` 等）
- [x] 构建可逐字节复现发布版 `main.js`

---

## ℹ️ Disclosures（6 项 · 信息披露）

- [ ] `[INFO]` 网络请求调用次数披露
- [ ] `[INFO]` 代码使用了运行时 base64 编码/解码
- [ ] `[INFO]` Malware scan not available（平台侧未提供，无源码动作）
- [ ] `[INFO]` Vulnerable dependencies scan not available
- [ ] `[INFO]` Obfuscation scan not available
- [ ] `[INFO]` Network requests scan not available

---

## ⚠️ Warnings（701 次 · 34 条规则）

### A. `[CONVENTION]` 按项目约定接受 — 禁止盲目修复

> `AGENTS.md` 明确：Biome 中 `noExplicitAny`、`noNonNullAssertion` 等默认 **关闭**，`any` 与非空断言在本仓库是被接受的。下列各项**不要**作为 bug 逐条改，否则会违背既有设计意图。

- [x] `[CONVENTION]` Unexpected `any`. Specify a different type. — **193**
- [x] `[CONVENTION]` Unsafe member access on an error or `any` typed value — **139**
- [x] `[CONVENTION]` Unsafe assignment of an error or `any` typed value — **97**
- [x] `[CONVENTION]` Passes unsafe values into typed parameters — **42**
- [x] `[CONVENTION]` Unsafe call of an error or `any` typed value — **21**
- [x] `[CONVENTION]` Returns unsafe values from typed code — **12**
- [x] `[CONVENTION]` This assertion is unnecessary since it does not change the type of the expression.（非空断言） — **29**
- [x] `[CONVENTION]` This assertion is unnecessary since the receiver accepts the original type of the expression. — **11**
- [x] `[CONVENTION]` Optional chain expressions can return undefined by design — using a non-null assertion is unsafe and wrong. — **2**

> 小计：9 条规则 / 636 次（占 Warnings 的 91%）。集中分布：`src/fsOnedrive.ts`、`src/driveItemConvert.ts`、`src/main.ts`。

### B. `[ACTIONABLE]` 可修复项

#### B1. 日志 / API 用法

- [ ] `[ACTIONABLE]` Avoid unnecessary logging to console — **31**（改用统一 logger，避免 `console.*`）
- [ ] `[ACTIONABLE]` Unexpected use of `fetch`. Use the built-in `requestUrl` instead of `fetch` for network requests in Obsidian. — **7**
- [ ] `[ACTIONABLE]` Uses `document.createElement` instead of Obsidian's `createEl` helpers — **25**

#### B2. Promise / 异步正确性

- [ ] `[ACTIONABLE]` Promises must be awaited, end with `.catch`, `.then`(rejection handler) or marked ignored with `void`. — **12**
- [ ] `[ACTIONABLE]` Expected the Promise rejection reason to be an `Error`. — **12**
- [ ] `[ACTIONABLE]` Promise returned in function argument where a `void` return was expected. — **5**
- [ ] `[ACTIONABLE]` Promise-returning method provided where a `void` return was expected by extended/implemented type `Plugin`. — **1**
- [ ] `[ACTIONABLE]` Unexpected aliasing of `this` to local variable. — **1**
- [ ] `[ACTIONABLE]` A method not declared with `this: void` may cause unintentional scoping of `this`（考虑箭头函数 / `.bind()`） — **2**

#### B3. 移动端兼容

- [ ] `[ACTIONABLE]` Do not import Node.js built-in module `path`. Node.js APIs are not available on mobile. Use dynamic `import()` / `require` guarded by `Platform.isDesktop`. — **1**
- [ ] `[ACTIONABLE]` Avoid using `global`. Use `window` or `activeWindow` for popout window compatibility. — **2**
- [ ] `[ACTIONABLE]` Use `window.setTimeout()` instead of `setTimeout()` for popout window compatibility. — **2**

#### B4. CSS / 样式

- [ ] `[ACTIONABLE]` Avoid `!important` — override styles by increasing selector specificity or using CSS variables. — **19**
- [ ] `[ACTIONABLE]` Unexpected duplicate "background-color" — **2**
- [ ] `[ACTIONABLE]` Unnecessary escape character: `\/`. — **9**
- [ ] `[ACTIONABLE]` Unnecessary escape character: `\"`. — **2**

#### B5. 依赖与杂项

- [ ] `[ACTIONABLE]` Dependency has a potential vulnerability advisory — **8**（查 `npm audit`，升级有漏洞的依赖）
- [ ] `[ACTIONABLE]` Do not access `Object.prototype` method `hasOwnProperty` from target object. — **6**（改用 `Object.prototype.hasOwnProperty.call(...)` 或 `Object.hasOwn(...)`）
- [ ] `[ACTIONABLE]` Unexpected constant condition. — **2**
- [ ] `[ACTIONABLE]` Expected an assignment or function call and instead saw an expression. — **1**
- [ ] `[ACTIONABLE]` `"dotenv"` should be replaced with an alternative package. — **1**
- [ ] `[ACTIONABLE]` `"emoji-regex"` should be replaced with an alternative package. — **1**
- [ ] `[ACTIONABLE]` `"lodash"` should be replaced with an alternative package. — **1**
- [ ] `[ACTIONABLE]` `"rimraf"` should be replaced with an alternative package. — **1**

#### B6. 设置搜索（声明式 API）

- [ ] `[ACTIONABLE]` This `PluginSettingTab` does not implement `getSettingDefinitions()`; settings won't appear in Obsidian's settings search for 1.13.0+. 考虑采用 declarative settings API。 — **1**

> B 区小计：25 条规则 / 65 次。

---

## 📋 Other（56 次 · 34 条规则）

### C. `[INTENTIONAL]` 有意保留的迁移垫片 — 勿删

> 这些是新旧数据迁移用的兼容标记，源码已注明 “we cannot remove it because we want to migrate the old data”。保留即可，必要时补一条注释说明计划。

- [x] `[INTENTIONAL]` `vaultRandomID` is deprecated. — **5**
- [x] `[INTENTIONAL]` `syncMappingTbl` is deprecated. But we cannot remove it…（迁移旧数据） — **4**
- [x] `[INTENTIONAL]` `SyncMetaMappingRecord` is deprecated. But we cannot remove it… — **2**
- [x] `[INTENTIONAL]` `fileHistoryTbl` is deprecated. But we cannot remove it… — **2**
- [x] `[INTENTIONAL]` `howToCleanEmptyFolder` is deprecated. — **2**
- [x] `[INTENTIONAL]` `getAllSyncMetaMappingByVault` is deprecated. But we cannot remove it… — **1**
- [x] `[INTENTIONAL]` `DEFAULT_TBL_FILE_HISTORY` is deprecated. — **1**
- [x] `[INTENTIONAL]` `DEFAULT_TBL_SYNC_MAPPING` is deprecated. — **1**
- [x] `[INTENTIONAL]` `logToDB` is deprecated. — **1**

> C 区小计：9 条规则 / 19 次。

### D. `[INHERENT]` 同步插件固有能力 — 仅需文档说明

- [x] `[INHERENT]` Vault Enumeration：枚举 vault 全部文件（`vault.getFiles` / `getMarkdownFiles` 等） — **1**（同步必需）
- [x] `[INHERENT]` Clipboard Access：读写系统剪贴板，可能暴露 Obsidian 外复制内容 — **1**（确认是否必需，如非必需可移除）
- [x] `[INHERENT]` Local Storage：使用 `localStorage` / `sessionStorage` 而非 Obsidian 插件数据 API — **1**（建议迁移至 `loadLocalStorage` / 插件 data API）

> D 区小计：3 条规则 / 3 次。

### E. `[ACTIONABLE]` 未使用变量 / 常量清理

> 多为解构后未用、或历史遗留导出。清理前先确认是否为对外公共 API 或被反射引用。

#### E1. 定义但未使用（`is defined but never used`）

- [ ] `[ACTIONABLE]` `'e'` — **8**
- [ ] `[ACTIONABLE]` `'error'` — **4**
- [ ] `[ACTIONABLE]` `'requireApiVersion'` — **2**
- [ ] `[ACTIONABLE]` `'API_VER_ENSURE_REQURL_OK'` — **2**
- [ ] `[ACTIONABLE]` `'diff3Merge'` — **1**
- [ ] `[ACTIONABLE]` `'diffComm'` — **1**
- [ ] `[ACTIONABLE]` `'diffPatch'` — **1**
- [ ] `[ACTIONABLE]` `'mergeDiff3'` — **1**
- [ ] `[ACTIONABLE]` `'patch'` — **1**
- [ ] `[ACTIONABLE]` `'SYNC_ON_SAVE_RATE_LIMIT_MS'` — **1**
- [ ] `[ACTIONABLE]` `'VALID_REQURL'` — **1**
- [ ] `[ACTIONABLE]` `'EmptyFolderCleanType'` — **1**
- [ ] `[ACTIONABLE]` `'checkValidName'` — **1**

#### E2. 赋值但未使用（`is assigned a value but never used`）

- [ ] `[ACTIONABLE]` `'leftEntity'` — **1**
- [ ] `[ACTIONABLE]` `'prefix'` — **1**
- [ ] `[ACTIONABLE]` `'unresolvedCount'` — **1**
- [ ] `[ACTIONABLE]` `'DB_VERSION_NUMBER_IN_HISTORY'` — **1**
- [ ] `[ACTIONABLE]` `'oldVersion'` — **1**
- [ ] `[ACTIONABLE]` `'i'` — **1**
- [ ] `[ACTIONABLE]` `'isBookmarksFile'` — **1**
- [ ] `[ACTIONABLE]` `'e1'` — **1**
- [ ] `[ACTIONABLE]` `'UPLOAD_DECISIONS'` — **1**

> E 区小计：22 条规则 / 34 次。

---

## 建议的处理优先级

1. **先处理 `[ACTIONABLE]` 中的依赖安全项**：B5 的 vulnerability advisory（8）+ 可替换包（dotenv/lodash/rimraf/emoji-regex，各 1）——风险最高、改动最小。
2. **再处理移动端兼容**（B3，共 5）：直接影响手机端能否运行，且数量少。
3. **Promise / 异步正确性**（B2，共 28）：潜在运行时 bug 来源，逐文件排查。
4. **API 用法**（B1，共 63）：`fetch`→`requestUrl`、`document.createElement`→`createEl`、`console`→logger，符合 Obsidian 规范。
5. **CSS 杂项**（B4，共 32）：低风险样式清理。
6. **未使用变量清理**（E，共 34）：纯卫生，不影响行为；注意别误删公共导出。
7. **`[CONVENTION]` / `[INTENTIONAL]` / `[INHERENT]`**：不做源码修改；仅在文档中说明接受理由（本文档已完成）。

## 复核与回归

- 每完成一组 `[ACTIONABLE]` 项后运行 `npm run build`（含 `tsc -noEmit` 类型检查）与 `npm test`。
- 重新发布后回到 Scorecard 页确认对应计数下降。
- 注意 **call-mode 变更契约**：若改动涉及外部 API 调用方式（如 `fetch`→`requestUrl` 的请求语义），须重读目标端点 Remarks 并确认依赖字段仍保证存在（见 `docs/lessons/onedrive-delta-parentreference-path.md`）。
