# 选择性配置同步设计（Sidecar 明文投影）

- 日期：2026-08-13
- 状态：设计待审
- 关联根因：`conflictAction=smart_conflict` 对混淆成单串的 `data.json` blob 不可合并，导致跨设备配置项（如 `ignorePaths`）丢失

## 1. 背景（根因回顾，已代码确认 + 用户实测坐实）

- `data.json` 由 `configPersist.ts` 编码为 `{readme, d}`，其中 `d = reverseString(base64url(JSON.stringify(全部 settings)))`——整个 settings 对象被压成**一个** base64 反转串。任意字段变动都让整串变。
- 用户 `conflictAction = "smart_conflict"`（非默认 keep_newer）。两端都改了 data.json 时走 `conflict_modified_then_smart_conflict`（`baseTypes.ts:134-159`），由 `mergeUtils.threeWayMerge`（Apache，node-diff3）对**文本行**做 3-way 合并，且**不解码**。
- 单串 blob 在文本行级合并下必冲突 → 正则（等字段）从 live data.json 丢失。用户实测：**关闭混淆后稳定成功，开启混淆必失败**——100% 坐实。
- 附带触发链：`loadSettings` 末尾无条件 `saveSettings`（`main.ts:925`）补默认值、`fsOnedrive.ts:523` token 刷新回调 `saveSettings`，都会让"未手动改配置"的设备 data.json 被判"已修改"，从而触发 smart_conflict。

## 2. 目标

1. **保留 `data.json` 混淆**（本地隐私防偷窥）。
2. **跨设备同步"用户勾选"的插件配置项**，可配置。
3. 根除上述 blob 不可合并的根因。
4. 复用项目现有模式，不破文件格式无关的 sync 架构，不碰 PolyForm 文件（`sync.ts`/`conflictLogic.ts`/`fileContentHistory.ts`/`clearDupFiles.ts`/`settingsClearDupFiles.ts`）。

## 3. 非目标

- 不改 sync 引擎、不改 conflictLogic、不改 mergeUtils。
- 不解决"其它插件自己 data.json"的同步问题（各自插件职责）。
- 不在远端明文传输加密密码 `password`。

## 4. 约束（用户硬性要求）

- 运行行为稳定可控，无潜在风险。
- 无性能劣化。
- 不提高软件复杂度，结构清晰易维护。
- 保持混淆。

## 5. 架构

三个存储，职责分明：

| 存储 | 内容 | 是否同步 | 是否混淆 |
|---|---|---|---|
| `data.json`（插件目录） | 全量本地设置；`password` 与 onedrive 鉴权均**剥空** | ❌ 不同步（从白名单移除） | ✅ 保持混淆（纯本地） |
| `synced_settings.json`（插件目录，新） | 仅"用户勾选要同步"的字段；明文多行 JSON | ✅ 普通文件同步 | ❌ 明文（无秘密） |
| 设备本地 DB（localforage，已有） | onedrive 鉴权（现状）+ **新增 `password`** | ❌ 按设备独立 | — |

要点：data.json 不再进同步 → blob 撞死根因消失；旁车是明文多行 JSON → smart_conflict 行级干净合并；`password` 走与 onedrive 鉴权**完全相同**的 DB 模式。两存储各司其职、互不耦合。

## 6. 组件与落点

### 6.1 password → DB（扩 `main.ts` 现有 auth 模式）
- 现状：`extractOnedriveAuth`/`mergeOnedriveAuthFromDB`/`stripOnedriveAuthInPlace`（`main.ts:929-963`）+ DB 记录 `OnedriveAuthFields`（`localdb.ts:660`）。
- 改动：把 `password` 纳入该"设备级秘密"记录（扩 `OnedriveAuthFields` 加 `password`，或独立 secrets key——**实现时取扩记录方案**，一次 DB 访问）。
- `saveSettings`（`main.ts:996`）：在 `stripOnedriveAuthInPlace` 同处把 `password` 置空（data.json 副本里），并把 password upsert 入 DB。
- `loadSettings`（`main.ts:825`）：在 `mergeOnedriveAuthFromDB` 同处回并 password。
- 迁移：仿 `mergeOnedriveAuthFromDBOrMigrate`（`main.ts:980`），升级首跑从旧 data.json 读 password→写 DB→之后 data.json 剥空。

### 6.2 旁车投影/回并（新纯函数模块 `src/syncSettings.ts`，Apache）
- `SYNCABLE_FIELDS`：可选字段目录（字段名 + 类型），供 UI 与校验。
- `projectSyncableFields(settings, fields: string[]): Partial<RemotelySavePluginSettings>`：抽已选字段为普通对象。
- `applySyncedFields(settings, partial, fields: string[]): RemotelySavePluginSettings`：把下载的旁车 partial 并入 settings（仅已选字段，未选不动；未知字段忽略）。
- 纯函数、可独立单测。

### 6.3 旁车读写（`main.ts`，贴 saveSettings/loadSettings）
- 路径：`<manifest.dir>/synced_settings.json`（即 `.obsidian/plugins/<id>/synced_settings.json`）。
- `writeSidecar`：`JSON.stringify(projectSyncableFields(...), null, 2)`（pretty 多行，便于行级合并）；**带内容 diff 守卫**——内容不变不写、不 bump mtime（仿 `main.ts:1020`），防乒乓。
- `readSidecar`：读 + `JSON.parse`；缺失返 null；解析异常捕获返 null（绝不抛到上层）。

### 6.4 SYNC_DONE 回并监听（`main.ts`）
- onload 注册 `this.syncEvent.on("SYNC_DONE", reconcileSidecar)`（无条件注册；reconcile 在旁车缺/未变时为 no-op）。
- `reconcileSidecar`：`readSidecar`→`applySyncedFields` 进 `this.settings`→`saveSettings`（落 data.json；旁车内容未变则 writeSidecar diff 不写→不 bump→无乒乓推送）。
- **这是原 clobber bug 的设计性根治**：同步后强制重读旁车进内存 + 落盘，内存永不落后于盘。

### 6.5 同步白名单改动（`obsFolderLister.ts:18-32` `isLikelyPluginSubFiles`）
- **移除** `data.json`（停止同步）。
- **新增** `synced_settings.json`。
- 净效果：data.json 永不进同步；旁车作为普通文件走现有管线。

### 6.6 设置 UI（`settings.ts`）
- 新增"同步的配置项"开关列表，存 `syncedSettingFields: string[]`（**本设备、不同步**——它是选择本身）。
- UI 复用思路：可仿 `regexListSetting.ts` 的 chip-list，但条目是固定 `SYNCABLE_FIELDS` 而非自由输入。

## 7. 数据流

- **saveSettings（任意触发）**：① 剥 auth+password→DB ② data.json 混淆写（带 diff） ③ 旁车投影写（带 diff）。
- **loadSettings（启动）**：① data.json 解码 ② DB 回并 auth+password ③ readSidecar→applySyncedFields（旁车对"已选字段"权威） ④ 补默认。
- **SYNC_DONE（同步后）**：readSidecar→applySyncedFields 进内存→saveSettings 落 data.json（旁车内容未变则不重写→无乒乓）。
- **同步本身**：旁车是普通文件，smart_conflict 对明文多行 JSON 行级合并；data.json 不在清单、永不参与。

## 8. 错误处理

- 旁车缺失（首跑/新设备）：readSidecar 返 null→跳过回并；首次 saveSettings 时生成。新设备靠同步拿到旁车→回并生效。
- 旁车损坏（坏 JSON / 极少数合并冲突标记）：readSidecar 捕获解析异常→记日志+本次跳过；**绝不把坏值写进 data.json**（applySyncedFields 只接受合法解析值）。data.json 仍是本地真相。
- 旁车含未知字段（版本新旧）：忽略未知字段（前向/后向兼容）。
- DB 缺 password（升级首跑）：一次性迁移（见 6.1）。

## 9. 迁移与兼容

- 升级首跑：password 从旧 data.json 迁到 DB（一次性，仿 `main.ts:980`）。
- data.json 从白名单移除后，远端旧 data.json 成孤儿（无害、可留；不清删以避免风险）。
- `syncedSettingFields` 未定义→给默认可选集（见 §10）。
- `.gitignore` 的 `data.json` 保留（data.json 仍本地敏感）。旁车不需进 .gitignore（本就该同步，且在 .obsidian 下）。
- **前提**：选择性同步需 `syncConfigDir` 开（旁车在 .obsidian 内）。与现状一致——配置同步本就要 syncConfigDir。

## 10. 默认可选字段集（提案）

**默认勾选（vault 级偏好，跨设备一致）**：
`ignorePaths`、`onlyAllowPaths`、`conflictAction`、`syncConfigDir`、`syncBookmarks`、`syncAppearance`、`syncUnderscoreItems`、`lang`、`concurrency`、`skipSizeLargerThan`、`protectModifyPercentage`、`syncDirection`、`deleteToWhere`、`encryptionMethod`、`autoRunEveryMilliseconds`、`initRunAfterMilliseconds`、`syncOnSaveAfterMilliseconds`。

**默认不勾（设备级，各自独立）**：
`enableMobileStatusBar`、`currLogLevel`、`disclaimerAcknowledged`、`obfuscateSettingFile`、`enableStatusBarInfo`。

**永不进可选集**：`password`、`onedrive`（鉴权，在 DB，按设备独立，本就不该跨设备同步）。

## 11. 测试

- `tests/syncSettings.test.ts`（新）：
  - project/apply 往返；仅已选字段投影；未选不动；未知字段忽略；部分字段容错；apply 再 project 幂等。
- 扩 `tests/configPersist.test.ts`：确认 `password` 被剥出 data.json（混淆后不含）。
- 黑盒手测（原失败用例，现预期通过）：混淆开 + smart_conflict + 双端，`ignorePaths` 加一条→同步→手机重启→正则稳定在。
- `npm run typecheck` + `npm test` 全绿。

## 12. 风险与边界

- **writeSidecar 必须 diff 守卫**（同 `main.ts:1020`）：内容不变不写，否则回并→重写→mtime=now→假"本地已改"→乒乓。已纳入 6.3。
- **SYNC_DONE 回并→saveSettings 的递归**：回并后 saveSettings 重投旁车，内容相同→diff 不写→不 bump→无递归推送。已纳入 §7。
- **`syncedSettingFields` 本设备不同步**：A 勾选 X、B 没勾，B 不会从旁车读 X。安全但有非对称；按设备选择本就如此，文档说明。
- **其他插件的 data.json** 不在本次范围。

## 13. 实现决策（已定，供实现参照）

- **password 不经旁车传输**：新设备密码来源走现有 QR 导入 / 手动设置流程，与本设计解耦。实现时仅需确认 QR 现状以撰写用户文档，不影响代码路径。
- **password 存放**：扩 `OnedriveAuthFields` 记录加 `password`（一次 DB 访问），不另建表。
- **旁车文件名**：`synced_settings.json`（实现时可调，不影响逻辑）。
