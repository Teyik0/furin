import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  workspaces: {
    ".": {
      // doctor.config.ts is consumed by the react-doctor CLI (not imported by
      // app code); list it as an entry so its `react-doctor/api` type import
      // also marks the dependency as used.
      entry: [
        "doctor.config.ts",
        "scripts/compare-vercel-framework-reports.ts",
        "scripts/startup-weather-preload.ts",
      ],
    },
    "apps/docs": {
      // Furin uses file-based routing: all files in pages/ are entry points
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx,css,mdx}"],
    },
    "apps/scaffolder": {
      // templates/ contains EJS files referencing deps of generated projects, not the scaffolder itself
      ignore: ["templates/**"],
    },
    "examples/task-manager": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      ignoreIssues: {
        "src/api/modules/boards/service.ts": ["exports", "types"],
      },
      project: ["src/**/*.{ts,tsx,css}"],
    },
    "examples/weather": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx,css}"],
    },
    "packages/core": {
      entry: [
        "src/devtools/collector.ts",
        "src/devtools/dashboard.tsx",
        "src/server/sync/postgres/migrate.ts",
        "tests/**/*.{ts,tsx}",
        "tests/fixtures/sync-prisma/schema.prisma",
      ],
      ignore: [
        "src/server/dev-page-plugin.production.ts",
        "src/server/dev/runtime.production.ts",
        "src/server/devtools/instrumentation.production.ts",
        "src/server/router/hmr.production.ts",
      ],
      ignoreIssues: {
        // discovery.ts loads this export through a runtime-computed module URL.
        "src/build/request-keys.ts": ["exports"],
        "src/server/auto-invalidate/index.ts": ["exports"],
        "src/server/cache/index.ts": ["exports", "types"],
        "src/server/devtools/hub.ts": ["exports"],
        "src/server/render/index.ts": ["exports", "types"],
        "src/server/render/ssr.ts": ["types"],
        "src/server/sync/config.ts": ["exports"],
      },
      project: ["src/**/*.{ts,tsx}", "tests/fixtures/**/*.prisma"],
    },
  },
};

export default config;
