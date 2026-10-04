import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBunBuild } from "../build/bun-build.ts";
import { elysiaAot } from "../build/elysia-aot.ts";
import { productionInstrumentationPlugin } from "../build/production-instrumentation.ts";
import { materializeServerAppEntry } from "../build/server-app-entry.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types.ts";
import { createVirtualBuildEntry } from "../build/virtual-entry.ts";
import { createRoutesPlugin } from "../plugin/routes.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { hasRequestLoader } from "../server/render/loaders.ts";
import { resolveDocumentMode } from "../server/router/patterns.ts";
import {
  buildRuntimeAppsSequentially,
  isFrameworkRuntimeImporter,
  mixedRuntimePlugin,
  pprRuntimePlugin,
  type RuntimeTargetApp,
} from "./runtime-build.ts";

const RUNTIME_ROOT = dirname(import.meta.dir);
const STATIC_IMPORT = /^@elysia\/static$/;
const REACT_SERVER_IMPORT = /^react-dom\/server(?:\.edge)?$/;
const RSC_IMPORT = /^(?:@teyik0\/furin|furin)\/(?:rsc|sync(?:\/.*)?)$/;
const FURIN_IMPORT = /^(?:@teyik0\/furin|furin)(?:\/.*)?$/;
const FURIN_ALIAS = /^furin(?=\/|$)/;
const HASHED_ASSET = /-[a-zA-Z0-9]{8}\.[^.]+$/;
const HEADER_LINE_BREAK = /\r?\n/;
const HEADER_RULE = /^(?:\/|https:\/\/)/;
const ALL_MODULES = /.*/;

function cloudflareRuntimePlugin(): Bun.BunPlugin {
  const reactServer = fileURLToPath(import.meta.resolve("react-dom/server.edge"));
  return {
    name: "furin-cloudflare-runtime",
    setup(build) {
      build.onResolve({ filter: REACT_SERVER_IMPORT }, ({ importer }) =>
        isFrameworkRuntimeImporter(importer) ? { path: reactServer } : undefined
      );
      build.onResolve({ filter: RSC_IMPORT }, () => {
        throw new Error("[furin] Cloudflare Workers does not support RSC or Furin Sync yet.");
      });
      // Keep Furin on the same source modules as the injected compile contexts,
      // without enabling Bun exports for application dependencies.
      build.onResolve({ filter: FURIN_IMPORT }, ({ path }) => ({
        path: Bun.resolveSync(path.replace(FURIN_ALIAS, "@teyik0/furin"), RUNTIME_ROOT),
      }));
      build.onResolve({ filter: STATIC_IMPORT }, ({ importer }) => {
        if (!isFrameworkRuntimeImporter(importer)) {
          throw new Error(
            "[furin] Cloudflare Workers does not support @elysia/static. Use public/ assets."
          );
        }
        return { namespace: "furin-cloudflare-static", path: "static" };
      });
      build.onLoad({ filter: ALL_MODULES, namespace: "furin-cloudflare-static" }, () => ({
        contents: `export function staticPlugin() { throw new Error("[furin] Cloudflare serves assets through its CDN."); }`,
        loader: "js",
      }));
    },
  };
}

function assertSupportedRoutes(apps: RuntimeTargetApp[]): void {
  for (const app of apps) {
    if (app.prefix === "/_client" || app.prefix.startsWith("/_client/")) {
      throw new Error(
        "[furin] Cloudflare apps cannot mount inside the reserved /_client namespace."
      );
    }
    for (const route of app.routes) {
      if (
        route.mode === "isr" ||
        app.root.route.mode === "isr" ||
        route.routeChain.some((entry) => entry.mode === "isr")
      ) {
        throw new Error(
          `[furin] Cloudflare Workers does not support ISR (${route.pattern}): shared durable caching and global invalidation are required.`
        );
      }
      if (
        resolveDocumentMode(route) !== "ssr" &&
        (app.root.route.requestLoader !== undefined || hasRequestLoader(route))
      ) {
        throw new Error(`[furin] Cloudflare Workers does not support PPR (${route.pattern}) yet.`);
      }
    }
  }
}

function readAssetHeaders(publicDir: string): string {
  if (existsSync(join(publicDir, "_client"))) {
    throw new Error(
      "[furin] Cloudflare Workers reserves public/_client for hashed browser assets."
    );
  }
  const headersPath = join(publicDir, "_headers");
  const publicHeaders = existsSync(headersPath) ? readFileSync(headersPath, "utf8") : "";
  const customRules = publicHeaders
    .split(HEADER_LINE_BREAK)
    .filter((line) => HEADER_RULE.test(line))
    .map((line) => line.trim());
  if (customRules.length >= 100 || customRules.includes("/_client/*")) {
    throw new Error(
      "[furin] Cloudflare public/_headers supports at most 99 custom rules and reserves the /_client/* rule."
    );
  }
  // One reserved rule keeps any number of browser chunks within Cloudflare's 100-rule limit.
  return `${publicHeaders}\n/_client/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n`;
}

export async function buildCloudflareTarget(
  apps: RuntimeTargetApp[],
  rootDir: string,
  buildRoot: string,
  serverEntry: string,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  assertSupportedRoutes(apps);
  if (options.compile) {
    throw new Error("[furin] Cloudflare Workers cannot compile a Bun executable.");
  }
  if (options.serverSourceMaps) {
    throw new Error("[furin] Cloudflare Workers private server source maps are not supported yet.");
  }
  const publicDir = join(rootDir, "public");
  const assetHeaders = readAssetHeaders(publicDir);
  const targetDir = join(buildRoot, "cloudflare");
  rmSync(targetDir, { force: true, recursive: true });
  const assetsDir = join(targetDir, "assets");
  ensureDir(assetsDir);
  const { builds, headlineBuildId } = await buildRuntimeAppsSequentially(
    apps,
    rootDir,
    targetDir,
    serverEntry,
    options,
    "cloudflare"
  );
  const browserFiles = new Set<string>();
  if (existsSync(publicDir)) {
    cpSync(publicDir, assetsDir, { recursive: true });
  }
  for (const [index, built] of builds.entries()) {
    const app = apps[index] as RuntimeTargetApp;
    const appAssets = join(assetsDir, app.prefix.slice(1));
    if (existsSync(publicDir)) {
      cpSync(publicDir, join(appAssets, "public"), { recursive: true });
      const favicon = join(publicDir, "favicon.ico");
      if (existsSync(favicon)) {
        cpSync(favicon, join(appAssets, "favicon.ico"));
      }
    }
    const clientAssets = join(assetsDir, "_client");
    ensureDir(clientAssets);
    for (const file of built.browserFiles) {
      // Only actual browser build outputs enter the CDN, never SSR templates or server data.
      const filename = basename(file);
      if (!HASHED_ASSET.test(filename)) {
        throw new Error(`[furin] Cloudflare browser asset ${filename} must have a content hash.`);
      }
      browserFiles.add(filename);
      cpSync(file, join(clientAssets, filename));
    }
  }
  writeFileSync(join(assetsDir, "_headers"), assetHeaders);
  const appEntry = await materializeServerAppEntry({
    apps: builds.map(({ entryApp, indexHtml }) => ({
      ...entryApp,
      clientDir: "",
      serveAssets: false,
      templateHtml: indexHtml,
    })),
    headerComment: "// Auto-generated by furin build --target cloudflare",
    instances: apps,
    outDir: targetDir,
    serverEntry,
  });
  const entry = createVirtualBuildEntry(
    join(targetDir, "_cloudflare-handler.ts"),
    `import app from ${JSON.stringify(toPosixPath(appEntry))};
app.compile();
const dataPaths = ${JSON.stringify(apps.map((app) => `${app.prefix}/_furin/data`))};
export default { async fetch(request) {
  const response = await app.handle(request);
  if (response.status === 101) return response;
  if (response.headers.get("content-type")?.includes("text/html") ||
      dataPaths.includes(new URL(request.url).pathname) ||
      !response.headers.get("cache-control")) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
} };
`,
    "ts"
  );
  const serverBuild = await runBunBuild({
    conditions: ["workerd", "browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [entry.entrypoint],
    files: entry.files,
    format: "esm",
    minify: true,
    naming: { entry: "worker.[ext]" },
    outdir: targetDir,
    publicPath: "/_client/",
    plugins: [
      entry.plugin,
      cloudflareRuntimePlugin(),
      productionInstrumentationPlugin(),
      pprRuntimePlugin(apps),
      mixedRuntimePlugin(apps),
      ...(options.plugins ?? []),
      createRoutesPlugin({ instances: apps, target: "server" }),
      isomorphicTransformPlugin("server"),
      environmentGuardPlugin("ssr"),
      elysiaAot(appEntry, "workerd"),
    ],
    external: ["node:*", "cloudflare:*"],
    sourcemap: "none",
    target: "browser",
  });
  for (const output of serverBuild.outputs) {
    if (output.loader === "file" && !browserFiles.has(basename(output.path))) {
      throw new Error(
        `[furin] Cloudflare Workers cannot deploy server-only file asset ${basename(output.path)}. Move public assets to public/ and reference their public URLs.`
      );
    }
  }
  writeFileSync(
    join(targetDir, "wrangler.jsonc"),
    `${JSON.stringify(
      {
        name: "furin-app",
        main: "worker.js",
        compatibility_date: "2026-06-01",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          directory: "./assets",
          html_handling: "none",
          not_found_handling: "none",
        },
      },
      null,
      2
    )}\n`
  );
  return {
    buildId: headlineBuildId,
    clientDir: assetsDir,
    generatedAt: new Date().toISOString(),
    serverEntry,
    serverPath: join(targetDir, "worker.js"),
    targetDir,
    templatePath: null,
  };
}
