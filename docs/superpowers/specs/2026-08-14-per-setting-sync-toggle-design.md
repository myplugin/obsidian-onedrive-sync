# Per-Setting Sync Toggle (icon next to title) Design

- 日期：2026-08-14
- 状态：设计待审
- 依赖：selective-config-sync 特性（`2026-08-13-selective-config-sync-design.md`，已实现+验证）。本特性是其上的 UI 增强，不改底层同步机制。

## 1. 背景

selective-config-sync 已把 `data.json` 移出同步、改用明文 JSON 旁车 `synced_settings.json` 作同步单元。旁车是**字段投影**——只含 `syncedSettingFields` 数组列出的字段（`projectSyncableFields`/`applySyncedFields`，`src/syncSettings.ts`）。故字段级"同步/不同步"在机制层已存在：字段在 `syncedSettingFields` 里则同步、不在则不同步。缺的是每项可见的 UI 入口（之前的每项列表已删，嫌丑）。

## 2. 目标

给指定设置项的标题旁加一个图标开关（cloud / cloud-off），点击切换该字段在 `syncedSettingFields` 里的去留 = 控制该项是否跨设备同步。首批应用于 3 个定时设置（设备相关的定时：自动运行 / 启动后运行一次 / 保存后同步）。

## 3. 非目标

- 不做每项列表 UI（已删）。
- 不改底层同步机制（已建成）。
- 不让 `syncedSettingFields` 自身同步（它是本设备的选择本身）。

## 4. 架构

可复用 helper `addSyncToggle(setting: Setting, fieldName: string, plugin, t)`，新文件 `src/syncToggle.ts`（Apache；一个 UI 职责一个小文件，仿 `regexListSetting.ts`）：
- 在 `setting.nameEl` 标题文字**右侧**插入可点击图标 span。
- 状态：`plugin.settings.syncedSettingFields?.includes(fieldName) ?? true`（默认 ON，因 DEFAULT=全部 syncable）。
- 图标：ON→lucide `cloud`（主题强调色）；OFF→`cloud-off`（带斜杠云，灰）。用 Obsidian `setIcon`。
- tooltip（aria-label + title）：ON="跨设备同步中，点击改为仅本地"；OFF="仅本地，点击改为跨设备同步"。
- 点击：在 `syncedSettingFields` 增/删该字段 → `plugin.saveSettings()` → 重渲染图标（cloud↔cloud-off）。

应用到 `src/settings.ts` 三个定时 Setting（`:975` 自动运行 `autoRunEveryMilliseconds`、`:1013` 启动后运行一次 `initRunAfterMilliseconds`、`:1039` 保存后同步 `syncOnSaveAfterMilliseconds`），各在 `.setName().setDesc()` 链后调一次 `addSyncToggle`。

## 5. 数据流

- **渲染**：`addSyncToggle` 读 `syncedSettingFields` 含不含该字段 → 选 cloud/cloud-off。
- **点击切换**：增/删字段 → `saveSettings()` → `writeSidecar`（diff 守卫，内容没变不写）按新字段集重新投影 → 图标重渲染。下次同步旁车只含"开着的"字段。
- **接收端**：`applySyncedFields` 只应用本设备 `syncedSettingFields` 里的字段。某字段在任一端被关 → 发端不投（若发端关）或收端不应用（若收端关）→ 该字段两端都保持本地。两端都开 → 正常同步。

## 6. i18n

新增 2 键到 `en.json` / `zh_cn.json` / `zh_tw.json`：
- `settings_synctoggle_on`：en "Syncing across devices — click to keep local" / zh_cn "跨设备同步中，点击改为仅本地" / zh_tw "跨裝置同步中，點擊改為僅本地"
- `settings_synctoggle_off`：en "Local only — click to sync across devices" / zh_cn "仅本地，点击改为跨设备同步" / zh_tw "僅本地，點擊改為跨裝置同步"

## 7. 文件

- 新 `src/syncToggle.ts`（Apache）— `addSyncToggle(setting, fieldName, plugin, t)`。
- 改 `src/settings.ts` — import `addSyncToggle` + 在 3 个定时 Setting 上各调一次。
- 改 3 个 lang 文件 — 加 2 键。

## 8. 测试

- 底层机制（`syncedSettingFields` 的 project/apply）已有 `tests/syncSettings.test.ts` 7 测试覆盖。
- 切换只是增/删数组元素，逻辑琐碎；UI 渲染（setIcon）用 Obsidian API、不便单测。
- 可选：抽纯 `toggleFieldInList(list, field): string[]` 加 1-2 个测试（YAGNI 边际——要才加）。

## 9. 边界

- 默认全 ON（用户要求"默认全同步"）。
- `syncedSettingFields` 本设备不同步（它是选择本身）；非对称已文档（前特性 spec §12）。
- 不碰 PolyForm 5 文件、不破文件格式无关架构。
- Biome 风格照旧（2 空格、双引号、分号、es5 尾逗号；`any`/非空断言可接受）。
