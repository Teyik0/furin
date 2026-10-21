import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { PRODUCTION_DEFINE, runBunBuild } from "../build/bun-build.ts";
import { prepareCompileEntryApps } from "../build/compile-entry.ts";
import { type EntryAppContext, PRERENDER_SNAPSHOT_FILE } from "../build/entry-template.ts";
import {
  movePrivateServerSourceMaps,
  privateServerSourceMapDir,
} from "../build/private-server-sourcemaps.ts";
import {
  type BuildRouteInput,
  rootHasRequestLoader,
  routeBuildInfo,
} from "../build/route-metadata.ts";
import { materializeServerAppEntry } from "../build/server-app-entry.ts";
import { copyDirRecursive, ensureDir, toPosixPath, writeBuildMetafile } from "../build/shared.ts";
import type { BuildAppOptions } from "../build/types.ts";
import { buildRscGraph, type ClientReference } from "../rsc/build/index.ts";
import type { AppPrerender } from "../server/prerender.ts";
import { clientDirNameForPrefix } from "../shared/prefix.ts";
import { prerenderFromBundle } from "./prerender.ts";
import { buildRuntimeApp, type RuntimeAppBuild, type RuntimeTargetApp } from "./runtime-build.ts";
import { serverBundlePlugins } from "./server-bundle.ts";
import type {
  AdapterApp,
  AdapterRoute,
  AdapterServerBundle,
  AdapterTargetManifest,
  FurinAdapter,
} from "./types.ts";

const APP_MODULE = "_furin-app.js";

function serverEntryLoader(serverEntry: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = extname(serverEntry);
  if (extension === ".tsx" || extension === ".jsx") {
    return extension.slice(1) as "jsx" | "tsx";
  }
  return extension === ".ts" ? "ts" : "js";
}

/**
 * A platform serving assets never deploys the files an application static
 * mount would read. The generated entry normalizes the application for AOT.
 */
function assertServerEntry(serverEntry: string, adapter: FurinAdapter): void {
  const transpiler = new Bun.Transpiler({ loader: serverEntryLoader(serverEntry) });
  const { imports } = transpiler.scan(readFileSync(serverEntry, "utf8"));
  if (
    adapter.capabilities.assets === "platform" &&
    imports.some(({ path }) => path === "@elysia/static")
  ) {
    throw new AggregateError(
      [
        new Error(
          `[furin] Application @elysia/static mounts are not supported by the "${adapter.name}" adapter: its platform serves assets. Put them under public/ instead.`
        ),
      ],
      `[furin] The ${adapter.name} build rejected application static mounts.`
    );
  }
}

/**
 * Points each context at its client assets relative to the bundle: a sibling
 * directory on disk, or files embedded below a standalone executable.
 */
function withAssetContexts(
  adapter: FurinAdapter,
  builds: RuntimeAppBuild[],
  targetDir: string
): EntryAppContext[] {
  const contexts = builds.map(({ entryApp, indexHtml }) => ({
    ...entryApp,
    adapter: { capabilities: adapter.capabilities, name: adapter.name },
    templateHtml: indexHtml,
  }));
  if (adapter.capabilities.assets === "platform") {
    return contexts;
  }
  if (adapter.capabilities.assets === "filesystem") {
    return contexts.map((context) => ({
      ...context,
      extraContext: [
        `  clientDir: import.meta.dir + ${JSON.stringify(`/${clientDirNameForPrefix(context.prefix ?? "")}`)},`,
      ],
    }));
  }
  return prepareCompileEntryApps({
    apps: contexts.map((context) => ({
      ...context,
      embed: { clientDir: join(targetDir, clientDirNameForPrefix(context.prefix ?? "")) },
    })),
    outDir: targetDir,
    publicDir: join(targetDir, "public"),
  });
}

function adapterRoute(app: RuntimeTargetApp, route: BuildRouteInput): AdapterRoute {
  const info = routeBuildInfo(route);
  const mode = info.documentMode;
  return {
    mode,
    pattern: route.pattern,
    ppr: mode !== "ssr" && (rootHasRequestLoader(app.root) || info.hasRequestLoader),
    queryKeys: info.queryKeys,
    revalidate: info.documentRevalidate,
    tags: route.tags ?? [],
  };
}

async function bundleServer(
  adapter: FurinAdapter,
  apps: RuntimeTargetApp[],
  appEntry: string,
  clientReferences: readonly ClientReference[],
  rootDir: string,
  targetDir: string,
  buildRoot: string,
  options: BuildAppOptions
): Promise<AdapterServerBundle> {
  const build = await runBunBuild({
    define: PRODUCTION_DEFINE,
    entrypoints: [adapter.runtimeModule, appEntry],
    format: "esm",
    metafile: options.analyze,
    minify: true,
    naming: { chunk: "chunk-[hash].[ext]", entry: "[name].[ext]" },
    outdir: targetDir,
    plugins: serverBundlePlugins({
      appEntry,
      apps,
      clientReferences,
      platformAssets: adapter.capabilities.assets === "platform" ? adapter.name : undefined,
      rootDir,
      userPlugins: options.plugins,
    }),
    sourcemap: options.serverSourceMaps ? "external" : "none",
    splitting: true,
    target: "bun",
  });
  if (options.serverSourceMaps) {
    movePrivateServerSourceMaps(
      targetDir,
      privateServerSourceMapDir(buildRoot, adapter.name),
      build.outputs.filter((output) => output.kind === "sourcemap").map((output) => output.path)
    );
  }
  if (options.analyze) {
    if (build.metafile === undefined) {
      throw new Error(`[furin] The ${adapter.name} server build did not produce its metafile.`);
    }
    writeBuildMetafile(
      join(buildRoot, "analysis", `${adapter.name}-server.json`),
      build.metafile,
      "Server"
    );
  }
  return {
    dir: targetDir,
    entry: `${basename(adapter.runtimeModule, extname(adapter.runtimeModule))}.js`,
    files: build.outputs
      .filter((output) => output.path.endsWith(".js"))
      .map((output) => toPosixPath(relative(targetDir, output.path))),
  };
}

function writePrerenderSnapshot(targetDir: string, prerenders: AppPrerender[]): void {
  const snapshot = Object.fromEntries(prerenders.map(({ prefix, ssg }) => [prefix, ssg]));
  writeFileSync(join(targetDir, PRERENDER_SNAPSHOT_FILE), `${JSON.stringify(snapshot)}\n`);
}

/**
 * Builds a deployment target: client assets per app, one server bundle whose
 * entry is the adapter's runtime module, then the prerender pass inside that
 * bundle. The adapter maps the result to its platform.
 */
export async function buildAdapterTarget(
  adapter: FurinAdapter,
  apps: RuntimeTargetApp[],
  rootDir: string,
  buildRoot: string,
  serverEntry: string,
  options: BuildAppOptions
): Promise<AdapterTargetManifest> {
  assertServerEntry(serverEntry, adapter);
  const targetDir = join(buildRoot, adapter.name);
  rmSync(targetDir, { force: true, recursive: true });
  rmSync(privateServerSourceMapDir(buildRoot, adapter.name), {
    force: true,
    recursive: true,
  });
  ensureDir(targetDir);

  const builds = await Promise.all(
    apps.map((app) => buildRuntimeApp(app, rootDir, targetDir, serverEntry, options, adapter.name))
  );
  const rootIndex = apps.findIndex((app) => app.prefix === "");
  const { buildId } = builds[rootIndex === -1 ? 0 : rootIndex] as RuntimeAppBuild;
  const rscManifest = await buildRscGraph(apps, targetDir, buildId, options.plugins);

  const projectPublicDir = join(rootDir, "public");
  const publicDir = existsSync(projectPublicDir) ? projectPublicDir : undefined;
  if (publicDir !== undefined && adapter.capabilities.assets !== "platform") {
    copyDirRecursive(publicDir, join(targetDir, "public"));
  }

  const frameworkCache = adapter.capabilities.publicCache === "framework";
  const appEntry = await materializeServerAppEntry({
    apps: withAssetContexts(adapter, builds, targetDir),
    headerComment: `// Auto-generated by \`furin build\` for the ${adapter.name} adapter — do not edit`,
    instances: apps,
    outDir: targetDir,
    prerenderSnapshot: frameworkCache,
    serverEntry,
  });
  if (frameworkCache) {
    writePrerenderSnapshot(targetDir, []);
  }
  const server = await bundleServer(
    adapter,
    apps,
    appEntry,
    rscManifest.clientReferences,
    rootDir,
    targetDir,
    buildRoot,
    options
  );
  const prerenders = await prerenderFromBundle(
    { kind: "app", path: join(targetDir, APP_MODULE) },
    rootDir,
    frameworkCache
  );
  if (frameworkCache) {
    writePrerenderSnapshot(targetDir, prerenders);
  }

  const adapterApps: AdapterApp[] = apps.map((app, index) => ({
    buildId: (builds[index] as RuntimeAppBuild).buildId,
    clientDir: (builds[index] as RuntimeAppBuild).clientDir,
    prefix: app.prefix,
    prerenders: prerenders.find((prerender) => prerender.prefix === app.prefix)?.paths ?? [],
    routes: app.routes.map((route) => adapterRoute(app, route)),
  }));
  return await adapter.onBuildComplete({
    apps: adapterApps,
    buildId,
    buildRoot,
    publicDir,
    rootDir,
    server,
    serverSourceMaps: options.serverSourceMaps ?? false,
  });
}
