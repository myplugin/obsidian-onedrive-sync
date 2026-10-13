// ESLint config mirroring the Obsidian community-directory scanner, but TUNED
// to this repo's conventions (AGENTS.md): `any`, non-null assertions, type
// assertions, and the derived `unsafe-*` are ACCEPTED here. The default
// `obsidianmd.configs.recommended` enables those typescript-eslint rules (and
// their --fix fixers), which mangles the any-heavy style (adds spurious
// `: unknown`, removes needed `as any`, breaks the build). They're turned OFF
// below — the directory scanner shows them as non-blocking Warnings regardless,
// and the plugin lists with them. What remains enabled: the obsidianmd/* +
// no-unsanitized/* + @microsoft/sdl/* rules (the blocking ones + real warnings).
//
// Usage:
//   npx eslint --fix src/    # auto-fix the obsidianmd auto-fixable rules only
//   npx eslint src/         # show remaining obsidianmd/security warnings
//
// Biome (npm run format) stays the formatter; ESLint here is for Obsidian-specific
// + security rules only.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      // Repo convention (AGENTS.md): any / non-null / type-assertions / unsafe-*
      // are accepted. Off so --fix doesn't touch them (and so the local run
      // reflects only the actionable obsidianmd/security rules).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unbound-method": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
]);
