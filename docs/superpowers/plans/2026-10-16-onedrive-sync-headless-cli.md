# OneDrive Sync Headless CLI — 实施计划

- **关联 spec**:`docs/superpowers/specs/2026-10-16-onedrive-sync-headless-cli-design.md`
- **日期**:2026-10-16
- **状态**:草案,待 spec review 通过后开工;**Phase E 须先解 spec §4.4 许可证门**
- **不动**:`src/sync.ts`(另一会话的类型清理 WIP);本计划只新增 CLI 适配层 + 共享 DCF 模块,不改同步核心。

## Steps

- [x] **A1** 共享 DCF 模块 `acquireByDeviceCode()` + 单测(mock `/devicecode`+`/token`) — ✅ done+verified (12 tests, 0 typecheck errs)
- [x] **B1** `NodeFs extends FakeFs` — ✅ done+verified (M2,walk-smoke 通过)
- [x] **B2** `NodeDb`(实现 `InternalDBs`,单 JSON/表) — ✅ done+verified (M2.5,db-smoke 通过;storeNames 对齐 localdb)
- [x] ~~**B3** `graphRequest` 加 node `fetch` 分支~~ —— **取消**(obsidian 桩吸收 transport,`graphRequest` 不改;见 Milestone 1)
- [x] **B4** `obsidian` 桩生产化(`cli/obsidianStub.ts`,4 符号 fetch-backed) — ✅ done+verified (Milestone 1,smoke 通过;`Notice`/`moment` 等经 grep 确认不在 sync 子集,无需桩)
- [x] **B5** smoke:纯 Node 下 `import` src + 真实目录 `walk`/`stat`/`readFile` — ✅ done (M1 import+graphRequest,M2 walk;NodeFs stat/readFile 经 walk-smoke)
- [x] **C0** CLI polyfill(`cli/polyfills.ts`:`globalThis.window`+极简 `moment` shim `.toISOString(true)`+`.format()`) — ✅ done+verified (assembly-smoke:`unixTimeToStr` 两分支不抛)
- [ ] **C1** `cli/index.ts` 装配四件套 + 调 `runSync`
- [ ] **C2** `odsync` 命令(`login --device-code`/`sync --vault --once|--watch`/`status`/`resolve`)
- [ ] **C3** CLI 配置文件(`~/.config/ods/config.json`,`0600`)+ `client_id`/authority env 注入
- [ ] **D1** 独立 node-platform esbuild target(去 `nodeCryptoStubPlugin` 等 stub,`platform:"node"`)
- [ ] **D2** 构建 smoke + 真实个人账户 DCF 登录 + 双向同步验证(交替运行,不并发)
- [ ] **E1**(gated by §4.4)许可决策后:Docker 镜像 / 公开 npm

## Detail

### Phase A — 共享 DCF 模块(可独立先行;= 手机 Phase 3)
**A1** — 新建 `src/deviceCode.ts`(flat):`acquireByDeviceCode(clientID, authority, httpPost, opts)`。`httpPost` 注入(Obsidian→`request`、Node→`fetch`)。`POST /devicecode`(body `client_id`+`scope`;**无 body tenant**,/common 路径权威)→ 回调打印 `user_code`+`verification_uri` → 按 `interval` 轮询 `POST /token`(body `grant_type=urn:ietf:params:oauth:grant-type:device_code`+`client_id`+`device_code`;**无 body tenant**)。错误:`authorization_pending`→续轮、`slow_down`→`interval*=1.5`、`authorization_declined`/`expired_token`/`bad_verification_code`→返失败型;`cancel` 信号 + `expires_in` 截止。**返回 `AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType`**(同 `sendAuthReq`);调用方复用现有 `setConfigBySuccessfullAuthInplace` 填 `OnedriveConfig`;`username` 经现有 `getUserDisplayName`(DCF 不碰)。type-only import 响应类型 from `fsOnedrive`,无 runtime import(纯 Node 可加载)。
- **验证**:单测 mock `httpPost`,覆盖 `authorization_pending`/`slow_down`(断言 interval 增)/`authorization_declined`/`expired_token`/`bad_verification_code`/cancel/成功;断言返回 = `AccessCodeResponseSuccessfulType`。
- **手机复用**:`httpPost` 注入 + 无 PKCE/crypto → Obsidian 手机传 `request` 封装即可用(= 2026-10-14 Phase 3);Node 传 `fetch` 封装。
- **不动**:msal-node 的桌面 `getAuthCodeUrl`+`CryptoProvider`(`getAuthUrlAndVerifier:396`)保持不变;`fsOnedrive.ts`/`sync.ts` 不改。

### Phase B — Node 适配四件套
**B1** `NodeFs`:`src/platform/node/fsLocalNode.ts`。照 `_fsMock.ts` 形状,`Map`→`node:fs/promises`。`walk`=递归 `readdir`+`stat`;`writeFile`=`fs.writeFile`+`utimes`(设 mtime;ctime 多数 FS 系统管,记 gap);`rm`=`fs.rm`(或 trash lib,见 §9 开放);**不实现** Obsidian-config-sync(`syncObsidianConfig` 等=false)。
**B2** `NodeDb`:`src/platform/node/dbNode.ts`。实现 `InternalDBs`(10 字段),每个 `LocalForage` 由 `FileForage`(JSON+debounce 落盘,接口 `getItem/setItem/removeItem/getItems/removeItems/keys/iterate/length/clear`)支持。照 `_dbMock.ts` 形状。后端待定(§9 Q5)。
**B3** `graphRequest`(`fsOnedrive.ts:93`):加分支——运行时若 `typeof requestUrl===undefined`(非 Obsidian)走 node `fetch`,包成同一 `GraphResponse` 形状。grep 确认 `request`(line 9 import)所有调用点一并处理。
**B4** 桩生产化:`src/platform/node/obsidianRuntimeStub.ts`(提级 `_obsidianStub.ts`)+补 `Notice`(no-op/console)、`request`/`requestUrl`(若 B3 未全覆盖则在桩里指向 fetch)。
**B5** smoke:`node -e "import('./src/...')"` + 真实目录 walk/stat/readFile,确认无 `obsidian`/`window`/stub 抛错。

### Phase C — CLI 装配
**C1** `cli/index.ts`:装配 `NodeFs`+`NodeDb`+`FakeFsOnedrive`+`acquireByDeviceCode`,调现有 `runSync`(sync.ts 入口,不改)。
**C2** 命令(建议 `commander`):`login --device-code`、`sync --vault <p> --once|--watch [--dry-run] [--verbose]`、`status`、`resolve --list|--keep-local <p>|--keep-remote <p>`。`--watch` 见 §9 Q3。
**C3** 配置:`~/.config/ods/config.json`(0600)存 `OnedriveConfig` 等价 JSON;`client_id`/authority env(`ONEDRIVE_CLIENT_ID`/`ONEDRIVE_AUTHORITY`,默认沿用插件 define 值)。可复用 `configPersist.ts` 混淆或明文+0600(§9 Q2)。

### Phase D — 独立构建 + 集成
**D1** `esbuild.config.cli.mjs`(或同文件第二 target):`platform:"node"`,`format:"cjs"`/`esm"`,**不加** `nodeCryptoStubPlugin`/`nodeUrlStubPlugin`/`localforageScriptStubPlugin`(真 node 内建),entry `cli/index.ts`。
**D2** 构建 smoke(`npm run build:cli`)+ 真实个人账户 DCF 登录 + 双向同步(小 vault);交替运行验证(插件关→CLI→插件开,无状态损坏)。

### Phase E — 分发(gated)
**E1** 前置:解 §4.4 许可证门(个人自用免;公开发布须定 PolyForm 策略)。未决策前不启动。

---

## 开放问题(spec §9 回指)
1. 许可证(个人 vs 公开,gate E)2. 配置文件位置 3. `--watch` 4. 并发检测锁 5. NodeDb 后端(单 JSON vs better-sqlite3)

开工顺序建议:**A1 先行**(独立 + = 手机 Phase 3)→ spec review 通过 → B→C→D;E 待许可决策。
