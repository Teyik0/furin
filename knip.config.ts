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
        // Run by hyperfine in ci.yaml, where knip cannot see the reference.
        "scripts/probe-server-startup.ts",
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
      project: ["src/**/*.{ts,tsx,css}"],
    },
    "examples/weather": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx,css}"],
    },
    "packages/core": {
      entry: [
        // Referenced by generated hydration entries and Bun codec aliases.
        "src/rsc/client-references.ts",
        // Adapter runtime modules, bundled as server entries by the build.
        "src/adapter/bun/server.ts",
        "src/adapter/vercel/bootstrap.ts",
        "src/adapter/vercel/handler.ts",
        // Spawned by the build to evaluate the server entry.
        "src/build/discover-mounts-process.ts",
        "src/rsc/bundled-client-codec.ts",
        // Re-exported by the generated static-export bundle entry.
        "src/server/static-export.ts",
        "src/server/sync/postgres/migrate.ts",
        "tests/**/*.{ts,tsx}",
        "tests/fixtures/sync-prisma/schema.prisma",
      ],
      ignore: [
        "src/server/dev-page-plugin.production.ts",
        "src/server/dev/runtime.production.ts",
        "src/server/devtools/instrumentation.production.ts",
      ],
      ignoreIssues: {
        // discovery.ts loads this export through a runtime-computed module URL.
        "src/build/request-keys.ts": ["exports"],
        // Subprocess test scripts import dev-loader helpers from this barrel as strings.
        "src/server/cache/index.ts": ["exports"],
      },
      project: ["src/**/*.{ts,tsx}", "tests/fixtures/**/*.prisma"],
    },
  },
};

export default config;
