# Obsidian CLI `plugin:reload` + Node spawnSync on Windows

Project-independent reference knowledge, gathered 2026-09-22.

## Obsidian CLI basics

Obsidian 1.x ships a CLI. On Windows, `where obsidian` resolves to `Obsidian.com` (CLI shim) and `Obsidian.exe` (the GUI app). Windows PATHEXT lists `.COM` before `.EXE`, so bare `obsidian` invokes the CLI shim, not the app.

- `obsidian version` → prints `1.13.7 (installer 1.13.7)`. Note: the CLI uses **subcommands** (`version`), NOT flags (`--version` → `Error: Command "--version" not found. Did you mean: version?`).
- `obsidian plugin:reload id=<plugin-id>` → reloads a plugin in the running Obsidian. On success prints `Reloaded: <plugin-id>` to stdout. This exact string is the honest success signal — a bare exit-0 is NOT enough (the app can launch and exit 0 without reloading; see Node `shell:true` caveat below).
- The CLI connects to the **running** Obsidian instance via IPC. If Obsidian isn't running, the CLI can't reload.

## Plugin enable state is per-vault

Obsidian stores enabled community plugins per-vault in `<vault>/.obsidian/community-plugins.json` (a JSON array of plugin ids). `plugin:reload` will **refuse** a disabled plugin with `Error: Plugin "<id>" is not enabled.` — and this is per-vault. If you develop across multiple vaults, enabling a plugin in vault A does NOT enable it in vault B. The CLI reloads against whichever vault Obsidian has focused / the CLI resolves to.

This is the classic trap: deploy to vault B's `VAULT_PATH`, but you enabled the plugin in vault A → `plugin:reload` reports "not enabled" even though the CLI is on PATH and Obsidian is running.

## Node `spawnSync` invoking the CLI on Windows

Three equivalent ways to call the CLI from Node, all behave identically here:

```js
spawnSync("obsidian", ["plugin:reload", `id=${id}`], { shell: false, ... });  // preferred
spawnSync("obsidian", ["plugin:reload", `id=${id}`], { shell: true,  ... });
spawnSync("Obsidian.com", ["plugin:reload", `id=${id}`], { shell: false, ... });
```

- **`shell: false` is correct and safe.** Node resolves `obsidian` through PATHEXT itself (picks `.com`). Args pass cleanly.
- **`shell: true` is a trap** (Node DEP0190): args are concatenated, not escaped — previously caused a FALSE success (the app launched and exited 0 without reloading). Use `shell: false`.
- **stdio: `["ignore", "pipe", "pipe"]`** to capture stdout/stderr. The CLI writes its result (`Reloaded: <id>` OR `Error: ...`) to **stdout**, not stderr. If you only check `exit code === 0` you miss real failures — always check stdout content.

## Common failure: the build tool swallows the CLI's real error

A frequent pattern (esbuild `onEnd` → `reloadPlugin`) checks `stdout.includes("Reloaded: <id>")` and on miss prints a generic warning like "reload skipped — did not confirm". **This swallows the CLI's real stdout** (e.g. `Error: Plugin "..." is not enabled.`), making diagnosis impossible without a manual `spawnSync` repro. When wiring auto-reload, **always echo `res.stdout` / `res.stderr` on failure** so the real reason (not enabled / not running / wrong vault) surfaces immediately.

## Key takeaway

Auto-reload via the Obsidian CLI works when three things align: CLI on PATH (`obsidian` → `.com` shim), Obsidian running, and the plugin **enabled in the vault the CLI resolves to**. A "did not confirm" failure is almost always one of: Obsidian not running, plugin disabled in that vault, or the build tool swallowed the CLI's real error message. Capture and surface `stdout` first.
