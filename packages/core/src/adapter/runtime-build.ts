import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "../build/client.ts";
import type { BuildEntryOptions, EntryAppContext } from "../build/entry-template.ts";
import { toPosixPath } from "../build/shared.ts";
import {
  buildRoutePrerenders,
  buildSSGCacheSnapshot,
  type RoutePrerender,
  type SSGCacheSnapshot,
} from "../build/ssg-cache.ts";
import type { BuildAppOptions } from "../build/types.ts";
import { composableRouteModuleSpecifier, routeSourcePaths } from "../plugin/routes.ts";
import { buildRscGraph } from "../rsc/build/index.ts";
import { ssgRouteCache } from "../server/cache/ssg.ts";
import { hasRequestLoader } from "../server/render/loaders.ts";
import { generateProdIndexHtml } from "../server/render/shell.ts";
import { setProductionTemplateContent } from "../server/render/template.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";
import { clientDirNameForPrefix } from "../shared/prefix.ts";

// import.meta.resolve() runs at runtime (not inlined at bundle time), resolves
// through package exports, and is the Web-standard API. The main entry is
// `src/furin.ts` (or `dist/furin.js`), so we strip two path segments to reach
// the package root.
const _pkgRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin"))));
const _pkgSrcDir = existsSync(join(_pkgRoot, "src", "furin.ts"))
  ? join(_pkgRoot, "src")
  : join(_pkgRoot, "dist");
// The published package always ships `src/` (see package.json "files"), and the
// "bun" export condition resolves to the TypeScript sources, so the fingerprint
// inputs are always the `.ts` files. Some of these inputs (e.g. entry-template)
// are never emitted to `dist/` as `.js`, so detecting the extension off the dist
// copy would point at files that don't exist and silently weaken the build ID.
const _ext = ".ts";
const PPR_ROUTE_IMPORT_RE = /ppr-route(?:\.ts)?$/;
const ANY_MODULE_RE = /.*/;
const REACT_SERVER_IMPORT_RE = /^react-dom\/server(?:\.edge)?$/;
const REACT_STATIC_IMPORT_RE = /^react-dom\/static\.edge$/;
const BUILD_ID_INPUT_PATHS = [
  `${_pkgSrcDir}/build/compile-entry${_ext}`,
  `${_pkgSrcDir}/build/entry-template${_ext}`,
  `${_pkgSrcDir}/plugin/routes${_ext}`,
  `${_pkgSrcDir}/server/render/document.tsx`,
  `${_pkgSrcDir}/server/render/element.tsx`,
  `${_pkgSrcDir}/server/render/index${_ext}`,
  `${_pkgSrcDir}/server/render/isr${_ext}`,
  `${_pkgSrcDir}/server/render/loaders${_ext}`,
  `${_pkgSrcDir}/server/render/not-found${_ext}`,
  `${_pkgSrcDir}/server/render/ppr-route${_ext}`,
  `${_pkgSrcDir}/server/render/ppr-document${_ext}`,
  `${_pkgSrcDir}/server/render/route-frame-transport${_ext}`,
  `${_pkgSrcDir}/server/render/shell${_ext}`,
  `${_pkgSrcDir}/server/render/ssr${_ext}`,
  `${_pkgSrcDir}/shared/compact-json${_ext}`,
  `${_pkgSrcDir}/shared/deferred-ndjson${_ext}`,
  `${_pkgSrcDir}/shared/route-frame${_ext}`,
];

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic build-ID input covering everything that can change rendered
 * output: client chunks, route shape, route/root/error/not-found source
 * contents and the framework's own render pipeline sources.
 */
export async function createBuildFingerprint(
  entryChunk: string,
  cssChunks: string[],
  routes: ResolvedRoute[],
  root: RootLayout,
  serverEntry: string | null,
  routeSources: string[],
  projectRoot: string
): Promise<string> {
  const fingerprintPaths = new Set<string>([
    root.path,
    ...routes.map((route) => route.path),
    ...routeSources,
  ]);
  if (serverEntry) {
    fingerprintPaths.add(serverEntry);
  }
  if (root.errorPath) {
    fingerprintPaths.add(root.errorPath);
  }
  if (root.notFoundPath) {
    fingerprintPaths.add(root.notFoundPath);
  }
  for (const route of routes) {
    for (const segment of route.segmentBoundaries) {
      if (segment.errorPath) {
        fingerprintPaths.add(segment.errorPath);
      }
      if (segment.notFoundPath) {
        fingerprintPaths.add(segment.notFoundPath);
      }
    }
  }
  for (const path of BUILD_ID_INPUT_PATHS) {
    if (!existsSync(path)) {
      console.warn(
        `[furin] Warning: build fingerprint input "${toPosixPath(path)}" is missing — ` +
          "the generated build ID may not reflect all framework changes."
      );
    }
    fingerprintPaths.add(path);
  }

  const fileParts = await Promise.all(
    [...fingerprintPaths].toSorted().map(async (path) => {
      const content = existsSync(path) ? await Bun.file(path).text() : "";
      return `${stableFingerprintPath(path, projectRoot)}:${content}`;
    })
  );

  const routeParts = routes
    .map((route) =>
      JSON.stringify({
        mode: route.mode,
        path: stableFingerprintPath(route.path, projectRoot),
        pattern: route.pattern,
      })
    )
    .sort(compareCodeUnits);

  return [entryChunk, ...[...cssChunks].toSorted(), ...routeParts, ...fileParts].join("\n");
}

function stableFingerprintPath(path: string, projectRoot: string): string {
  const projectPath = relative(projectRoot, path);
  if (
    !isAbsolute(projectPath) &&
    projectPath !== ".." &&
    !projectPath.startsWith("../") &&
    !projectPath.startsWith("..\\")
  ) {
    return `app/${toPosixPath(projectPath)}`;
  }
  const frameworkPath = relative(_pkgRoot, path);
  if (
    !isAbsolute(frameworkPath) &&
    frameworkPath !== ".." &&
    !frameworkPath.startsWith("../") &&
    !frameworkPath.startsWith("..\\")
  ) {
    return `furin/${toPosixPath(frameworkPath)}`;
  }
  return `external/${basename(path)}`;
}

function buildCompileMetadata(root: RootLayout, routes: ResolvedRoute[]) {
  const rootConventions =
    root.errorPath || root.notFoundPath
      ? {
          errorPath: root.errorPath ? toPosixPath(root.errorPath) : undefined,
          notFoundPath: root.notFoundPath ? toPosixPath(root.notFoundPath) : undefined,
        }
      : undefined;

  const routeMetadata: NonNullable<EntryAppContext["routeMetadata"]> = {};
  for (const route of routes) {
    routeMetadata[toPosixPath(route.path)] = {
      segmentBoundaries: route.segmentBoundaries.map((boundary) => ({
        depth: boundary.depth,
        errorPath: boundary.errorPath ? toPosixPath(boundary.errorPath) : undefined,
        notFoundPath: boundary.notFoundPath ? toPosixPath(boundary.notFoundPath) : undefined,
        path: toPosixPath(boundary.path),
      })),
    };
  }

  return { rootConventions, routeMetadata };
}

/** One mounted app's build input (root + routes scanned from its pagesDir). */
export interface RuntimeTargetApp {
  pagesDir: string;
  prefix: string;
  root: RootLayout;
  routes: ResolvedRoute[];
}

/** Avoid loading React's resumable renderer in applications without PPR routes. */
export function pprRuntimePlugin(apps: RuntimeTargetApp[]): Bun.BunPlugin {
  const enabled = apps.some((app) =>
    app.routes.some(
      (route) =>
        route.mode !== "ssr" &&
        (app.root.route.requestLoader !== undefined || hasRequestLoader(route))
    )
  );
  const pprPath = resolve(_pkgSrcDir, "server/render/ppr-route.ts");
  const reactServerPath = fileURLToPath(
    import.meta.resolve(enabled ? "react-dom/server.edge" : "react-dom/server")
  );
  const reactStaticPath = fileURLToPath(import.meta.resolve("react-dom/static.edge"));
  return {
    name: "furin-ppr-runtime",
    setup(build) {
      // Resolve before user plugins: linked-project plugins commonly resolve
      // peer dependencies from their own root and can otherwise recurse.
      build.onResolve({ filter: REACT_SERVER_IMPORT_RE }, ({ importer }) =>
        isFrameworkRuntimeImporter(importer) ? { path: reactServerPath } : undefined
      );
      build.onResolve({ filter: REACT_STATIC_IMPORT_RE }, ({ importer }) =>
        isFrameworkRuntimeImporter(importer) ? { path: reactStaticPath } : undefined
      );
      if (enabled) {
        return;
      }
      build.onResolve({ filter: PPR_ROUTE_IMPORT_RE }, ({ path, importer }) => {
        const absolute = resolve(dirname(importer.split("?")[0] as string), path);
        if (absolute !== pprPath && `${absolute}.ts` !== pprPath) {
          return;
        }
        return { namespace: "furin-no-ppr", path: "ppr" };
      });
      build.onLoad({ filter: ANY_MODULE_RE, namespace: "furin-no-ppr" }, () => ({
        contents: `export function clearPprRouteCache() {}
export function invalidatePprRoute() { return false; }
export function renderPprRoute() { throw new Error("[furin] PPR route missing from the build manifest."); }
export const runPprPublicLoaders = renderPprRoute;`,
        loader: "js",
      }));
    },
  };
}

function isFrameworkRuntimeImporter(importer: string): boolean {
  if (importer === "") {
    return false;
  }
  const fromRuntimeRoot = relative(_pkgSrcDir, importer.split("?")[0] as string);
  return (
    fromRuntimeRoot !== ".." &&
    !fromRuntimeRoot.startsWith("../") &&
    !fromRuntimeRoot.startsWith("..\\")
  );
}

export interface RuntimeAppBuild {
  buildId: string;
  clientDir: string;
  entryApp: BuildEntryOptions["apps"][number];
  indexHtml: string;
  prerenders: RoutePrerender[];
}

/** Builds one app's client bundle and compile-context payload. */
export async function buildRuntimeApp(
  app: RuntimeTargetApp,
  projectRoot: string,
  targetDir: string,
  serverEntry: string | null,
  options: BuildAppOptions,
  targetName: "bun" | "vercel"
): Promise<RuntimeAppBuild> {
  const { prefix, root, routes } = app;
  const modulePaths = routeSourcePaths(app);
  const clientDirName = clientDirNameForPrefix(prefix);
  const label = prefix === "" ? "root app" : `app "${prefix}"`;

  const { entryChunk, cssChunks } = await buildClient(routes, {
    basePath: prefix,
    clientDirName,
    clientLogging: options.clientLogging ?? false,
    metafilePath: options.analyze
      ? join(dirname(targetDir), "analysis", `${targetName}-${clientDirName}.json`)
      : undefined,
    optimizeImports: options.optimizeImports,
    outDir: targetDir,
    pagesDir: app.pagesDir,
    plugins: options.plugins,
    publicPath: `${prefix}/_client/`,
    reactCompiler: options.reactCompiler,
    rootLayout: root.path,
  });

  const buildFingerprint = await createBuildFingerprint(
    `${prefix}\n${entryChunk}`,
    cssChunks,
    routes,
    root,
    serverEntry,
    modulePaths,
    projectRoot
  );
  const buildId = Bun.hash(buildFingerprint).toString(16).slice(0, 12);

  const clientDir = join(targetDir, clientDirName);
  const indexHtml = generateProdIndexHtml(entryChunk, cssChunks, buildId, undefined, false);
  writeFileSync(join(clientDir, "index.html"), indexHtml);

  setProductionTemplateContent(indexHtml);
  ssgRouteCache().clear();
  let ssgCache: SSGCacheSnapshot | undefined;
  let prerenders: RoutePrerender[] = [];
  if (serverEntry) {
    if (targetName === "vercel") {
      prerenders = await buildRoutePrerenders(routes, root, "http://localhost", prefix);
    } else {
      ssgCache = await buildSSGCacheSnapshot(routes, root, "http://localhost", prefix);
    }
  }

  const { rootConventions, routeMetadata } = buildCompileMetadata(root, routes);
  console.log(`[furin] Built ${label} (buildId ${buildId})`);

  return {
    buildId,
    clientDir,
    entryApp: {
      buildId,
      clientLogging: options.clientLogging ?? false,
      deploymentTarget: targetName === "vercel" ? "vercel" : undefined,
      embed: options.compile === "embed" ? { clientDir } : undefined,
      modulePaths,
      nativeRoutes: composableRouteModuleSpecifier(app),
      prefix,
      rootConventions,
      rootPath: root.path,
      routeMetadata,
      routes: routes.map((route) => ({
        mode: route.mode,
        path: route.path,
        pattern: route.pattern,
      })),
      ssgCache,
    },
    indexHtml,
    prerenders,
  };
}

export async function buildRuntimeAppsSequentially(
  apps: RuntimeTargetApp[],
  projectRoot: string,
  targetDir: string,
  serverEntry: string | null,
  options: BuildAppOptions,
  targetName: "bun" | "vercel"
): Promise<{
  builds: RuntimeAppBuild[];
  entryApps: BuildEntryOptions["apps"];
  headlineBuildId: string;
}> {
  const builds: RuntimeAppBuild[] = [];
  const entryApps: BuildEntryOptions["apps"] = [];
  let headlineBuildId = "";

  for (const app of apps) {
    // biome-ignore lint/performance/noAwaitInLoops: each app installs a build-time template before SSG snapshotting, so this must remain ordered.
    const built = await buildRuntimeApp(
      app,
      projectRoot,
      targetDir,
      serverEntry,
      options,
      targetName
    );
    builds.push(built);
    entryApps.push(built.entryApp);
    if (app.prefix === "" || headlineBuildId === "") {
      headlineBuildId = built.buildId;
    }
  }
  if (serverEntry) {
    await buildRscGraph(apps, targetDir, headlineBuildId, options.plugins);
  }

  return { builds, entryApps, headlineBuildId };
}
