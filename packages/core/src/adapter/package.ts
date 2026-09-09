import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type BunTargetApp, createBuildFingerprint } from "../adapter/bun.ts";
import { runBunBuild } from "../build/bun-build.ts";
import { buildClient } from "../build/client.ts";
import { buildEntrySource } from "../build/entry-template.ts";
import { copyDirRecursive, ensureDir, toPosixPath } from "../build/shared.ts";
import { buildSSGCacheSnapshot } from "../build/ssg-cache.ts";
import type { BuildAppOptions, PackageTargetBuildManifest } from "../build/types.ts";
import { createRoutesPlugin, routeModuleSpecifier, routeSourcePaths } from "../plugin/routes.ts";
import { ssgRouteCache } from "../server/cache/ssg.ts";
import { generateProdIndexHtml } from "../server/render/shell.ts";
import { setProductionTemplateContent } from "../server/render/template.ts";

/**
 * `--target package` — builds a furin app as a PUBLISHABLE Elysia plugin
 * instead of a bootable server. Output (`.furin/build/package/`):
 *
 * - `client/`      content-hashed chunks + index.html SSR template
 * - `register.js`  side-effect module registering the app's CompileContext;
 *                  page modules are bundled in, but everything from
 *                  node_modules (incl. @teyik0/furin itself) stays external so
 *                  the host and the register module share ONE furin runtime
 * - `index.js`     `createFurinApp()` factory the host `.use()`es
 * - `index.d.ts`   minimal typings for the factory
 *
 * The host composes it like any Elysia plugin:
 *
 * ```ts
 * import { createFurinApp as admin } from "@org/admin/furin";
 * new Elysia().use(await furin({...})).use(await admin()).listen(3000)
 * ```
 *
 * In a monorepo the baked relative `pagesDir` still points at real sources,
 * so the same factory works under `bun --hot` (dev scans live). A published
 * package without sources is production-only; its context is found by prefix.
 */
export async function buildPackageTarget(
  app: BunTargetApp,
  rootDir: string,
  buildRoot: string,
  options: BuildAppOptions
): Promise<PackageTargetBuildManifest> {
  const { prefix, root, routes, pagesDir } = app;
  const targetDir = join(buildRoot, "package");

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  const { entryChunk, cssChunks } = await buildClient(routes, {
    basePath: prefix,
    clientLogging: options.clientLogging ?? false,
    outDir: targetDir,
    pagesDir,
    plugins: options.plugins,
    publicPath: `${prefix}/_client/`,
    rootLayout: root.path,
  });

  // Same fingerprint as the Bun target: hashing only the client chunks would
  // keep the old build ID across SSR-only changes (page/loader code that never
  // reaches the client bundle), defeating stale-deploy detection. The package
  // target has no server entry, hence `null`.
  const buildFingerprint = await createBuildFingerprint(
    `${prefix}\n${entryChunk}`,
    cssChunks,
    routes,
    root,
    null
  );
  const buildId = Bun.hash(buildFingerprint).toString(16).slice(0, 12);

  const clientDir = join(targetDir, "client");

  // At runtime furin() derives publicDir next to the baked clientDir
  // (join(dirname(clientDir), "public")), so the project's public/ assets must
  // ship inside the artifact or /public/* and /favicon.ico 404 in production.
  const publicDir = join(rootDir, "public");
  if (existsSync(publicDir)) {
    copyDirRecursive(publicDir, join(targetDir, "public"));
  }

  const indexHtml = generateProdIndexHtml(entryChunk, cssChunks, buildId, undefined, false);
  writeFileSync(join(clientDir, "index.html"), indexHtml);

  // SSG snapshot renders through the build-time default state bucket. The
  // mount prefix is passed explicitly — no instance scope exists at build time.
  setProductionTemplateContent(indexHtml);
  ssgRouteCache().clear();
  const ssgCache = await buildSSGCacheSnapshot(routes, root, "http://localhost", prefix);

  const rootConventions =
    root.errorPath || root.notFoundPath
      ? {
          errorPath: root.errorPath ? toPosixPath(root.errorPath) : undefined,
          notFoundPath: root.notFoundPath ? toPosixPath(root.notFoundPath) : undefined,
        }
      : undefined;
  const routeMetadata: Record<
    string,
    {
      segmentBoundaries: Array<{
        depth: number;
        path: string;
        errorPath?: string;
        notFoundPath?: string;
      }>;
    }
  > = {};
  for (const route of routes) {
    routeMetadata[toPosixPath(route.path)] = {
      segmentBoundaries: route.segmentBoundaries.map((b) => ({
        depth: b.depth,
        errorPath: b.errorPath ? toPosixPath(b.errorPath) : undefined,
        notFoundPath: b.notFoundPath ? toPosixPath(b.notFoundPath) : undefined,
        path: toPosixPath(b.path),
      })),
    };
  }

  // 1. register.ts — context registration side-effect module.
  const registerSource = buildEntrySource({
    apps: [
      {
        buildId,
        clientLogging: options.clientLogging ?? false,
        modulePaths: routeSourcePaths({ pagesDir, prefix }),
        nativeRoutes: routeModuleSpecifier(app),
        prefix,
        rootConventions,
        rootPath: root.path,
        routeMetadata,
        routes: routes.map((r) => ({ mode: r.mode, path: r.path, pattern: r.pattern })),
        ssgCache,
      },
    ],
    headerComment: "// Auto-generated by `furin build --target package` — do not edit",
    mode: "register",
  });
  const registerEntry = join(targetDir, "register.ts");
  writeFileSync(registerEntry, registerSource);

  const result = await runBunBuild({
    entrypoints: [registerEntry],
    minify: false,
    naming: { chunk: "[name]-[hash].[ext]", entry: "[name].[ext]" },
    outdir: targetDir,
    // Keep EVERY dependency external (incl. @teyik0/furin): the host must
    // share one copy of the furin runtime with this register module — only
    // the package's own page sources get bundled in.
    packages: "external",
    plugins: [
      ...(options.plugins ?? []),
      createRoutesPlugin({ instances: [app], target: "server" }),
    ],
    sourcemap: "none",
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "[furin] package register build failed");
  }
  rmSync(registerEntry, { force: true });
  rmSync(join(targetDir, "_hydrate.tsx"), { force: true });

  // 2. index.js — the factory the host mounts. The baked relative pagesDir
  // keeps monorepo dev working; in a published package the compile context is
  // resolved by prefix instead.
  const relativePagesDir = toPosixPath(relative(targetDir, resolve(rootDir, pagesDir)));
  const factorySource = `// Auto-generated by \`furin build --target package\` — do not edit
import { fileURLToPath } from "node:url";
import { furin } from "@teyik0/furin";
import "./register.js";

const PAGES_DIR = fileURLToPath(new URL(${JSON.stringify(`./${relativePagesDir}`)}, import.meta.url));
const CLIENT_DIR = fileURLToPath(new URL("./client", import.meta.url));

/**
 * Mounts this packaged furin app as an Elysia plugin.
 *
 * @param {object} [options] Extra furin() options (logger, sync, ...) —
 * pagesDir/prefix/clientDir are baked into the package and cannot be overridden.
 * @returns {ReturnType<typeof import("@teyik0/furin").furin>}
 */
export function createFurinApp(options = {}) {
  return furin({
    ...options,
    pagesDir: PAGES_DIR,
    prefix: ${JSON.stringify(prefix)},
    clientDir: CLIENT_DIR,
  });
}

export const prefix = ${JSON.stringify(prefix)};
`;
  writeFileSync(join(targetDir, "index.js"), factorySource);

  const dtsSource = `import type { FurinOptions, furin } from "@teyik0/furin";

/** Extra furin() options — pagesDir/prefix/clientDir are baked into the package and cannot be overridden. */
export type CreateFurinAppOptions = Omit<FurinOptions, "pagesDir" | "prefix" | "clientDir">;
export declare function createFurinApp(options?: CreateFurinAppOptions): ReturnType<typeof furin>;
export declare const prefix: string;
`;
  writeFileSync(join(targetDir, "index.d.ts"), dtsSource);

  console.log(`[furin] Package artifact: ${toPosixPath(relative(rootDir, targetDir))}`);

  return {
    buildId,
    generatedAt: new Date().toISOString(),
    prefix,
    targetDir: toPosixPath(relative(rootDir, targetDir)),
  };
}
