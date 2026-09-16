# 设计方案：.obsidian 目录细粒度同步

**日期：** 2026-09-16  
**状态：** 已确认  
**原则：** 确保应同步尽同步，尽量保持多端一致性

## 背景

插件的 `syncConfigDir` 开关是一个总开关：开启时同步整个 `.obsidian` 目录，关闭时（默认）不同步 `.obsidian` 下的任何内容。这导致两个问题：

1. **版本不一致**：当 `syncConfigDir=false`（默认）时，插件自身的 `main.js` 不会被同步。另一台设备运行旧版本插件可能导致同步冲突和数据丢失。
2. **缺乏粒度**：当 `syncConfigDir=true` 时，`workspace.json` 等设备特定的文件也会被同步（`obsFolderLister.ts` 内置的黑名单只覆盖了 `workspace` 和 `workspace.json`）。无法只同步插件代码而不同步工作区状态，也无法只同步核心配置而不同步三方插件。

## 设计

用**五个独立开关**替换单一 `syncConfigDir` 开关，分为三个设置章节。开关之间互不控制——全部独立。

### 五个独立开关

| 开关 | 默认值 | 同步内容 | 始终排除 |
|------|--------|---------|---------|
| `syncObsidianConfig` | 开 | `.obsidian/*.json`（核心设置）、`snippets/`、`themes/`、`icons/` | `workspace*.json`、`core-plugins-migration.json`、`appearance.json`、`bookmarks.json`、`plugins/` |
| `syncAppearance` | 关 | `.obsidian/appearance.json` | — |
| `syncBookmarks` | 关 | `.obsidian/bookmarks.json` | — |
| `syncThirdPartyPlugins` | 开 | `.obsidian/plugins/*`（除本插件）的 `main.js`、`manifest.json`、`styles.css`、`data.json` | `remotely-save-onedrive/` |
| `syncSelfPlugin` | 开 | `.obsidian/plugins/remotely-save-onedrive/` 的 `main.js`、`manifest.json`、`styles.css`、`synced_settings.json`、`.gitignore` | `data.json` |

所有开关独立——关闭一个不影响其他。

### 设置页面布局

所有新选项放在**"同步选项" tab 页签**下，新建一个 **"Obsidian 同步"** 章节替换现有的 "settings_section_sync_scope" 章节（`settings.ts:1082`）。

**"Obsidian 同步" 章节下：**

- `syncObsidianConfig`（默认开）— 核心配置文件、snippets、themes
- `syncAppearance`（独立，默认关）— 外观设置
- `syncBookmarks`（独立，默认关）— 书签
- `syncThirdPartyPlugins`（默认开）— 其他插件的代码和设置
  - 描述说明：排除当前插件；用户可用 `ignorePaths` 正则排除特定插件
- `syncSelfPlugin`（默认开）— 插件自身的代码文件
  - 已有的 per-setting 同步开关（通过 `synced_settings.json` 旁车文件）保持不变；扩展 `SYNCABLE_FIELDS` 覆盖范围

现有的 `syncUnderscoreItems`、`syncDotItems` 开关保留在 "Obsidian 同步" 章节下（它们控制非 `.obsidian` 目录的隐藏文件同步）。

### 内置黑名单（始终排除）

无论开关状态如何，以下文件始终被排除：
- `.obsidian/workspace.json` — 窗口布局（设备特定）
- `.obsidian/workspace-mobile.json` — 移动端布局（设备特定）
- `.obsidian/workspaces.json` — 保存的工作区（设备特定）
- `.obsidian/core-plugins-migration.json` — 迁移状态（设备特定）
- `.obsidian/plugins/remotely-save-onedrive/data.json` — 插件本地同步状态（设备特定）

## 实现

### 需修改的文件

#### 1. `baseTypes.ts` — 新增设置字段

```typescript
syncObsidianConfig?: boolean;
syncThirdPartyPlugins?: boolean;
syncSelfPlugin?: boolean;
// syncConfigDir 保留用于向后兼容迁移，不在 UI 中显示
```

#### 2. `main.ts` — 默认值和参数传递

- 新增默认值：`syncObsidianConfig: true`、`syncThirdPartyPlugins: true`、`syncSelfPlugin: true`
- 保留 `syncConfigDir: false` 用于向后兼容
- 添加迁移逻辑：若 `syncConfigDir===true`，则将三个新开关全部设为 true
- 更新 `FakeFsLocal` 实例化，传递新参数
- 更新同步调用点，向 `checkIsSkipItemOrNotByName` 传递新参数

#### 3. `obsFolderLister.ts` — 核心列举逻辑（主要改动）

- 将 `bookmarksOnly: boolean` 和 `syncAppearance: boolean` 参数替换为：`syncObsidianConfig`、`syncAppearance`、`syncBookmarks`、`syncThirdPartyPlugins`、`syncSelfPlugin`（全部 boolean）
- 扩展 `skipNames` 黑名单：
  - 新增 `workspace-mobile.json`、`workspaces.json`、`core-plugins-migration.json`
  - 保留现有 `workspace`、`workspace.json`
  - 保留条件性 `appearance.json`（除非 `syncAppearance`）
- 重构 BFS 列举逻辑：
  - **根级别**（`.obsidian/` 本身）：当五个开关中任一开启时列举（需枚举子项以路由）
  - **根配置文件**（`*.json`）：当 `syncObsidianConfig` 开启时包含
    （`appearance.json` → `syncAppearance`，`bookmarks.json` → `syncBookmarks`，黑名单文件除外）
  - **`snippets/`、`themes/`、`icons/` 目录**：当 `syncObsidianConfig` 开启时包含
  - **`plugins/` 目录**：仅当 `syncThirdPartyPlugins` 或 `syncSelfPlugin` 开启时遍历
    - **其他插件子目录**：当 `syncThirdPartyPlugins` 开启时包含
    - **本插件子目录**：当 `syncSelfPlugin` 开启时包含（使用现有 `isLikelyPluginSubFiles` 过滤——仅 `main.js`、`manifest.json`、`styles.css`、`synced_settings.json`、`.gitignore`）

#### 4. `fsLocal.ts` — 更新构造函数和 walk 方法

- 构造函数：接受 `syncObsidianConfig`、`syncThirdPartyPlugins`、`syncSelfPlugin`（加上现有的 `syncAppearance`、`syncBookmarks`）
- walk 方法：当五个开关中任一开启时调用 `listFilesInObsFolder`（当前检查 `syncConfigDir || syncBookmarks`）
- 向 `listFilesInObsFolder` 传递全部五个开关

#### 5. `sync.ts` — `checkIsSkipItemOrNotByName`

- 将 `syncConfigDir: boolean` 参数替换为：`syncObsidianConfig: boolean`、`syncThirdPartyPlugins: boolean`、`syncSelfPlugin: boolean`
- 保留 `syncBookmarks`、`syncAppearance` 作为现有参数
- 更新 `.obsidian` 路由逻辑（第 195-226 行）：

```
若 key 位于 .obsidian/ 内：
  若 key 匹配黑名单（workspace*.json、core-plugins-migration.json）：
    → finalIsIgnored = true（始终跳过）
  否则若 key 为 bookmarks.json：
    → finalIsIgnored = !syncBookmarks
  否则若 key 为 appearance.json：
    → finalIsIgnored = !syncAppearance
  否则若 key 位于 plugins/remotely-save-onedrive/ 内：
    若 key 为 main.js/manifest.json/styles.css/synced_settings.json/.gitignore：
      → finalIsIgnored = !syncSelfPlugin
    否则：
      → finalIsIgnored = true（始终跳过，如 data.json）
  否则若 key 位于 plugins/ 内（非本插件）：
    → finalIsIgnored = !syncThirdPartyPlugins
  否则（根配置文件、snippets/、themes/、icons/）：
    → finalIsIgnored = !syncObsidianConfig
否则（.obsidian/ 之外）：
  → 现有逻辑（ignorePaths、onlyAllowPaths、隐藏文件等）
```

- 更新 `checkIsSkipItemOrNotByName` 的所有调用点（第 384、435、473 行）和 `FakeFsLocal` 构造函数调用（第 1216-1219、2107-2111 行）

#### 6. `settings.ts` — UI 重构

- 在 `generateSyncOptionsSection` 方法中，将现有 "settings_section_sync_scope" 章节替换为新的 "Obsidian 同步" 章节，包含五个开关
  - `syncObsidianConfig`（新增）
  - `syncAppearance`（保留现有，移至新章节）
  - `syncBookmarks`（保留现有，移至新章节）
  - `syncThirdPartyPlugins`（新增）
  - `syncSelfPlugin`（新增）
  - 保留 `syncUnderscoreItems`、`syncDotItems` 在此章节下
- 移除 `SyncConfigDirModal`（不再需要——无破坏性总开关）
- 添加描述文本说明内置黑名单

#### 7. `syncSettings.ts` — 添加到 SYNCABLE_FIELDS

```typescript
"syncObsidianConfig",
"syncThirdPartyPlugins",
"syncSelfPlugin",
```

从列表中移除 `syncConfigDir` — 新开关完全替代它，通过旁车同步旧标志会在其他设备上覆盖新设置。

#### 8. `settingsClearDupFiles.ts` — 更新参数传递

传递新开关值替代 `syncConfigDir`/`syncBookmarks`。

#### 9. `skipFilter.ts` — 更新纯函数

更新纯函数版本以匹配新的 `sync.ts` 签名，使测试继续工作。该函数用于测试跳过逻辑。

#### 10. i18n — 添加翻译键

在 `en.json`、`zh_cn.json`、`zh_tw.json` 中为新设置章节和描述添加键。

### 向后兼容

**设置迁移**（在 `main.ts` `loadSettings` 中）：
```
若 syncConfigDir === true（旧设置已开启）：
  → syncObsidianConfig = true
  → syncThirdPartyPlugins = true
  → syncSelfPlugin = true
  → syncConfigDir = false（清除旧标志）
否则：
  → 使用新默认值（syncObsidianConfig = true，syncThirdPartyPlugins = true，syncSelfPlugin = true）
```

`syncConfigDir` 字段保留在类型定义中，但不再在 UI 中显示或用于同步逻辑。

**测试兼容性**：更新 `skipFilter.ts` 测试和 `checkIsSkipItemOrNotByName` 测试以使用新参数签名。

### 测试用例

#### `skipFilter.ts` / `checkIsSkipItemOrNotByName` 测试

替换现有签名相关的测试，覆盖新的五开关路由逻辑：

| # | 描述 | 输入 key | 开关状态 | 期望结果 |
|---|------|---------|---------|---------|
| 1 | 黑名单文件始终跳过 | `.obsidian/workspace.json` | 全部开启 | finalIsIgnored=true |
| 2 | 黑名单文件始终跳过 | `.obsidian/workspace-mobile.json` | 全部开启 | finalIsIgnored=true |
| 3 | 黑名单文件始终跳过 | `.obsidian/workspaces.json` | 全部开启 | finalIsIgnored=true |
| 4 | 黑名单文件始终跳过 | `.obsidian/core-plugins-migration.json` | 全部开启 | finalIsIgnored=true |
| 5 | 本插件 data.json 始终跳过 | `.obsidian/plugins/remotely-save-onedrive/data.json` | syncSelfPlugin=true | finalIsIgnored=true |
| 6 | 本插件 main.js 同步 | `.obsidian/plugins/remotely-save-onedrive/main.js` | syncSelfPlugin=true | finalIsIgnored=false |
| 7 | 本插件 main.js 不同步 | `.obsidian/plugins/remotely-save-onedrive/main.js` | syncSelfPlugin=false | finalIsIgnored=true |
| 8 | 本插件 styles.css 同步 | `.obsidian/plugins/remotely-save-onedrive/styles.css` | syncSelfPlugin=true | finalIsIgnored=false |
| 9 | 本插件 synced_settings.json 同步 | `.obsidian/plugins/remotely-save-onedrive/synced_settings.json` | syncSelfPlugin=true | finalIsIgnored=false |
| 10 | 本插件 .gitignore 同步 | `.obsidian/plugins/remotely-save-onedrive/.gitignore` | syncSelfPlugin=true | finalIsIgnored=false |
| 11 | 其他插件 main.js 同步 | `.obsidian/plugins/dataview/main.js` | syncThirdPartyPlugins=true | finalIsIgnored=false |
| 12 | 其他插件 main.js 不同步 | `.obsidian/plugins/dataview/main.js` | syncThirdPartyPlugins=false | finalIsIgnored=true |
| 13 | 其他插件 data.json 同步 | `.obsidian/plugins/copilot/data.json` | syncThirdPartyPlugins=true | finalIsIgnored=false |
| 14 | 其他插件 manifest.json 同步 | `.obsidian/plugins/dataview/manifest.json` | syncThirdPartyPlugins=true | finalIsIgnored=false |
| 15 | 核心配置同步 | `.obsidian/app.json` | syncObsidianConfig=true | finalIsIgnored=false |
| 16 | 核心配置不同步 | `.obsidian/app.json` | syncObsidianConfig=false | finalIsIgnored=true |
| 17 | 核心配置同步 | `.obsidian/core-plugins.json` | syncObsidianConfig=true | finalIsIgnored=false |
| 18 | community-plugins.json 同步 | `.obsidian/community-plugins.json` | syncObsidianConfig=true | finalIsIgnored=false |
| 19 | snippets 同步 | `.obsidian/snippets/h1.css` | syncObsidianConfig=true | finalIsIgnored=false |
| 20 | snippets 不同步 | `.obsidian/snippets/h1.css` | syncObsidianConfig=false | finalIsIgnored=true |
| 21 | themes 同步 | `.obsidian/themes/PLN/theme.css` | syncObsidianConfig=true | finalIsIgnored=false |
| 22 | icons 同步 | `.obsidian/icons/tabl-icons/CodeCircle.svg` | syncObsidianConfig=true | finalIsIgnored=false |
| 23 | appearance.json 独立控制 | `.obsidian/appearance.json` | syncObsidianConfig=true, syncAppearance=false | finalIsIgnored=true |
| 24 | appearance.json 独立控制 | `.obsidian/appearance.json` | syncObsidianConfig=false, syncAppearance=true | finalIsIgnored=false |
| 25 | bookmarks.json 独立控制 | `.obsidian/bookmarks.json` | syncObsidianConfig=true, syncBookmarks=false | finalIsIgnored=true |
| 26 | bookmarks.json 独立控制 | `.obsidian/bookmarks.json` | syncObsidianConfig=false, syncBookmarks=true | finalIsIgnored=false |
| 27 | .obsidian 目录本身 | `.obsidian/` | 任一开关开启 | finalIsIgnored=false |
| 28 | .obsidian 目录本身 | `.obsidian/` | 全部关闭 | finalIsIgnored=true |
| 29 | 非配置文件不受影响 | `notes/test.md` | 全部关闭 | finalIsIgnored=false（现有逻辑） |
| 30 | 本插件未知文件跳过 | `.obsidian/plugins/remotely-save-onedrive/unknown.txt` | syncSelfPlugin=true | finalIsIgnored=true |
| 31 | 开关独立性验证 | `.obsidian/plugins/dataview/main.js` | syncSelfPlugin=true, syncThirdPartyPlugins=false, syncObsidianConfig=true | finalIsIgnored=true（三方插件开关关闭） |
| 32 | 开关独立性验证 | `.obsidian/app.json` | syncSelfPlugin=true, syncThirdPartyPlugins=true, syncObsidianConfig=false | finalIsIgnored=true（Obsidian配置开关关闭） |

#### `obsFolderLister.ts` 测试

Mock Obsidian `Vault` 的文件列举，验证 BFS 逻辑正确路由：

| # | 描述 | mock 目录结构 | 开关状态 | 期望列举的文件 |
|---|------|--------------|---------|--------------|
| 33 | 仅本插件同步 | `.obsidian/plugins/remotely-save-onedrive/{main.js, manifest.json, data.json}` | syncSelfPlugin=true, 其他=false | 仅 `main.js`, `manifest.json`（不含 `data.json`） |
| 34 | 仅三方插件同步 | `.obsidian/plugins/dataview/{main.js, data.json}` | syncThirdPartyPlugins=true, 其他=false | `main.js`, `data.json` |
| 35 | 仅核心配置同步 | `.obsidian/{app.json, workspace.json, appearance.json, bookmarks.json}` | syncObsidianConfig=true, syncAppearance=false, syncBookmarks=false | 仅 `app.json`（排除 workspace, appearance, bookmarks） |
| 36 | 核心配置 + 外观 | 同上 | syncObsidianConfig=true, syncAppearance=true | `app.json`, `appearance.json` |
| 37 | 全部关闭 | 同上 | 全部=false | 空列表 |
| 38 | 黑名单 workspace-mobile | `.obsidian/{workspace-mobile.json, workspaces.json, app.json}` | syncObsidianConfig=true | 仅 `app.json` |
| 39 | snippets + themes | `.obsidian/{snippets/h1.css, themes/PLN/theme.css}` | syncObsidianConfig=true | `snippets/h1.css`, `themes/PLN/theme.css` |
| 40 | 本插件子目录过滤 | `.obsidian/plugins/remotely-save-onedrive/{main.js, styles.css, unknown.txt, data.json}` | syncSelfPlugin=true | 仅 `main.js`, `styles.css` |

#### 向后兼容迁移测试

| # | 描述 | 输入设置 | 期望结果 |
|---|------|---------|---------|
| 41 | 旧 syncConfigDir=true 迁移 | `{syncConfigDir: true}` | syncObsidianConfig=true, syncThirdPartyPlugins=true, syncSelfPlugin=true, syncConfigDir=false |
| 42 | 旧 syncConfigDir=false 迁移 | `{syncConfigDir: false}` | syncObsidianConfig=true（新默认）, syncThirdPartyPlugins=true, syncSelfPlugin=true |
| 43 | 新设置已存在不迁移 | `{syncObsidianConfig: false, syncThirdPartyPlugins: false, syncSelfPlugin: false}` | 保持原值不变 |
| 44 | 缺失新设置使用默认值 | `{}` | syncObsidianConfig=true, syncThirdPartyPlugins=true, syncSelfPlugin=true |

### 风险缓解

- **带宽**：新默认值首次同步会将 `.obsidian` 文件上传到 OneDrive。大型插件 `main.js`（可达 10MB）和主题（可达 4MB）将被上传。通过现有的 `skipSizeLargerThan` 设置缓解，该设置适用于所有同步文件。
- **data.json 冲突**：其他插件的 `data.json` 文件将被同步。若插件在 `data.json` 中存储设备特定路径或令牌，可能导致问题。缓解措施：(a) 用户可关闭 `syncThirdPartyPlugins`，(b) 用户可将特定路径添加到 `ignorePaths`。
- **自举**：插件同步自身的 `main.js` 时是安全的，因为同步在文件级别操作（将当前 `main.js` 上传到 OneDrive）。插件仅在 Obsidian 重启后重新加载，同步过程中不重载。
