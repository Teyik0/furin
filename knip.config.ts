import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      // @biomejs/biome is used via biome.jsonc but not directly imported in JS/TS
      // @commitlint/cli is the CLI runner; commitlint plugin detects config-conventional
      // react-doctor is a standalone CLI tool, not imported
      ignoreDependencies: ["@biomejs/biome", "@commitlint/cli", "react-doctor"],
    },
    "packages/core": {
      // bin field points to ./dist/cli/index.js (no "bun" condition), so src/cli/index.ts
      // is not auto-detected — must be declared explicitly
      entry: ["src/cli/index.ts"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/docs": {
      // Furin uses file-based routing: all files in pages/ are entry points
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}"],
      // Tailwind v4 plugins loaded via CSS @import/@plugin directives, not JS imports
      ignoreDependencies: ["tailwindcss", "tw-animate-css", "@tailwindcss/typography"],
    },
    "apps/scaffolder": {
      // templates/ contains EJS files referencing deps of generated projects, not the scaffolder itself
      ignore: ["templates/**"],
    },
    "examples/task-manager": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
    },
    "examples/weather": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
    },
  },
  // tsconfig.base.json "types": ["react"] creates a phantom unresolved import at root level
  ignoreUnresolved: ["^react$"],
  ignoreExportsUsedInFile: true,
};

export default config;
