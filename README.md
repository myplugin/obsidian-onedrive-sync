# Remotely Save (OneDrive)

English | [中文](./README.zh-cn.md)

This is yet another unofficial sync plugin for Obsidian. If you like it or find it useful, please consider give it a star on Github.

## Disclaimer

- **This is NOT the [official sync service](https://obsidian.md/sync) provided by Obsidian.**

## !!!Caution!!!

**ALWAYS, ALWAYS, backup your vault before using this plugin.**

## Features

- Supports:
  - OneDrive for personal (App Folder)
- **Obsidian Mobile supported.** Vaults can be synced across mobile and desktop devices with the cloud service as the "broker".
- **[End-to-end encryption](./docs/encryption/README.md) supported.** Files would be encrypted using openssl / rclone crypt format before being sent to the cloud **if** user specify a password.
- **Scheduled auto sync supported.** You can also manually trigger the sync using sidebar ribbon, or using the command from the command palette (or even bind the hot key combination to the command then press the hot key combination).
- **[Minimal Intrusive](./docs/minimal_intrusive_design.md).**
- **Skip Large files** and **skip paths** by custom regex conditions!
- **[Sync Algorithm](./docs/sync_algorithm/v3/intro.md) is provided for discussion.**
- **[Basic Conflict Detection And Handling](./docs/sync_algorithm/v3/intro.md)**.
- Source Available. See [License](./LICENSE) for details.

## Limitations

- **Cloud services cost you money.** Always be aware of the costs and pricing. Specifically, all the operations, including but not limited to downloading, uploading, listing all files, calling any api, storage sizes, may or may not cost you money.
- **Some limitations from the browser environment.** More technical details are [in the doc](./docs/browser_env.md).
- **You should protect your `data.json` file.** The file contains sensitive information.
  - It's strongly advised **NOT** to share your `data.json` file to anyone.
  - It's usually **NOT** a good idea to check the file into version control. By default, the plugin tries to create a `.gitignore` file inside the plugin directory if it doesn't exist, for ignoring `data.json` in the `git` version control. If you know exactly what it means and want to remove the setting, please modify the `.gitignore` file or set it to be empty.
- **Obsidian API on Mobile has performance issues syncing large files (>= 50 MB).**
  - Setting the "Skip Large Files" option can help resolve issues related to syncing large files.

## Questions, Suggestions, Or Bugs

You are greatly welcome to ask questions, post any suggestions, or report any bugs!

Additionally, the plugin author may occasionally visit Obsidian official forum and official Discord server, and pay attention to this-plugin-related information there.

## Usage

### OneDrive for personal (App Folder)

- **This plugin is NOT an official Microsoft / OneDrive product.** The plugin just uses Microsoft's [OneDrive's public API](https://docs.microsoft.com/en-us/onedrive/developer/rest-api).
- This plugin only works for "OneDrive for personal", and not works for "OneDrive for Business" (yet). See #11 to further details.
- After the authorization, the plugin can read your name and email, and read and write files in your OneDrive's `/Apps/remotely-save` folder. 
- If you decide to authorize this plugin to connect to OneDrive, please go to plugin's settings, and choose OneDrive then follow the instructions.
- Password-based end-to-end encryption is also supported. But please be aware that **the vault name itself is not encrypted**.
- If you want to sync the files across multiple devices, **your vault name should be the same** while using default settings.
- You might also want to checkout [faq for OneDrive](./docs/remote_services/onedrive/README.md).

## Scheduled Auto Sync

- You can configure auto syncing every N minutes in settings.
- In auto sync mode, if any error occurs, the plugin would **fail silently**.
- Auto sync only works when Obsidian is being opened. It's **technically impossible** to auto sync while Obsidian is in background, because the plugin just works in the browser environment provided by Obsidian.

## Sync On Save

- You can configure sync on save in settings.
- In sync on save mode, if any error occurs, the plugin would **fail silently**.

## Config Folder / Files and Bookmarks

By default, the plugin doesn't sync config folder / files of obsidian (normally `.obsidian` folder) because it's one of the hidden files. 

However, in the latest version, you can enable syncing config folder in settings. Please be aware that it's an experimental feature. Notably some config files' modified times are changed everytime when Obsidian is opened, and this destroys the assumptions of the plugin, so some information may not be synced properly.

Moreover, the bookmarks of Obsidian are actually stored in `.obsidian/bookmarks.json` file. You can also set syncing this file (instead of the whole config folder) in settings. The plugin will keep the latest modified one across devices.

## Hidden Files Or Folders

**By default, all files or folder starting with `.` (dot) or `_` (underscore) are treated as hidden files, and would NOT be synced.** It's useful if you have some files just staying locally. But this strategy also means that themes / other plugins / settings of this plugin would neither be synced.

In the latest version, you can change the settings to allow syncing `_` files or folders, as well as `.obsidian` special config folder as described above (but not any other `.` files or folders).

## How To Debug

If you see any errors, please check the doc [here](./docs/how_to_debug/README.md) for more details.

Moreover, sometimes the program runs but slowly, you want to check the performance by [enabling the profiler](./docs/check_performance/README.md).

## Bonus: Import And Export Not-Oauth2 Plugin Settings By QR Code

See [here](./docs/import_export_some_settings.md) for more details.

