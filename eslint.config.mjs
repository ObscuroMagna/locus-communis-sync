// The official Obsidian ruleset — the same checks the directory's automated
// review runs per version. Keep this green before every release.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "*.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // The product name keeps its casing; the token placeholder is a
      // literal format, not prose.
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Locus Communis", "Obsidian"],
        ignoreRegex: ["^lcs_live_"],
      }],
    },
  }
);
