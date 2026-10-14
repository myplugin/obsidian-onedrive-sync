# esbuild define 词法替换失配复盘（0.6.10–0.6.13 鉴权空白弹窗）

## 一句话总结

一次引入 eslint 工具链的提交里，作者顺手把 `baseTypes.ts` 的 `global.DEFAULT_ONEDRIVE_CLIENT_ID` 改成了 `window.DEFAULT_ONEDRIVE_CLIENT_ID`，而 esbuild 的 `define` 是**词法（token 级）替换**——只把源码里字面写作 `global.DEFAULT_ONEDRIVE_CLIENT_ID` 的地方换成字符串字面量，**不会**在运行时 `window` 对象上设属性——两者不再匹配后常量静默变成 `undefined`，鉴权 URL 用空 clientID 生成 → 弹窗空白。同一次提交里 `setTimeout`→`window.setTimeout` 是安全的（`window` 上真有 `setTimeout`），但 `DEFAULT_ONEDRIVE_CLIENT_ID` 依赖 define 词法注入、`window` 上根本没这属性——两类改动形似而神不同。

## 症状

- 手机（及桌面）上点击"鉴权"，弹出空白弹窗，无任何内容。
- `main.js` 里出现未替换的成员访问 `window.DEFAULT_ONEDRIVE_CLIENT_ID` / `window.DEFAULT_ONEDRIVE_AUTHORITY`，运行时求值为 `undefined`。
- 连锁：`DEFAULT_ONEDRIVE_CONFIG.clientID = undefined ?? "" = ""`，鉴权弹窗 `onOpen` 用空 clientID 调 `getAuthUrlAndVerifierOnedrive("", "")` → 生成无效 URL / `await` 抛错 → `contentEl` 从未填充 → 空白弹窗。
- 只在**新装 / 重装 / token 过期或被撤销**时暴露；已鉴权设备 token 持久化在 localdb，不走生成 authUrl 的路径，所以无感——这解释了 0.6.10–0.6.13 四个版本发出来没人报。

## 根本原因（两层）

### 1. 潜在机制：esbuild define 是词法替换，不是运行时属性注入

`esbuild.config.mjs` 的 `define` 块：

```js
define: {
  "global.DEFAULT_ONEDRIVE_CLIENT_ID": `"5be03f08-..."`,
  "global.DEFAULT_ONEDRIVE_AUTHORITY": `"https://login.microsoftonline.com/common"`,
  global: "window",   // 把所有 `global` 标识符替换为 `window`
}
```

esbuild 在编译期扫描源码，**逐 token 匹配**：看到字面写作 `global.DEFAULT_ONEDRIVE_CLIENT_ID` 的成员表达式，整段替换为字符串字面量 `"5be03f08-..."`。它**不**在运行时给 `window` 对象设置 `DEFAULT_ONEDRIVE_CLIENT_ID` 属性——这是纯文本级的编译期替换。

正确的源码访问方式是 `global.DEFAULT_ONEDRIVE_CLIENT_ID`（与 define 规则字面匹配）。原版 remotely-save 自 `fd38bca` 起一直这么写，工作正常。

### 2. 触发（本 fork，提交 3dc6a5c "tuned eslint auto-fix"，0.6.10）

这次提交引入 `eslint-plugin-obsidianmd` + tuned eslint 配置。提交里除了 obsidianmd 的 `prefer-create-el`（`createEl("span")`→`createSpan()`）等 auto-fix 外，作者**手动**把 `baseTypes.ts` 的 `global.` 改成了 `window.`：

```diff
-export const ONEDRIVE_CLIENT_ID = global.DEFAULT_ONEDRIVE_CLIENT_ID;
-export const ONEDRIVE_AUTHORITY = global.DEFAULT_ONEDRIVE_AUTHORITY;
+export const ONEDRIVE_CLIENT_ID = window.DEFAULT_ONEDRIVE_CLIENT_ID;
+export const ONEDRIVE_AUTHORITY = window.DEFAULT_ONEDRIVE_AUTHORITY;
```

同一提交里 `fsOnedrive.ts:750` / `misc.ts:522` 的 `setTimeout`→`window.setTimeout` 是**安全的**——`window.setTimeout` 在 Obsidian（Electron/Capacitor）运行时真实存在，是 Obsidian 推荐写法。但作者没意识到 `DEFAULT_ONEDRIVE_CLIENT_ID` 性质完全不同：它依赖 esbuild define 的词法注入，`window` 上根本没有这属性。两类改动形似而神不同，且 **commit message 只字未提这行改动**（只提了 `prefer-create-el` / `no-useless-escape` 两类 auto-fix）。

改成 `window.` 后：
- esbuild 的 define 规则 `global.DEFAULT_ONEDRIVE_CLIENT_ID` **不命中**（源码访问的是 `window.DEFAULT_ONEDRIVE_CLIENT_ID`，token 序列不同）；
- 同时也没有 `window.DEFAULT_ONEDRIVE_CLIENT_ID` 的 define 规则；
- 于是编译后 `window.DEFAULT_ONEDRIVE_CLIENT_ID` 原样保留在 `main.js` 里，运行时求值为 `undefined`。

## 这是一个可复用的模式

> 同一次"统一 globals 写法"的改动里，把 `setTimeout`→`window.setTimeout` 和 `global.DEFAULT_X`→`window.DEFAULT_X` 一起改了，前者无害（window 上真有该 API）、后者致命（依赖构建期 define 词法注入，window 上无此属性）。**形似的两处改动，语义完全不同**——区别在于该标识符是"浏览器原生 API"还是"构建期 define 注入的编译期常量"。

危险在于：diff 看不到（都是把 `global.`/裸 `setTimeout` 改成 `window.`）、typecheck 看不到（`declare global { var ... }` 把它类型标成 `string`）、happy-path 测试看不到（tsx 单测不经 esbuild define，常量本就 undefined，但无人断言非空）、esbuild 自己也不报警（它不警告"定义的 define token 没被源码命中"）。

## 为什么所有门都失效

| 检测门 | 结果 | 原因 |
|---|---|---|
| `tsc -noEmit` | ✅ 过 | `declare global { var DEFAULT_ONEDRIVE_CLIENT_ID: string }` 声明它是 string；`window.DEFAULT_ONEDRIVE_CLIENT_ID` 类型合法 |
| `mocha --import=tsx`（619 测试） | ✅ 过 | tsx 直接执行 TS，**不经 esbuild define**，常量在测试环境也 undefined，但没有任何测试断言它非空 |
| `esbuild` 构建 | ✅ exit 0 | esbuild 不会报告"定义的 define token 未被源码命中"——这是合法的（define 可以不被使用） |
| 运行时 | ❌ 鉴权失败 | 常量 = undefined → 空 clientID → 无效 authUrl → 空白弹窗 |

**唯一能抓到的是构建产物断言**：检查 emit 出的 `main.js` 里是否真的注入了字符串字面量、是否残留未替换的 `.DEFAULT_ONEDRIVE_*` 成员访问。

## 证据

### Git 考古

- `fd38bca`（上游 v0.5.25 基线，fork 起点）：`baseTypes.ts` 用 `global.DEFAULT_ONEDRIVE_CLIENT_ID`，`esbuild.config.mjs` define `global.DEFAULT_ONEDRIVE_CLIENT_ID`，两者匹配，工作正常。
- `3dc6a5c` "chore: tuned eslint (obsidianmd) auto-fix + self-check tooling"（0.6.10）：**唯一危险改动**——把 `baseTypes.ts` 的 `global.` 改成 `window.`，define 块未同步修改。同提交其他源码改动（`createEl`→`createDiv/Span`、`setTimeout`→`window.setTimeout`）均安全。
- 0.6.10 / 0.6.11 / 0.6.12 / 0.6.13 四个 tag 全部受影响。
- 修复提交（0.6.14）：改回 `global.DEFAULT_ONEDRIVE_*`，加 `src/baseTypes.ts` 头部注释防止再被手改。

### 关键判据

`main.js` 里若出现 `window.DEFAULT_ONEDRIVE_CLIENT_ID`（属性名，minify 不重命名属性），即说明 define 没命中。注入成功时该属性名会**整个消失**（被字符串字面量替换）。

## 防御措施（0.6.14 落地）

1. **源码头部注释**：`src/baseTypes.ts` 第 14–21 行加注释，明确说明必须读 `global.DEFAULT_*` 而非 `window.DEFAULT_*`，以及"不要 auto-fix 成 window"。
2. **构建产物断言** `scripts/verify-build.mjs`，接到 `npm run build` 末尾，断言 `main.js`：
   - 不含 `.DEFAULT_ONEDRIVE_CLIENT_ID` / `.DEFAULT_ONEDRIVE_AUTHORITY` 拦留访问（define 命中则属性名整个消失）；
   - 含 client-id / authority 字符串字面量。
   
   已验证：注入一条 `window.DEFAULT_ONEDRIVE_CLIENT_ID` 模拟回归，verify **exit 1** 拦住；修复版 4 项全 PASS。CI 的 release workflow 会跑 `npm run build`，故 define 再失配会在发版 CI 阶段拦住，不会发布坏版本。
3. **本复盘文档**，列入 `docs/lessons/`，供后续维护者参考。

## 教训

- **"统一 globals 写法"时要区分两类标识符**：浏览器原生 API（`setTimeout`/`DOMParser`，`window` 上真实存在，改成 `window.` 安全）vs 构建期 define 注入的编译期常量（`DEFAULT_ONEDRIVE_*`，依赖词法匹配，`window` 上无此属性，改成 `window.` 致命）。形似的改动，语义不同。
- **commit message 必须覆盖每一处行为改动**：3dc6a5c 的 message 只提了 `prefer-create-el` / `no-useless-escape`，对 `global.→window.` 这行只字未提——review 时这行就成了盲区。
- **构建期注入的常量，typecheck 和单测都看不到**——因为它们不跑 bundler 的 define。必须用**构建产物断言**作为独立防线。
- **回归在"新装/重鉴权"路径才暴露**：已鉴权用户有 token 缓存不走该路径，导致 4 个版本无人发现。发版前应在干净环境（无 token）走一遍鉴权全流程。
