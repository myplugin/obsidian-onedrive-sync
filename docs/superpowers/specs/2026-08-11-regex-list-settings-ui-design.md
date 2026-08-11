# 正则列表设置 UI 重设计

- **日期**: 2026-08-11
- **状态**: 已与用户确认设计，待编写实现计划
- **范围**: `src/settings.ts`、`src/misc.ts`、`styles.css`、`tests/misc.test.ts`，新增 `src/regexListSetting.ts`

## 1. 背景与动机

Obsidian 插件 `remotely-save` 设置页中，"忽略路径 (ignorePaths)" 与 "仅允许路径 (onlyAllowPaths)" 两个配置项当前用 `Setting.addTextArea` 渲染：一个原始多行文本框，按 `\n` 拆分存储为 `string[]`。存在三个问题：

1. **布局简陋**：原始多行文本框，多条正则挤在一起，易被误改，无法逐条管理。
2. **无正则合法性校验**：用户输入非法正则无任何反馈，错误要等到同步运行时才暴露。
3. **无路径测试手段**：用户无法验证某条路径是否会被当前配置命中。

## 2. 目标

- 将两个列表改为"逐条添加 + 展示"的 chip 列表形式，清晰易读、防误改。
- 添加时校验正则合法性；非法正则允许加入但标红 + ⚠ 警告 + tooltip 显示错误。
- 每个列表下方提供路径测试器，输入路径后显示最终结论（命中/未命中）+ 命中的具体正则。
- 测试结果必须与 `pro/src/sync.ts` 实际同步判定行为一致。

## 3. 非目标

- 不改动 `pro/src/sync.ts` 的匹配逻辑。
- 不改动数据模型（`ignorePaths?: string[]` / `onlyAllowPaths?: string[]` 保持不变）。
- 不实现"综合两个列表的最终同步结论"测试器（方案 B，留待后续）。
- 不为 UI 层写单元测试（Obsidian DOM 依赖重，纯逻辑已覆盖）。

## 4. 架构与代码组织

### 4.1 纯逻辑层 — `src/misc.ts`

`misc.ts` 已 import `XRegExp` 且不依赖内部模块，符合约定。新增两个纯函数：

```ts
/**
 * 校验单条正则是否合法。
 * 使用与 sync.ts 一致的 XRegExp(r, "A") 锚定模式编译。
 * @returns 合法返回 {ok: true}；非法返回 {ok: false, error: 报错信息}
 */
export function validateRegex(r: string): { ok: true } | { ok: false; error: string };

/**
 * 测试路径是否命中正则列表。
 * 逐条用 XRegExp(r, "A").test(path) 判定（与 pro/src/sync.ts:180 完全一致）。
 * 跳过空字符串条目；非法正则条目跳过且不影响其他合法条目判定。
 * @returns { matched: 是否至少一条命中, matchedRegexes: 命中的正则原文列表 }
 */
export function testPathAgainstRegexList(
  regexes: string[],
  path: string,
): { matched: boolean; matchedRegexes: string[] };
```

### 4.2 UI 渲染层 — 新文件 `src/regexListSetting.ts`

从 `settings.ts` 拆出，避免本就 1693 行的 `settings.ts` 继续膨胀。导出一个渲染函数：

```ts
export interface RegexListSettingOptions {
  containerEl: HTMLElement;
  getValues: () => string[];
  setValues: (next: string[]) => Promise<void>; // 调用方内部执行 plugin.saveSettings()
  t: (k: TransItemType, vars?: any) => string;
  placeholder?: string; // 输入框 placeholder
}

export function renderRegexListSetting(opts: RegexListSettingOptions): void;
```

### 4.3 接入点 — `src/settings.ts`

替换 968-986 行（ignorePaths）和 989-1007 行（onlyAllowPaths）的 `addTextArea` 块，各改为一次 `renderRegexListSetting({...})` 调用，`getValues/setValues` 闭包绑定到 `plugin.settings.ignorePaths` / `plugin.settings.onlyAllowPaths`。

## 5. UI / UX 布局

每个列表渲染为一块自包含卡片（替代原 `addTextArea`）：

```
┌─ 忽略的文件或文件夹的正则表达式 ─────────────────────────┐
│ Regex of paths of folders or files to ignore. One regex │
│ per line. The path is relative to the vault root ...    │
│                                                          │
│  [^test$        ×]  [\.png$       ×]  [tmp/.*      × ⚠]  │  ← chip 行（横向换行）
│                                                          │
│  [输入新正则…                               ] [添加]     │  ← 输入框 + 添加按钮
│                                                          │
│  ── 路径测试 ──                                          │
│  [输入相对库根的路径（无前导 /）…         ] [测试]       │
│  ✓ 命中：tmp/.*   ← 绿色，命中时列出具体正则               │
└──────────────────────────────────────────────────────────┘
```

### 5.1 Chip 行为

- 每条正则一个胶囊，等宽字体显示原文，右侧 `×` 删除按钮。
- 非法正则 chip：红色边框 + ⚠ 图标，hover 显示 tooltip（原始编译错误信息）。
- 点 `×` 删除该条 → 立即 `setValues` 持久化。

### 5.2 添加行为

- 输入框回车或点"添加"按钮触发。
- **多行粘贴支持**：若输入值含 `\n`，按 `\n` 拆分为多条，逐条走以下流程（支持一次性粘贴多行正则，平滑迁移自原 textarea 体验）。
- 单条流程：`trim` → 空值忽略 → 已存在则跳过并弹 `Notice`（文案 `settings_regex_already_exists`）→ 非法也加入但立即标红 ⚠（符合"允许添加但标红警告"）→ 添加后清空输入框。
- 非法正则加入后仍持久化到 `string[]`（不丢数据），用户可后续修正或删除。

### 5.3 路径测试器

- 贴在该列表下方，只针对该列表判定（不跨列表）。
- 回车或点"测试"按钮触发。
- 调 `testPathAgainstRegexList(getValues(), path)` → 渲染结果：
  - 命中：绿色"✓ 命中：" + 列出命中的正则（等宽字体）。
  - 未命中：灰色"✗ 未命中任何正则"。
- 空列表：显示"列表为空，无正则可匹配"。
- 空路径：显示"请输入路径"。

## 6. 数据流与状态

- 数据模型不变：`ignorePaths?: string[]`、`onlyAllowPaths?: string[]` 仍存原始字符串数组（含可能的非法正则）。
- 每次增/删即调用 `setValues` → `plugin.saveSettings()`，保持 Obsidian "即改即存"语义（与原 `onChange` 一致）。
- 校验态不持久化：每次渲染从字符串重新推导（`validateRegex`），避免存储与显示脱节。

## 7. 错误处理与边界

- 非法正则：`XRegExp(r, "A")` 抛错 → chip 标红 + ⚠ + tooltip 显示原始报错（如 "Invalid regular expression: /(/: Unterminated group"）。
- 空字符串 chip：添加时 trim，空值不加入。
- 重复正则：添加时若已存在则跳过。
- 测试器空列表 / 空路径：对应友好提示（见 5.3）。
- **关键正确性**：测试器使用与 `pro/src/sync.ts:180` 完全相同的 `XRegExp(r, "A").test(key)`，保证"测试结果 == 实际同步行为"。

## 8. 样式 — `styles.css`

追加新样式，复用 Obsidian CSS 变量自动适配明暗主题：

- `.rs-regex-chip` — chip 胶囊基础样式（圆角、内边距、等宽字体、背景 `--background-modifier-hover`）。
- `.rs-regex-chip-invalid` — 非法态：边框 `--text-error`、⚠ 图标着 `--text-warning`（或 `--text-error`）。
- `.rs-regex-chip-delete` — `×` 按钮样式与 hover。
- `.rs-regex-add-row` — 输入框 + 添加按钮行布局。
- `.rs-regex-tester` — 测试器区块样式。
- `.rs-regex-test-result-match` / `-nomatch` — 绿/灰结果文本色（`--text-success` / `--text-muted`）。

移除原有 `.ignorepaths-textarea` / `.onlyallowpaths-textarea`（不再使用 textarea）。

## 9. 测试 — `tests/misc.test.ts`

`tests/misc.test.ts` 已有 misc 单测，追加：

### `validateRegex`

- 合法正则（`test`、`^test$`、`\.png$`、`tmp/.*`）→ `{ ok: true }`。
- 非法正则（`(`、`[unclosed`、`*leading`）→ `{ ok: false, error: <非空字符串> }`。

### `testPathAgainstRegexList`

- 空列表 → `{ matched: false, matchedRegexes: [] }`。
- `["test$"]` + path `"test"` → 命中，`matchedRegexes: ["test$"]`。
- `["\.png$"]` + path `"a.png"` → 命中；path `"a.txt"` → 不命中。
- 多条正则、多条命中 → 返回所有命中项，顺序与列表一致。
- 列表含非法正则（`["(", "test$"]`）+ path `"test"` → 只对合法条目判定，命中 `["test$"]`，非法条目被跳过且不抛错。

## 10. i18n

新增的 UI 文案需在 `src/langs/en.json`、`zh_cn.json`、`zh_tw.json` 同步添加 key（参照现有 `settings_ignorepaths` 命名前缀）：

- `settings_regex_add_placeholder` — 添加输入框 placeholder。
- `settings_regex_add_button` — "添加" / "Add"。
- `settings_regex_test_path_placeholder` — 测试输入框 placeholder。
- `settings_regex_test_button` — "测试" / "Test"。
- `settings_regex_test_match` — "命中：{{regexes}}"。
- `settings_regex_test_nomatch` — "未命中任何正则"。
- `settings_regex_test_empty_list` — "列表为空，无正则可匹配"。
- `settings_regex_test_empty_path` — "请输入路径"。
- `settings_regex_already_exists` — "该正则已存在"。
- `settings_regex_invalid_warning` — ⚠ tooltip 文案模板（含原始错误）。

## 11. 风险与回退

- **风险**：chip 列表 DOM 比 textarea 重，但条目数量典型场景 < 20，性能无虞。
- **风险**：移除 textarea 后，用户依赖的整段粘贴体验受影响。缓解：添加输入框支持单条粘贴（trim 后作为一条），批量粘贴多条（含 `\n`）时拆分为多个 chip。
- **回退**：数据模型未变，回滚只需还原 `settings.ts` 接入点和删除新文件即可，存量设置数据不受影响。

## 12. 验收清单

- [ ] `ignorePaths` 列表以 chip 形式展示，可逐条添加/删除。
- [ ] `onlyAllowPaths` 列表同上。
- [ ] 非法正则 chip 标红 + ⚠ + tooltip 显示错误，但仍持久化。
- [ ] 列表下方路径测试器输入路径后显示命中/未命中 + 命中的正则。
- [ ] 测试器对空列表、空路径给友好提示。
- [ ] 测试器结果与 `sync.ts` 实际判定一致（用 `XRegExp(r, "A")`）。
- [ ] `npm run build2` 通过（含 `tsc -noEmit`）。
- [ ] `npm test` 通过（含新增 misc 单测）。
- [ ] 明暗主题下样式均正常。
