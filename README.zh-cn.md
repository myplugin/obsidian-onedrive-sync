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

## 许可证

本插件采用混合许可证——完整声明见 [`LICENSE`](./LICENSE)：

- 代码库的绝大部分（`src/`、`tests/`、`docs/`、`assets/`）为 **Apache License 2.0**（开源）。
- 同步核心文件（`src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts`）为 **PolyForm Strict License 1.0.0**（source-available：允许个人与非商业用途，对这些文件的重分发有限制）。

插件本身可免费使用。同步核心的 source-available 许可证不影响插件的个人使用。
