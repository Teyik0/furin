import { dirname, relative, resolve } from "node:path";

const INSTRUMENTATION_IMPORT = /(?:^|[/\\])devtools[/\\]instrumentation(?:\.ts|\.js)?$/;
const DEV_PAGE_PLUGIN_IMPORT = /(?:^|[/\\])server[/\\]dev-page-plugin(?:\.ts|\.js)?$/;
const DEV_RUNTIME_IMPORT =
  /(?:^|[/\\])server[/\\]dev[/\\](?:browser-events|diagnostics|graph|plugin|runtime)(?:\.ts|\.js)?$/;
const DEV_BUILD_IMPORT =
  /(?:^|[/\\])(?:build[/\\]hydrate|plugin[/\\](?:route-config|transform-client))(?:\.ts|\.js)?$/;
const DEV_RSC_BUILD_IMPORT = /(?:^|[/\\])rsc[/\\]build[/\\]discover(?:\.ts|\.js)?$/;
const PRODUCTION_BOUNDARY_IMPORT =
  /(?:browser-events|instrumentation|dev-page-plugin|diagnostics|graph|plugin|runtime|hydrate|route-config|transform-client|discover)(?:\.ts|\.js)?$/;
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

function devBuildExports(path: string): readonly string[] {
  if (DEV_RSC_BUILD_IMPORT.test(path)) {
    return ["discoverClientBoundaries", "registerServerBoundaries"];
  }
  if (path.includes("transform-client")) {
    return ["getHmrDataSignature"];
  }
  return path.includes("route-config")
    ? ["createRouteConfigReporter", "scaffoldEmptyRoutes"]
    : ["releaseDevRouteTypes", "writeDevFiles"];
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
        if (DEV_BUILD_IMPORT.test(importPath) || DEV_RSC_BUILD_IMPORT.test(importPath)) {
          return { namespace: PRODUCTION_STUB_NAMESPACE, path: importPath };
        }
      });
      build.onLoad({ filter: /.*/, namespace: PRODUCTION_STUB_NAMESPACE }, ({ path }) => ({
        contents: devBuildExports(path)
          .map(
            (name) => `export function ${name}() {
  throw new Error("[furin] Development-only module reached a production bundle.");
}`
          )
          .join("\n"),
        loader: "js",
      }));
    },
  };
}
