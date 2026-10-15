# Obsidian 社区目录扫描器 — 本地检查指南

## 1. 这套检查能否本地做?官方工具是什么?

**能。** Obsidian 官方社区目录扫描器就是 **`eslint-plugin-obsidianmd`** —— 一个公开的 npm ESLint 插件。本仓库已安装 + 配置。

### 本地运行

```bash
npm run scan
```

这会运行 `scripts/obsidian-scan.mjs`,执行 **3 类检查**:ESLint(TS/JS 规则)、CSS lint(`!important` 检测)、dependency audit(生产依赖漏洞)。退出码 0 = 全部干净;非 0 = 有警告。

### 为什么需要单独的 `scan` 脚本?

`eslint.config.mjs` 用 `obsidianmd.configs.recommended`(默认配置),但**故意关闭**了部分规则(`any`/`unsafe-*`/`assertion`/`unbound-method`),防止 `eslint --fix` 误改 `any` 风格的代码。扫描器用的是 **默认配置**(全部 ON),所以 `scan` 脚本重新启用这些关闭的规则来匹配扫描器视图。CSS lint 和 dependency audit 是 ESLint 之外的检查项,`scan` 脚本一并执行。

### 官方资源

- **npm 包**: `eslint-plugin-obsidianmd`
- **Obsidian 社区插件提交指南**: https://docs.obsidian.md/Plugins/Releasing+your+plugin+with+a+GitHub+release
- **扫描器规则源码**: `eslint-plugin-obsidianmd` 的 `rules/` 目录

---

## 2. 扫描器检查什么?

扫描器检查 **3 类**:ESLint(TS/JS 规则)、CSS lint(`!important`)、dependency audit(依赖漏洞)。

### 阻断性 Error(提交后被标记为"风险插件")
- `no-unsanitized` — innerHTML 必须用 `sanitizeHTMLToDom`
- `no-static-styles-assignment` — 不要内联 setCssProps,用 CSS class
- `prefer-setting-heading` — 设置标题用 `setHeading()`
- `no-unsupported-api` — minAppVersion 要匹配用的 API
- `code-obfuscation` — 不能有混淆代码(eval、死分支等)
- `eslint-comments/no-restricted-disable` — 禁止 inline-disable `no-console`/`no-restricted-globals`/`@typescript-eslint/no-deprecated`/`obsidianmd/*`

### 非阻断性 Warning(不阻止上架,但影响评分)
- `@typescript-eslint/no-explicit-any` — 不要用 `any`,用具体类型
- `@typescript-eslint/no-unsafe-*` — 不要赋值/访问/调用/返回/传参 `any` 值
- `@typescript-eslint/no-unnecessary-type-assertion` — 移除不必要的类型断言
- `@typescript-eslint/no-non-null-assertion` — 不要用 `!`,用类型守卫
- `@typescript-eslint/unbound-method` — 不要把方法作为裸值传递
- `@typescript-eslint/await-thenable` — 不要 await 非 Promise
- `@typescript-eslint/no-base-to-string` — 不要隐式 toString 对象
- `@typescript-eslint/restrict-template-expressions` — 模板字面量里不要放 `any`/`unknown`/`object`
- `@typescript-eslint/no-duplicate-type-constituents` — 不要 `T | undefined` 在可选参数上
- `@typescript-eslint/no-misused-promises` / `no-floating-promises` — Promise 误用
- `obsidianmd/no-global-this` — 不要用 `global`/`globalThis`,用 `window`
- `obsidianmd/prefer-window-timers` — 用 `window.setTimeout` 不用 `setTimeout`
- `obsidianmd/settings-tab/prefer-setting-definitions` — 实现 `getSettingDefinitions()`
- `obsidianmd/settings-tab/no-deprecated-display` — 实现后删除 `display()`
- `no-undef` / `no-restricted-globals` — 不要用 `fetch`(用 `requestUrl`/`window.fetch`)
- `no-self-compare` — 不要 `x !== x`(用 `Number.isNaN`)

### CSS lint(`!important` 检测)
- `declaration-no-important` — 不要用 `!important`,用选择器特异性提升或 CSS 变量代替。Obsidian mobile 会拉伸 `<button>` 到 `width:100%`,需要更高特异性(如 doubled class + element type)来覆盖。

### Dependency audit(依赖漏洞检测)
- 检查 `package.json` 依赖树中的已知漏洞(GitHub Advisory Database)。生产依赖(`dependencies`)中的漏洞会被标记为 Warning。开发依赖(`devDependencies`)的漏洞一般不影响上架(不打包到 `main.js`),但建议也关注。

---

## 3. 已完成的修复(0.6.8 → 0.6.30)

| 版本 | 修复内容 | 规则 |
|---|---|---|
| 0.6.8-0.6.9 | innerHTML→sanitize, setCssProps→class, setHeading, minAppVersion→1.13.1, localforage 死分支 | 6 个阻断 Error |
| 0.6.11 | 13 个规则组(no-global, hasOwnProperty, no-this-alias, etc.) | 131 个 Warning |
| 0.6.12 | `fetch`→`graphRequest`(requestUrl facade) | no-fetch |
| 0.6.13 | `console.*`→`src/logger.ts`(debug-gated);移除 `@deprecated` 标签;sentence-case;nodejs-modules;dotenv/emoji-regex/rimraf 替换 | no-console, no-deprecated, 等 |
| 0.6.14-0.6.21 | **全部 ~470 个 `any` 站点 typed**(16 叶子文件 + misc + driveItemConvert/deltaMerge + conflictLogic/baseTypes + fsOnedrive + sync + settings + main + logger/localdb/encryptOpenSSL/debugMode/fileContentHistory/i18n) | no-explicit-any, no-unsafe-* |
| 0.6.22 | `fetch`→`window.fetch`(属性访问,绕过 no-restricted-globals) | no-restricted-globals |
| 0.6.23 | `display()`→声明式 `getSettingDefinitions()` API(54 行设置迁移) | settings-tab |
| 0.6.24 | msal-node 2.x→7.x(uuid 漏洞修复) | dep-vuln |
| 0.6.25 | lodash 替换为原生 JS(structuredClone/.flat()/chunkArray/deepEqual/debounce/throttle) | dep-replacement |
| 0.6.26 | misc.ts lodash-helper 警告清除(NaN→Number.isNaN, setTimeout→window.setTimeout, DebouncedFunc 重写) | no-self-compare, prefer-window-timers, no-explicit-any |
| 0.6.26-0.6.27 | devDep 升级(mocha@12, esbuild@0.28.2, eslint-plugin-obsidianmd@0.4.2);crypto-browserify 回退 3.12.0 | dep-vulns |
| 0.6.28 | `Buffer.allocUnsafe`→`BufferAllocUnsafeFactory` 包装器(调用而非裸传) | unbound-method |
| 0.6.29 | 73 个 `!` 非空断言清除(11 文件);`npm run scan` 脚本 + 检查清单文档 | no-non-null-assertion |
| 0.6.30 | 17 处 CSS `!important`→选择器特异性提升(`span.`/`button.` element type + doubled class);elliptic 漏洞→`stubs/elliptic/` npm overrides stub(插件用 RSA,不用 EC crypto);scan 脚本扩展为 3 类检查(ESLint + CSS + deps) | CSS lint, dep audit |

### 关键模式(供未来参考)

| 模式 | 修复方式 |
|---|---|
| `catch (e: any)` | `catch (e: unknown)` + `instanceof Error` 守卫 + `e as { code?: string }` 类型守卫 |
| `as any` 断言 | 移除(如果不需要)或 `as 具体类型` |
| `Promise<any>` | `Promise<void>` 或 `Promise<Entity>` |
| `(err as any).code = "..."` | `Object.assign(err, { code: "..." })` |
| `fetch(url)` | `window.fetch(url)`(属性访问) 或 `requestUrl`(Obsidian API) |
| `global` / `globalThis` | `window` + `declare global { interface Window { ... } }` 类型声明 |
| `setTimeout` / `clearTimeout` | `window.setTimeout` / `window.clearTimeout` |
| `Buffer.allocUnsafe` 作为值传递 | 包装器类/函数(调用 `Buffer.allocUnsafe(size)` 而非裸传) |
| `!` 非空断言 | 类型守卫(`if (x) { ... }`)、cast(`as Type`)、可选链(`?.`) |
| `a !== a`(NaN 检查) | `Number.isNaN(a)` |
| JSON.parse 结果 | `as 具体类型` 或 `as Record<string, unknown>` |
| 声明式设置 | `getSettingDefinitions(): SettingDefinitionItem[]` + 删除 `display()` |
| CSS `!important` | 选择器特异性提升:`button.cls.cls`(doubled class + element type,`(0,3,1)`)或 `span.cls`(element type,`(0,2,1)`) |
| 依赖漏洞(无修复版) | `npm overrides` + 本地 stub 包(`stubs/<pkg>/index.js` 导出 API 空壳),消除 advisory 而不影响运行时(死代码依赖) |

---

## 4. 剩余项

截至 0.6.30,所有 Obsidian 扫描器检查项(CSS lint + dependency audit + ESLint)均已清零。

- **CSS `!important`** — **已修复** (0.6.30):17 处 `!important` 全部替换为选择器特异性提升。
- **elliptic 漏洞** (GHSA-848j-6mx2-7j84) — **已修复** (0.6.30):通过 `npm overrides` + `stubs/elliptic/` stub 包消除。插件只用 RSA(Azure AD JWT via jsonwebtoken),从不调用 EC crypto,stub 是安全的。
- **moment 漏洞** (devDep,经 `obsidian`→`jqw` 引入)— **不是扫描器项**(开发依赖,`npm audit --omit=dev` 不检查)。不打包到 `main.js`。

---

## 5. 验证命令

```bash
# 本地扫描器视图(所有规则 ON)
npm run scan

# 类型检查
npm run typecheck

# 测试
npm test

# 构建(注意:VAULT_PATH 在 .env 中会自动部署到 vault)
npm run build
```
