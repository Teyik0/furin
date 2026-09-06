import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  workspaces: {
    ".": {
      // doctor.config.ts is consumed by the react-doctor CLI (not imported by
      // app code); list it as an entry so its `react-doctor/api` type import
      // also marks the dependency as used.
      entry: ["doctor.config.ts"],
      // @biomejs/biome is used via biome.jsonc but not directly imported in JS/TS
      // @commitlint/cli is the CLI runner; commitlint plugin detects config-conventional
      ignoreDependencies: ["@biomejs/biome", "@commitlint/cli", "@happy-dom/global-registrator"],
    },
    "apps/docs": {
      // Furin uses file-based routing: all files in pages/ are entry points
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      // Tailwind v4 plugins loaded via CSS @import/@plugin directives, not JS imports
      ignoreDependencies: ["tailwindcss", "tw-animate-css", "@tailwindcss/typography"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/scaffolder": {
      // templates/ contains EJS files referencing deps of generated projects, not the scaffolder itself
      ignore: ["templates/**"],
    },
    "examples/task-manager": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
      ignoreIssues: {
        "src/api/modules/boards/service.ts": ["exports", "types"],
      },
      project: ["src/**/*.{ts,tsx}"],
    },
    "examples/weather": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/core": {
      entry: ["src/server/sync/postgres/migrate.ts", "tests/**/*.{ts,tsx}"],
      ignore: [
        "src/server/cache/dev-loader.ts",
        "src/server/devtools/instrumentation.production.ts",
        "src/server/internal.ts",
        "src/server/render/template.ts",
        "src/server/sync/stream.ts",
      ],
      ignoreDependencies: ["expect-type"],
      ignoreIssues: {
        "src/server/auto-invalidate/index.ts": ["exports"],
        "src/server/cache/index.ts": ["exports", "types"],
        "src/server/devtools/hub.ts": ["exports"],
        "src/server/render/index.ts": ["exports", "types"],
        "src/server/render/ssr.ts": ["types"],
        "src/server/sync/config.ts": ["exports"],
      },
      project: ["src/**/*.{ts,tsx}"],
    },
  },
};

export default config;
