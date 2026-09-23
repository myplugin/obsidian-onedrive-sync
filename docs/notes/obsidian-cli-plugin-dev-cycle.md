# Obsidian CLI — plugin dev cycle

Project-independent knowledge — the `obsidian` CLI commands for developing/testing Obsidian plugins. Requires Obsidian to be open. Docs: https://help.obsidian.md/cli

## Syntax basics

- Parameters take a value with `=`: `obsidian create name="My Note"`.
- Flags are boolean switches, no value: `silent`, `overwrite`.
- Vault targeting: prefix `vault="Name"` to target a specific vault (default = most recently focused).
- `--copy` on any command copies output to clipboard.

## Plugin develop/test loop

After editing a plugin's code and (re)building/deploying it:

1. **Reload** the plugin to pick up changes:
   `obsidian plugin:reload id=my-plugin`
2. **Check for errors** (fix + repeat from 1 if any):
   `obsidian dev:errors`
3. **Verify visually** — screenshot or DOM inspection:
   `obsidian dev:screenshot path=screenshot.png`
   `obsidian dev:dom selector=".workspace-leaf" text`
4. **Check console** for warnings/unexpected logs:
   `obsidian dev:console level=error`

## Other dev commands

- `obsidian eval code="app.vault.getFiles().length"` — run JS in the app context.
- `obsidian dev:css selector="..." prop=background-color` — read computed styles.
- `obsidian dev:mobile on` — toggle mobile emulation.

Run `obsidian help` for the full, always-current list.
