import { dirname, resolve } from "node:path";

const INSTRUMENTATION_IMPORT = /(?:^|[/\\])devtools[/\\]instrumentation(?:\.ts|\.js)?$/;
const DEV_PAGE_PLUGIN_IMPORT = /(?:^|[/\\])server[/\\]dev-page-plugin(?:\.ts|\.js)?$/;
const DEV_RUNTIME_IMPORT =
  /(?:^|[/\\])server[/\\]dev[/\\](?:browser-events|diagnostics|plugin)(?:\.ts|\.js)?$/;
const HMR_IMPORT = /(?:^|[/\\])server[/\\]router[/\\]hmr(?:\.ts|\.js)?$/;
const PRODUCTION_BOUNDARY_IMPORT =
  /(?:browser-events|instrumentation|dev-page-plugin|diagnostics|plugin|hmr)(?:\.ts|\.js)?$/;

export function productionInstrumentationPlugin(): Bun.BunPlugin {
  return {
    name: "furin-production-instrumentation",
    setup(build) {
      build.onResolve({ filter: PRODUCTION_BOUNDARY_IMPORT }, (args) => {
        const importPath = resolve(dirname(args.importer), args.path);
        if (INSTRUMENTATION_IMPORT.test(importPath)) {
          return {
            path: resolve(import.meta.dir, "../server/devtools/instrumentation.production.ts"),
          };
        }
        if (DEV_PAGE_PLUGIN_IMPORT.test(importPath)) {
          return { path: resolve(import.meta.dir, "../server/dev-page-plugin.production.ts") };
        }
        if (DEV_RUNTIME_IMPORT.test(importPath)) {
          return { path: resolve(import.meta.dir, "../server/dev/runtime.production.ts") };
        }
        if (HMR_IMPORT.test(importPath)) {
          return { path: resolve(import.meta.dir, "../server/router/hmr.production.ts") };
        }
      });
    },
  };
}
