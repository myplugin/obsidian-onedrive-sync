# Documentation

This plugin syncs your Obsidian vault to Microsoft OneDrive via the Graph App Folder API.

## Topics

| Section | Description |
|---------|-------------|
| [Remote Services: OneDrive](./remote_services/onedrive/README.md) | Setup, OAuth, FAQ |
| [Sync Algorithm](./sync_algorithm/README.md) | v1→v3 evolution, design docs |
| [Architecture](./architecture/README.md) | Code design rules, minimal intrusive design |
| [Browser Environment](./browser_env/README.md) | CORS, no-Node.js, OAuth PKCE, background limitations |
| [Encryption](./encryption/README.md) | RClone Crypt vs OpenSSL enc |
| [User Guides](./guides/README.md) | QR code settings transfer, Linux URI setup |
| [How To Debug](./how_to_debug/README.md) | Console output, vConsole, sync plan export, Logstravaganza |
| [Check Performance](./check_performance/README.md) | Profiler usage and export |

## Quick Links

- New to the plugin? Start with [OneDrive setup](./remote_services/onedrive/README.md)
- Want encryption? See [Encryption comparison](./encryption/comparation.md)
- Sync not working? See [How to debug](./how_to_debug/README.md)
- Contributing code? Read [Code Design](./architecture/code_design.md) and [AGENTS.md](../AGENTS.md)
