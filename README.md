# OneDrive Vault Sync

English | [中文](./README.zh-cn.md)

An unofficial community sync plugin for Obsidian that syncs your vault to Microsoft OneDrive.

## Origin

OneDrive Vault Sync is forked from [remotely-save](https://github.com/remotely-save/remotely-save) v0.5.25 and adapted to OneDrive only. The original multi-cloud architecture was stripped down to OneDrive, and the OneDrive integration was reworked around a **self-owned app registration** and the Graph App Folder API. The sync-core files (`sync.ts`, `conflictLogic.ts`, `clearDupFiles.ts`, `settingsClearDupFiles.ts`) retain upstream code under the **same PolyForm Strict License 1.0.0** as the source project; only `fileContentHistory.ts` is new to this fork.

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

## Installation

You can install the plugin in any of the following ways. It requires Obsidian 0.13.21 or later and runs on both desktop and mobile.

- **Obsidian Community Directory.** Once published, search for "OneDrive Vault Sync" in Settings → Community plugins → Browse and install it.
- **Manual.** Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/onedrive-vault-sync/`, then enable the plugin in Settings → Community plugins.

## Configuration

No Azure app registration is needed — the OAuth client ID is built into the plugin. On first run, click **Connect to OneDrive** and sign in with your personal Microsoft account.

- **Same vault name on every device.** The OneDrive App Folder is named after your vault, so all devices syncing the same vault must use the same vault name.
- **(Optional) Encryption.** Set an encryption password under Advanced before your first sync to enable end-to-end encryption.
- **First and later syncs.** The first sync scans both local and remote files and reconciles them; later syncs are incremental (delta).

## Privacy

There is no telemetry, no analytics, no crash reporting, and no third parties. All network traffic goes only to Microsoft (`login.microsoftonline.com`, `graph.microsoft.com`, and Microsoft content hosts). The plugin reads your vault's file names and contents (encrypted if you set a password) and syncs them to your own OneDrive App Folder, and reads your Microsoft account name / email for authentication. OAuth tokens and the encryption password are stored locally in IndexedDB and never uploaded; the settings file (`data.json`) strips auth tokens and the password. See [`docs/remote_services/onedrive/README.md`](./docs/remote_services/onedrive/README.md) for the full privacy note.

## Limitations

- **OneDrive personal accounts only.** Business / Enterprise (SharePoint) accounts are not supported.
- **Sync only while Obsidian is open.** There is no background sync after Obsidian is closed.
- **Large-file and path skipping.** You can skip large files and exclude paths by custom regex.
- **Shared vault name required.** A vault synced by multiple devices must use the same vault name on all of them.

## Documentation

- [`docs/README.md`](./docs/README.md) — documentation overview.
- [`docs/remote_services/onedrive/README.md`](./docs/remote_services/onedrive/README.md) — OneDrive setup notes and privacy note.
- [`docs/sync_algorithm/v3/intro.md`](./docs/sync_algorithm/v3/intro.md) — sync algorithm v3.
- [`docs/how_to_debug/README.md`](./docs/how_to_debug/README.md) — debugging guide.

## License

This plugin uses a split license — see [`LICENSE`](./LICENSE) for the full statement:

- Most of the codebase (`src/`, `tests/`, `docs/`) is **Apache License 2.0** (open source).
- The sync-core files (`src/sync.ts`, `src/conflictLogic.ts`, `src/fileContentHistory.ts`, `src/clearDupFiles.ts`, `src/settingsClearDupFiles.ts`) are **PolyForm Strict License 1.0.0** (source-available: personal and noncommercial use is permitted; redistribution of these files is restricted).

The plugin is free to use. The source-available PolyForm license on the sync core does not affect personal use of the plugin.
