# OneDrive Vault Sync

English | [中文](./README.zh-cn.md)

An unofficial community sync plugin for Obsidian that syncs your vault to Microsoft OneDrive.

## Origin

OneDrive Sync started from the [remotely-save](https://github.com/remotely-save/remotely-save) v0.5.25 codebase, but has since been substantially rewritten. The original multi-cloud architecture was stripped down to OneDrive only, and the sync core and OneDrive integration were reworked around a **self-owned app registration** and the Graph App Folder API.

It is **not** the official [Obsidian Sync](https://obsidian.md/sync) service, and not a Microsoft / OneDrive product — it only talks to OneDrive through Microsoft's public Graph API.

## Core Features

- **Vault ↔ OneDrive sync.** Bidirectional sync between your local Obsidian vault and your OneDrive `/Apps/obsidian-onedrive-sync` App Folder.
- **Cross-device.** Syncs across mobile and desktop — OneDrive acts as the broker between devices.
- **Sync algorithm v3.** Move/rename detection with dedup, plus 3-way-merge conflict detection and handling.
- **End-to-end encryption (optional).** Set a password and files are encrypted (openssl / rclone crypt format) before upload.
- **Auto sync.** Scheduled sync every N minutes, plus sync-on-save.
- **Selective sync.** Skip large files and skip paths by custom regex.

## Use Cases

- **Multi-device sync.** Keep one vault in sync across your phone, tablet, and multiple desktops, using your existing OneDrive account as the broker.
- **Free alternative to Obsidian Sync.** Runs on the OneDrive personal free tier instead of a paid sync subscription.
- **Privacy-sensitive vaults.** Optional end-to-end encryption keeps file contents opaque to the cloud, even if you don't fully trust the storage.

## License

This plugin uses a split license — see [`LICENSE`](./LICENSE) for the full statement:

- Most of the codebase (`src/`, `tests/`, `docs/`, `assets/`) is **Apache License 2.0** (open source).
- The sync-core files (`src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts`) are **PolyForm Strict License 1.0.0** (source-available: personal and noncommercial use is permitted; redistribution of these files is restricted).

The plugin is free to use. The source-available PolyForm license on the sync core does not affect personal use of the plugin.
