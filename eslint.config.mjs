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
]);
