# OneDrive (App Folder)

- **This plugin is NOT an official Microsoft / OneDrive product.** The plugin just uses Microsoft's [OneDrive's public API](https://docs.microsoft.com/en-us/onedrive/developer/rest-api).
- After the authorization, the plugin can read your name and email, and read and write files in your OneDrive's `/Apps/obsidian-onedrive-sync` folder.
- If you decide to authorize this plugin to connect to OneDrive, please go to plugin's settings, and choose OneDrive then follow the instructions.
- Password-based end-to-end encryption is also supported. But please be aware that **the vault name itself is not encrypted**.
- If you want to sync the files across multiple devices, **your vault name should be the same** while using default settings.

## FAQ

### How about OneDrive for Business?

This plugin only works with **personal** Microsoft accounts (OneDrive for home) — not OneDrive for Business / work or school accounts (incl. Microsoft 365 Education). It syncs via the OneDrive **App Folder** (`Files.ReadWrite.AppFolder`), a scope Microsoft only supports for personal accounts; Business has no app-sandbox equivalent, and supporting it would require granting write access to your entire OneDrive (`Files.ReadWrite`) — a broader permission we deliberately avoid. Please use a personal Microsoft account.

### I cannot find `/Apps/obsidian-onedrive-sync` folder

Mystically some users report that their OneDrive generate `/Application/Graph` instead of `/Apps/obsidian-onedrive-sync`. See [#517](https://github.com/remotely-save/remotely-save/issues/517).

The solution is simple:

1. Backup your vault manually.
2. Go to onedrive website (<https://onedrive.live.com/>), and rename `/Application/Graph` to `/Application/obsidian-onedrive-sync` (right click on the folder and you will see rename option)
3. Come back to Obsidian and try to sync!

### Empty file is not uploaded

Onedrive's API does not allow uploading empty files. You can choose to skip them or raise errors in OneDrive Sync plugin's settings.

## Related

- [OneDrive Concurrency Mechanisms](./concurrency.md) — etag/cTag, If-Match, conflictBehavior, delta, versions
- [Browser Environment: OAuth PKCE](../../browser_env/oauth2_pkce.md) — why the OAuth flow requires PKCE
- [Browser Environment: CORS](../../browser_env/cors.md) — cross-origin request limitations
- [Encryption](../../encryption/README.md) — password-based end-to-end encryption
