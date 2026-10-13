# OneDrive Vault Sync

[English](./README.md) | 中文

一个非官方的 Obsidian 社区同步插件，把你的 vault 同步到 Microsoft OneDrive。

## 来源

OneDrive Sync 以 [remotely-save](https://github.com/remotely-save/remotely-save) v0.5.25 代码库为起点，但此后已大幅重构。原有的多云盘架构被裁剪为仅保留 OneDrive，同步核心与 OneDrive 集成围绕**自有的 App 注册**和 Graph App Folder API 重新实现。

它**不是** [Obsidian Sync](https://obsidian.md/sync) 官方同步服务，也不是微软 / OneDrive 官方产品——仅通过微软公开的 Graph API 访问 OneDrive。

## 核心功能

- **vault ↔ OneDrive 同步。** 本地 Obsidian vault 与 OneDrive `/Apps/obsidian-onedrive-sync` 应用文件夹之间的双向同步。
- **跨设备。** 移动端与桌面端均可同步——OneDrive 作为设备间的“中介”。
- **同步算法 v3。** 识别移动/重命名并去重，支持三方合并的冲突检测与处理。
- **端到端加密（可选）。** 设置密码后，文件在上传前以 openssl / rclone crypt 格式加密。
- **自动同步。** 可配置每 N 分钟定时同步，以及保存时同步。
- **选择性同步。** 按自定义正则跳过大文件、跳过指定路径。

## 使用场景

- **多设备同步。** 用你现有的 OneDrive 账户作为中介，在手机、平板和多台电脑间保持同一个 vault 同步。
- **Obsidian Sync 的免费替代。** 使用 OneDrive 个人版免费额度，无需付费订阅同步服务。
- **注重隐私的 vault。** 可选的端到端加密让文件内容对云端不可见，即使你不完全信任存储方。

## 安装

你可以通过以下任一方式安装本插件。插件要求 Obsidian 0.13.21 及以上版本，桌面端与移动端均可使用。

- **Obsidian 社区目录。** 待插件发布后，在 设置 → 第三方插件 → 浏览 中搜索 "OneDrive Vault Sync" 并安装。
- **手动安装。** 将 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/onedrive-vault-sync/`，然后在 设置 → 第三方插件 中启用。

## 配置

无需注册 Azure 应用——OAuth client ID 已内置到构建产物中。首次运行时，点击 **Connect to OneDrive**，用你的微软个人账户登录即可。

- **所有设备使用相同的 vault 名称。** OneDrive 应用文件夹以 vault 名称命名，因此同步同一个 vault 的所有设备必须使用相同的 vault 名称。
- **（可选）加密。** 首次同步前，可在 Advanced 中设置加密密码以启用端到端加密。
- **首次同步与后续同步。** 首次同步会扫描本地与远端文件并进行调和；后续同步为增量（delta）同步。

## 隐私

本插件没有遥测、没有分析、没有崩溃上报，也不涉及任何第三方。所有网络流量仅发往微软（`login.microsoftonline.com`、`graph.microsoft.com` 以及微软的内容主机）。它会读取你 vault 的文件名与内容（设置密码后为加密内容）并同步到你自己的 OneDrive 应用文件夹，并读取你的微软账户名称 / 邮箱用于认证。OAuth 令牌与加密密码存储在本地 IndexedDB 中，绝不上传；设置文件（`data.json`）会剔除认证令牌与密码。完整隐私说明见 [`docs/remote_services/onedrive/README.md`](./docs/remote_services/onedrive/README.md)。

## 局限性

- **仅支持 OneDrive 个人账户。** 不支持商业版 / 企业版（SharePoint）账户。
- **仅在 Obsidian 打开时同步。** 关闭 Obsidian 后没有后台同步。
- **可跳过大文件与路径。** 可按自定义正则跳过大文件或排除指定路径。
- **需共享 vault 名称。** 多台设备同步同一个 vault 时，必须使用相同的 vault 名称。

## 文档

- [`docs/README.md`](./docs/README.md) —— 文档总览。
- [`docs/remote_services/onedrive/README.md`](./docs/remote_services/onedrive/README.md) —— OneDrive 设置说明与隐私说明。
- [`docs/sync_algorithm/v3/intro.md`](./docs/sync_algorithm/v3/intro.md) —— 同步算法 v3。
- [`docs/how_to_debug/README.md`](./docs/how_to_debug/README.md) —— 调试指南。

## 许可证

本插件采用混合许可证——完整声明见 [`LICENSE`](./LICENSE)：

- 代码库的绝大部分（`src/`、`tests/`、`docs/`）为 **Apache License 2.0**（开源）。
- 同步核心文件（`src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts`）为 **PolyForm Strict License 1.0.0**（source-available：允许个人与非商业用途，对这些文件的重分发有限制）。

插件本身可免费使用。同步核心的 source-available 许可证不影响插件的个人使用。
