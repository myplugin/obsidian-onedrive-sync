import obsidianmd from "eslint-plugin-obsidianmd";
// ESLint config mirroring the Obsidian community-directory scanner.
// Uses obsidianmd.configs.recommended (the SAME config the scanner uses).
// All rules are ON — when eslint-plugin-obsidianmd updates with new rules,
// they're automatically picked up here + in `npm run scan` (which just runs
// `npx eslint src/ --max-warnings 0` with no --rule overrides needed).
//
// The `any`/`unsafe-*`/`assertion` rules were previously turned OFF to prevent
// `--fix` from mangling the any-heavy style during the typing cleanup. That
// cleanup is complete (0 warnings across all rules), so the rules are now ON
// permanently. Do NOT run `npx eslint --fix` blindly — the `no-explicit-any`
// fixer replaces `any` with `unknown` (behavior change). Use `npm run format`
// (Biome) for formatting; use `npm run scan` for lint checks.
//
// Usage:
//   npx eslint src/         # show warnings (same view as the scanner)
//   npm run scan            # full 6-check gate (ESLint + CSS + deps + lockfile + version + installability)
//
// Biome (npm run format) stays the formatter; ESLint here is for Obsidian-specific
// + security + TypeScript-strictness rules only.
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
  {
    // onedrive-vault-sync deliberately keeps an imperative tabbed `display()`
    // (Account/Sync/Safety/Advanced) so section switching is a single click.
    // Obsidian 1.13+'s declarative `getSettingDefinitions()` API renders
    // navigable *pages* instead — a back-then-forward multi-click flow that
    // regressed the UX after the 0.6.x warning cleanup. The declarative API
    // is runtime-mutually-exclusive with display() (a non-empty definitions
    // array bypasses display() entirely), so one-click tabs and declarative
    // settings-search cannot coexist. Scoped to settings.ts only, so the rule
    // stays ON for any future setting tabs.
    files: ["src/settings.ts"],
    rules: {
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
]);
