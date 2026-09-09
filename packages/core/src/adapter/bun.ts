import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBunBuild } from "../build/bun-build.ts";
import { buildClient } from "../build/client.ts";
import { generateCompileEntry } from "../build/compile-entry.ts";
import type { BuildEntryOptions, EntryAppContext } from "../build/entry-template.ts";
import { productionInstrumentationPlugin } from "../build/production-instrumentation.ts";
import { generateServerRoutesEntry } from "../build/server-routes-entry.ts";
import { buildTargetManifest, copyDirRecursive, ensureDir, toPosixPath } from "../build/shared.ts";
import { buildSSGCacheSnapshot } from "../build/ssg-cache.ts";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types.ts";
import type { BuildTarget } from "../config.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { buildRscGraph } from "../rsc/build/index.ts";
import { ssgRouteCache } from "../server/cache/ssg.ts";
import { generateProdIndexHtml } from "../server/render/shell.ts";
import { setProductionTemplateContent } from "../server/render/template.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/index.ts";
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
const BUILD_ID_INPUT_PATHS = [
  `${_pkgSrcDir}/build/compile-entry${_ext}`,
  `${_pkgSrcDir}/build/entry-template${_ext}`,
  `${_pkgSrcDir}/build/server-routes-entry${_ext}`,
  `${_pkgSrcDir}/server/render/index${_ext}`,
  `${_pkgSrcDir}/server/render/shell${_ext}`,
  `${_pkgSrcDir}/server/router/index${_ext}`,
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
 * contents and the framework's own render pipeline sources. Shared with the
 * package target so packaged apps get the same stale-deploy detection —
 * SSR-only changes (loader/page code that never reaches the client bundle)
 * must still produce a new build ID.
 */
export async function createBuildFingerprint(
  entryChunk: string,
  cssChunks: string[],
  routes: ResolvedRoute[],
  root: RootLayout,
  serverEntry: string | null
): Promise<string> {
  const fingerprintPaths = new Set<string>([root.path, ...routes.map((route) => route.path)]);
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
      // A missing framework source file would silently produce an empty-string
      // contribution to the fingerprint, making the build ID unreliable.
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
      return `${toPosixPath(path)}:${content}`;
    })
  );

  const routeParts = routes
    .map((route) =>
      JSON.stringify({ mode: route.mode, path: toPosixPath(route.path), pattern: route.pattern })
    )
    .sort(compareCodeUnits);

  return [entryChunk, ...[...cssChunks].toSorted(), ...routeParts, ...fileParts].join("\n");
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
      segmentBoundaries: route.segmentBoundaries.map((b) => ({
        depth: b.depth,
        path: toPosixPath(b.path),
        errorPath: b.errorPath ? toPosixPath(b.errorPath) : undefined,
        notFoundPath: b.notFoundPath ? toPosixPath(b.notFoundPath) : undefined,
      })),
    };
  }

  return { rootConventions, routeMetadata };
}

/** One mounted app's build input (root + routes scanned from its pagesDir). */
export interface BunTargetApp {
  pagesDir: string;
  prefix: string;
  root: RootLayout;
  routes: ResolvedRoute[];
}

function collectEmbeddedAssets(
  entryApps: BuildEntryOptions["apps"],
  publicDir: string | undefined,
  compile: BuildAppOptions["compile"]
): string[] | undefined {
  if (compile !== "embed") {
    return;
  }
  const assets = entryApps.flatMap((app) => (app.embed ? [app.embed.clientDir] : []));
  if (publicDir !== undefined) {
    assets.push(publicDir);
  }
  return assets;
}

/** Builds one app's client bundle + compile context payload for the entry. */
async function buildOneApp(
  app: BunTargetApp,
  targetDir: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<{
  buildId: string;
  entryApp: BuildEntryOptions["apps"][number];
}> {
  const { prefix, root, routes } = app;
  const clientDirName = clientDirNameForPrefix(prefix);
  const label = prefix === "" ? "root app" : `app "${prefix}"`;

  const { entryChunk, cssChunks } = await buildClient(routes, {
    outDir: targetDir,
    rootLayout: root.path,
    plugins: options.plugins,
    publicPath: `${prefix}/_client/`,
    basePath: prefix,
    clientLogging: options.clientLogging ?? false,
    clientDirName,
    metafilePath: options.analyze
      ? join(dirname(targetDir), "analysis", `bun-${clientDirName}.json`)
      : undefined,
    reactCompiler: options.reactCompiler,
  });

  const buildFingerprint = await createBuildFingerprint(
    `${prefix}\n${entryChunk}`,
    cssChunks,
    routes,
    root,
    serverEntry
  );
  const buildId = Bun.hash(buildFingerprint).toString(16).slice(0, 12);
  if (serverEntry) {
    await buildRscGraph(routes, root, targetDir, buildId, options.plugins);
  }

  // Write index.html with the buildId meta tag injected so the client can
  // detect stale deploys via X-Furin-Build-ID header comparison.
  const clientDir = join(targetDir, clientDirName);
  const indexHtml = generateProdIndexHtml(entryChunk, cssChunks, buildId, undefined, false);
  writeFileSync(join(clientDir, "index.html"), indexHtml);

  // The SSG snapshot renders through the (build-time) default state bucket:
  // install this app's template, then clear the bucket's html caches so the
  // previous app's prerenders can never leak into this snapshot. The mount
  // prefix is passed explicitly — no instance scope exists at build time.
  setProductionTemplateContent(indexHtml);
  ssgRouteCache().clear();
  const ssgCache = serverEntry
    ? await buildSSGCacheSnapshot(routes, root, "http://localhost", prefix)
    : undefined;

  const { rootConventions, routeMetadata } = buildCompileMetadata(root, routes);
  console.log(`[furin] Built ${label} (buildId ${buildId})`);

  return {
    buildId,
    entryApp: {
      buildId,
      clientLogging: options.clientLogging ?? false,
      prefix,
      rootPath: root.path,
      routes: routes.map((r) => ({ pattern: r.pattern, path: r.path, mode: r.mode })),
      rootConventions,
      routeMetadata,
      ssgCache,
      embed: options.compile === "embed" ? { clientDir } : undefined,
    },
  };
}

async function buildAppsSequentially(
  apps: BunTargetApp[],
  targetDir: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<{
  entryApps: BuildEntryOptions["apps"];
  headlineBuildId: string;
}> {
  const entryApps: BuildEntryOptions["apps"] = [];
  let headlineBuildId = "";

  for (const app of apps) {
    // biome-ignore lint/performance/noAwaitInLoops: each app installs a build-time template before SSG snapshotting, so this must remain ordered.
    const built = await buildOneApp(app, targetDir, serverEntry, options);
    entryApps.push(built.entryApp);
    // The ROOT app's buildId is the manifest's headline id (back-compat).
    if (app.prefix === "" || headlineBuildId === "") {
      headlineBuildId = built.buildId;
    }
  }

  return { entryApps, headlineBuildId };
}

export async function buildBunTarget(
  apps: BunTargetApp[],
  rootDir: string,
  buildRoot: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  if (options.compile && !serverEntry) {
    throw new Error(
      `[furin] \`compile: "${options.compile}"\` requires a server entry point. ` +
        "Create src/server.ts or set `serverEntry` in your furin.config.ts."
    );
  }
  if (apps.length === 0) {
    throw new Error("[furin] buildBunTarget requires at least one app.");
  }

  const target = "bun" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  const publicDir = existsSync(join(rootDir, "public")) ? join(rootDir, "public") : undefined;
  const { entryApps, headlineBuildId } = await buildAppsSequentially(
    apps,
    targetDir,
    serverEntry,
    options
  );
  targetManifest.buildId = headlineBuildId;
  if (serverEntry) {
    targetManifest.rscManifestPath = toPosixPath(
      join(targetManifest.targetDir, "rsc", "manifest.json")
    );
  }

  const targetPublicDir = publicDir ? join(targetDir, "public") : undefined;
  if (publicDir && targetPublicDir && options.compile !== "embed") {
    copyDirRecursive(publicDir, targetPublicDir);
  }

  if (options.compile && serverEntry) {
    const outfile = join(targetDir, "server");

    const entry = generateCompileEntry({
      apps: entryApps,
      serverEntry,
      outDir: targetDir,
      publicDir,
    });
    const embeddedAssets = collectEmbeddedAssets(entryApps, publicDir, options.compile);

    await runBunBuild({
      entrypoints: [entry.entrypoint],
      files: entry.files,
      compile: { outfile, assets: embeddedAssets },
      bytecode: true,
      format: "esm",
      target: "bun",
      splitting: true,
      minify: true,
      sourcemap: "none",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [
        entry.plugin,
        productionInstrumentationPlugin(),
        ...(options.plugins ?? []),
        isomorphicTransformPlugin("server"),
        environmentGuardPlugin("ssr"),
      ],
    });

    console.log(`[furin] Server binary: ${outfile}`);

    targetManifest.serverPath = toPosixPath(join(targetManifest.targetDir, "server"));

    // Embed mode: assets are in the binary — clean up client dirs too.
    if (options.compile === "embed") {
      for (const app of apps) {
        rmSync(join(targetDir, clientDirNameForPrefix(app.prefix)), {
          force: true,
          recursive: true,
        });
      }
      targetManifest.clientDir = null;
      targetManifest.templatePath = null;
    }
  } else if (serverEntry) {
    // Disk mode: generate server.ts then bundle it into self-contained server.js
    const entry = generateServerRoutesEntry({
      apps: entryApps,
      serverEntry,
      outDir: targetDir,
    });

    await runBunBuild({
      entrypoints: [entry.entrypoint],
      files: entry.files,
      outdir: targetDir,
      target: "bun",
      minify: true,
      naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
      sourcemap: "none",
      plugins: [
        entry.plugin,
        productionInstrumentationPlugin(),
        ...(options.plugins ?? []),
        isomorphicTransformPlugin("server"),
        environmentGuardPlugin("ssr"),
      ],
    });
    console.log(
      `[furin] Server bundle: ${toPosixPath(join(targetManifest.targetDir, "server.js"))}`
    );

    targetManifest.serverPath = toPosixPath(join(targetManifest.targetDir, "server.js"));
  }

  return targetManifest;
}
