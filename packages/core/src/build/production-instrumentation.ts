import { dirname, relative, resolve } from "node:path";

const INSTRUMENTATION_IMPORT = /(?:^|[/\\])devtools[/\\]instrumentation(?:\.ts|\.js)?$/;
const DEV_PAGE_PLUGIN_IMPORT = /(?:^|[/\\])server[/\\]dev-page-plugin(?:\.ts|\.js)?$/;
const DEV_RUNTIME_IMPORT =
  /(?:^|[/\\])server[/\\]dev[/\\](?:browser-events|diagnostics|graph|plugin)(?:\.ts|\.js)?$/;
const DEV_BUILD_IMPORT =
  /(?:^|[/\\])(?:build[/\\]hydrate|plugin[/\\]route-config-autofix)(?:\.ts|\.js)?$/;
const HMR_IMPORT = /(?:^|[/\\])server[/\\]router[/\\]hmr(?:\.ts|\.js)?$/;
const PRODUCTION_BOUNDARY_IMPORT =
  /(?:browser-events|instrumentation|dev-page-plugin|diagnostics|graph|plugin|hmr|hydrate|route-config-autofix)(?:\.ts|\.js)?$/;
const PRODUCTION_STUB_NAMESPACE = "furin-production-runtime-stub";
const FURIN_RUNTIME_ROOT = resolve(import.meta.dir, "..");

function isFurinRuntimePath(path: string): boolean {
  const fromRuntimeRoot = relative(FURIN_RUNTIME_ROOT, path);
  return (
    fromRuntimeRoot !== ".." &&
    !fromRuntimeRoot.startsWith("../") &&
    !fromRuntimeRoot.startsWith("..\\")
  );
}

function devBuildExport(path: string): "fixRouteConfigLayout" | "writeDevFiles" {
  return path.includes("route-config-autofix") ? "fixRouteConfigLayout" : "writeDevFiles";
}

export function productionInstrumentationPlugin(): Bun.BunPlugin {
  return {
    name: "furin-production-instrumentation",
    setup(build) {
      build.onResolve({ filter: PRODUCTION_BOUNDARY_IMPORT }, (args) => {
        const importPath = resolve(dirname(args.importer), args.path);
        if (!isFurinRuntimePath(importPath)) {
          return;
        }
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
        if (DEV_BUILD_IMPORT.test(importPath)) {
          return { namespace: PRODUCTION_STUB_NAMESPACE, path: importPath };
        }
      });
      build.onLoad(
        { filter: /.*/, namespace: PRODUCTION_STUB_NAMESPACE },
        ({ path }) => ({
          contents: `export function ${devBuildExport(path)}() {
  throw new Error("[furin] Development-only module reached a production bundle.");
}`,
          loader: "js",
        })
      );
    },
  };
}
