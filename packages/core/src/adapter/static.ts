// biome-ignore-all lint/performance/noAwaitInLoops: static build emits routes in sequence to keep output deterministic
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { toCrossJSONAsync } from "seroval";
import { PRODUCTION_DEFINE, runBunBuild } from "../build/bun-build.ts";
import { buildClient } from "../build/client.ts";
import { buildEntrySource } from "../build/entry-template.ts";
import type { ClientPreloadManifest } from "../build/preload-manifest.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, StaticTargetBuildManifest } from "../build/types.ts";
import { createVirtualBuildEntry } from "../build/virtual-entry.ts";
import { toLogical } from "../client/router/link-utils.ts";
import type { StaticExportConfig } from "../config.ts";
import { routeSourcePaths } from "../plugin/route-tree.ts";
import { buildFlightCodec } from "../rsc/build/index.ts";
import { generateProdIndexHtml } from "../server/render/shell.ts";
import { resolveDocumentMode } from "../server/router/patterns.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";
import type {
  StaticExportFailure,
  StaticExportPage,
  StaticExportResult,
} from "../server/static-export.ts";
import { isWithinPrefix } from "../shared/prefix.ts";
import { exportStaticFromBundle } from "./prerender.ts";
import { buildCompileMetadata, type RuntimeTargetApp } from "./runtime-build.ts";
import { serverBundlePlugins } from "./server-bundle.ts";

/** Strips all trailing slashes from a string. */
const TRAILING_SLASHES_RE = /\/+$/;

const STATIC_RENDER_ORIGIN = "http://localhost";

interface StaticRedirectLocation {
  html: string;
  spa: string | null;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Converts a URL path to a filesystem output path for the given file name.
 * "/"              + "index.html"           → "outDir/index.html"
 * "/docs/routing"  + "index.html"           → "outDir/docs/routing/index.html"
 * "/docs/routing"  + "__furin_data.ndjson"  → "outDir/docs/routing/__furin_data.ndjson"
 *
 * The resolved path is validated to stay within `outDir` so that `..`
 * segments injected via dynamic `staticParams()` values cannot escape
 * the output directory.
 */
function pathToOutputFile(urlPath: string, outDir: string, fileName: string): string {
  const normalizedOutDir = resolve(outDir);
  if (urlPath === "/" || urlPath === "") {
    return join(normalizedOutDir, fileName);
  }
  const resolved = resolve(normalizedOutDir, urlPath.slice(1), fileName);
  if (!resolved.startsWith(`${normalizedOutDir}${sep}`)) {
    throw new Error(
      `[furin] static: unsafe output path detected for URL "${urlPath}" — path traversal via ".." is not allowed.`
    );
  }
  return resolved;
}

function sortRouteList(routes: string[]): string[] {
  return routes.toSorted((a, b) => (a < b ? -1 : Number(a > b)));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function resolveStaticRedirectLocation(
  location: string,
  basePath: string,
  sourcePath: string
): StaticRedirectLocation {
  const sourceUrl = new URL(sourcePath, STATIC_RENDER_ORIGIN);
  const targetUrl = new URL(location, sourceUrl);
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error(
      `[furin] static: redirect from "${sourcePath}" uses unsupported protocol "${targetUrl.protocol}".`
    );
  }
  if (targetUrl.origin !== sourceUrl.origin) {
    return { html: targetUrl.href, spa: null };
  }

  const suffix = `${targetUrl.search}${targetUrl.hash}`;
  const spa = `${toLogical(targetUrl.pathname, basePath)}${suffix}`;
  if (isWithinPrefix(targetUrl.pathname, basePath)) {
    return { html: `${targetUrl.pathname}${suffix}`, spa };
  }
  const pathname = targetUrl.pathname === "/" ? `${basePath}/` : `${basePath}${targetUrl.pathname}`;
  return { html: `${pathname}${suffix}`, spa };
}

function createStaticRedirectHtml(location: string): string {
  const escapedLocation = escapeHtmlAttribute(location);
  return (
    "<!doctype html>\n" +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="refresh" content="0;url=${escapedLocation}">\n` +
    `<link rel="canonical" href="${escapedLocation}">\n` +
    "<title>Redirecting…</title>\n" +
    `<a href="${escapedLocation}">Redirecting…</a>\n`
  );
}

function assertNoStaticExportSkips(onSSR: "error" | "skip", skippedRoutes: string[]): void {
  if (onSSR !== "error" || skippedRoutes.length === 0) {
    return;
  }
  const failed = sortRouteList(skippedRoutes);
  const list = failed.map((r) => `  • ${r}`).join("\n");
  throw new Error(
    `[furin] static: ${failed.length} route(s) cannot be statically exported:\n${list}\n` +
      `Define \`staticParams()\` for dynamic SSG routes or set \`onSSR: "skip"\` in your static config.`
  );
}

function assertNoPrerenderSkips(
  onSSR: "error" | "skip",
  skippedRoutes: string[],
  afterQueueCount: number
): void {
  if (onSSR !== "error" || skippedRoutes.length <= afterQueueCount) {
    return;
  }
  const failed = sortRouteList(skippedRoutes.slice(afterQueueCount));
  const list = failed.map((r) => `  • ${r}`).join("\n");
  throw new Error(
    `[furin] static: ${failed.length} route(s) failed to pre-render:\n${list}\n` +
      `Set \`onSSR: "skip"\` in your static config to suppress this error.`
  );
}

// ── Page outputs ──────────────────────────────────────────────────────────────

interface StaticOutput {
  /** Navigation payload, or null for redirects leaving the site. */
  data: string | null;
  dataFile: string;
  html: string;
  htmlFile: string;
  path: string;
  /** Redirect target shown in the build log. */
  redirect: string | null;
}

async function toStaticOutput(
  page: StaticExportPage,
  outDir: string,
  basePath: string
): Promise<StaticOutput> {
  const htmlFile = pathToOutputFile(page.path, outDir, "index.html");
  const dataFile = pathToOutputFile(page.path, outDir, "__furin_data.ndjson");
  if (!("redirect" in page)) {
    // Persist the loader payload at a static-friendly URL: SPA navigation on
    // file-server deployments (GitHub Pages, S3, …) fetches this file instead of
    // sending `?_furin=data` requests, which no server answers there.
    return {
      data: page.ndjson,
      dataFile,
      html: page.html,
      htmlFile,
      path: page.path,
      redirect: null,
    };
  }
  const location = resolveStaticRedirectLocation(page.redirect, basePath, page.path);
  const data =
    location.spa === null
      ? null
      : `${JSON.stringify(await toCrossJSONAsync({ __furinRedirect: location.spa }))}\n`;
  return {
    data,
    dataFile,
    html: createStaticRedirectHtml(location.html),
    htmlFile,
    path: page.path,
    redirect: location.html,
  };
}

/**
 * Records skipped routes and resolves every page to its files. Throws before
 * anything is written when an output path is unsafe or onSSR="error" fails.
 */
async function collectStaticOutputs(
  exported: StaticExportResult,
  outDir: string,
  basePath: string,
  onSSR: "error" | "skip",
  skippedRoutes: string[]
): Promise<StaticOutput[]> {
  for (const pattern of exported.missingParams) {
    console.warn(
      `[furin] static: skipping dynamic route "${pattern}" — no staticParams() defined.`
    );
    skippedRoutes.push(pattern);
  }
  for (const failure of exported.paramsFailures) {
    console.error(`[furin] static: staticParams() failed for "${failure.pattern}":`, failure.error);
    skippedRoutes.push(failure.pattern);
  }
  for (const { path } of [...exported.pages, ...exported.renderFailures]) {
    pathToOutputFile(path, outDir, "index.html");
  }
  assertNoStaticExportSkips(onSSR, skippedRoutes);
  // Snapshot before render failures: routes skipped due to missing staticParams()
  // are already recorded; only paths added below are prerender failures.
  const afterQueueCount = skippedRoutes.length;

  for (const failure of exported.renderFailures) {
    logRenderFailure(failure, failure.error);
    skippedRoutes.push(failure.path);
  }
  const outputs: StaticOutput[] = [];
  for (const page of exported.pages) {
    try {
      outputs.push(await toStaticOutput(page, outDir, basePath));
    } catch (err) {
      logRenderFailure(page, err);
      skippedRoutes.push(page.path);
    }
  }
  // Fail the build when onSSR="error" and any page was recorded as skipped.
  assertNoPrerenderSkips(onSSR, skippedRoutes, afterQueueCount);
  return outputs;
}

function writeStaticOutput(output: StaticOutput): void {
  ensureDir(dirname(output.htmlFile));
  writeFileSync(output.htmlFile, output.html);
  if (output.data !== null) {
    writeFileSync(output.dataFile, output.data);
  }
  const redirect = output.redirect === null ? "" : ` (redirects to ${output.redirect})`;
  console.log(`[furin] static:   ${output.path} → ${toPosixPath(output.htmlFile)}${redirect}`);
}

function replaceOutDir(
  outDir: string,
  publicSrcDir: string,
  clientSrcDir: string,
  outputs: StaticOutput[],
  shellHtml: string
): void {
  rmSync(outDir, { force: true, recursive: true });
  ensureDir(outDir);
  if (existsSync(publicSrcDir)) {
    cpSync(publicSrcDir, outDir, { recursive: true, dereference: true });
  }
  if (existsSync(clientSrcDir)) {
    cpSync(clientSrcDir, join(outDir, "_client"), { recursive: true, dereference: true });
  }
  for (const output of outputs) {
    writeStaticOutput(output);
  }
  // SPA fallback for GitHub Pages.
  writeFileSync(join(outDir, "404.html"), shellHtml);
  console.log("[furin] static: wrote 404.html (SPA shell fallback)");
}

function logRenderFailure(
  failure: Pick<StaticExportFailure, "params" | "pattern">,
  error: unknown
) {
  console.error(
    `[furin] static: prerender failed for "${failure.pattern}" (params: ${JSON.stringify(failure.params)}):`,
    error
  );
}

// ── SSR validation ────────────────────────────────────────────────────────────

/**
 * Returns only the SSG-eligible routes.
 * Throws when onSSR="error" and non-SSG routes exist; warns+skips otherwise.
 * Pushes skipped patterns into `skippedRoutes`.
 */
function collectSsgRoutes(
  routes: ResolvedRoute[],
  onSSR: "error" | "skip",
  skippedRoutes: string[]
): ResolvedRoute[] {
  const nonSsg = routes.filter((r) => resolveDocumentMode(r) !== "ssg");

  if (nonSsg.length === 0) {
    return routes;
  }

  if (onSSR === "error") {
    const list = nonSsg
      .map(
        (r) =>
          `  • ${r.pattern} (mode: ${resolveDocumentMode(r) === "ssr" && r.mode !== "ssr" ? "ssr layout" : resolveDocumentMode(r)})`
      )
      .join("\n");
    throw new Error(
      "[furin] Cannot produce a static export: the following routes are not SSG and cannot be pre-rendered.\n" +
        `Either change their mode to "ssg", remove them, or set \`onSSR: "skip"\` in your static config.\n\n` +
        `${list}`
    );
  }

  // onSSR === "skip"
  for (const r of nonSsg) {
    console.warn(
      `[furin] static: skipping route "${r.pattern}" (mode=${resolveDocumentMode(r) === "ssr" && r.mode !== "ssr" ? "ssr layout" : resolveDocumentMode(r)}) — not statically exportable.`
    );
    skippedRoutes.push(r.pattern);
  }

  return routes.filter((r) => resolveDocumentMode(r) === "ssg");
}

// ── Export bundle ─────────────────────────────────────────────────────────────

const STATIC_ENTRY = "_furin-static";

/**
 * Bundles the app for the static export like a server target: production
 * defines and the shared server plugin chain, but no server entry. Returns
 * the module exporting the static renderer.
 */
async function bundleStaticExport(
  app: RuntimeTargetApp,
  shellHtml: string,
  preloadManifest: ClientPreloadManifest,
  serverDir: string,
  rootDir: string,
  options: BuildAppOptions
): Promise<string> {
  const { root, routes } = app;
  const { rootConventions, routeMetadata } = buildCompileMetadata(root, routes);
  const entry = createVirtualBuildEntry(
    join(serverDir, `${STATIC_ENTRY}.ts`),
    buildEntrySource({
      apps: [
        {
          clientLogging: Boolean(options.clientLogging),
          modulePaths: routeSourcePaths(app),
          preloadManifest,
          rootConventions,
          rootPath: root.path,
          routeMetadata,
          routes: routes.map((route) => ({
            mode: route.mode,
            path: route.path,
            pattern: route.pattern,
          })),
          templateHtml: shellHtml,
        },
      ],
      headerComment: "// Auto-generated by `furin build --target static` — do not edit",
      mode: "static",
      prerenderSnapshot: false,
    }),
    "ts"
  );
  const result = await runBunBuild({
    define: PRODUCTION_DEFINE,
    entrypoints: [entry.entrypoint],
    files: entry.files,
    format: "esm",
    minify: false,
    naming: { chunk: "[name]-[hash].[ext]", entry: "[name].[ext]" },
    outdir: serverDir,
    plugins: [
      entry.plugin,
      ...serverBundlePlugins({
        appEntry: undefined,
        apps: [app],
        clientReferences: undefined,
        platformAssets: undefined,
        rootDir,
        userPlugins: options.plugins,
      }),
    ],
    sourcemap: "inline",
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "[furin] static export bundle failed");
  }
  // The bundled Flight codec loads `server-codec.js` from the bundle's directory.
  await buildFlightCodec(serverDir, options.plugins);
  return join(serverDir, `${STATIC_ENTRY}.js`);
}

// ── Main adapter ──────────────────────────────────────────────────────────────

function assertNoRequestLoaders(routes: ResolvedRoute[], root: RootLayout): void {
  const offenders: string[] = [];
  if (root.route.requestLoader !== undefined) {
    offenders.push("  • <root layout>");
  }
  const requestScopedRoutes = routes.filter((route) =>
    route.routeChain.some((entry) => entry.requestLoader !== undefined)
  );
  offenders.push(...requestScopedRoutes.map((route) => `  • ${route.pattern}`));
  if (offenders.length === 0) {
    return;
  }
  throw new Error(
    "[furin] requestLoader requires a Bun server and is incompatible with a pure static export.\n" +
      offenders.join("\n")
  );
}

export async function buildStaticTarget(
  app: RuntimeTargetApp,
  rootDir: string,
  buildRoot: string,
  options: BuildAppOptions
): Promise<StaticTargetBuildManifest> {
  const { root, routes } = app;
  assertNoRequestLoaders(routes, root);

  const staticConfig: StaticExportConfig = options.staticConfig ?? {};

  // Normalize basePath: treat "" and "/" identically as no prefix; strip any
  // trailing slash so `${basePath}/_client/` never produces double slashes.
  const rawBasePath = staticConfig.basePath ?? "";
  let basePath: string;
  if (rawBasePath === "/" || rawBasePath === "") {
    basePath = "";
  } else if (rawBasePath.endsWith("/")) {
    basePath = rawBasePath.replace(TRAILING_SLASHES_RE, "");
  } else {
    basePath = rawBasePath;
  }
  if (basePath && !basePath.startsWith("/")) {
    throw new Error(
      `[furin] static: basePath must start with "/" (received "${rawBasePath}"). ` +
        `Use "" for root deployments or "/sub-path" for sub-path deployments.`
    );
  }

  const rawOutDir = staticConfig.outDir ?? "dist";
  const outDir = resolve(rootDir, rawOutDir);

  // Guard against destructive rmSync on obviously wrong output directories.
  const normalizedRoot = resolve(rootDir);
  const normalizedBuildRoot = resolve(buildRoot);
  if (
    outDir === normalizedRoot ||
    outDir === normalizedBuildRoot ||
    outDir === parse(outDir).root ||
    rawOutDir === win32.parse(rawOutDir).root
  ) {
    throw new Error(
      `[furin] static: outDir resolves to "${outDir}" which is unsafe to delete. ` +
        `Use a dedicated output directory such as "dist".`
    );
  }
  // Also reject ancestor paths: if rootDir or buildRoot is inside outDir, deleting
  // outDir would destroy them. path.relative(outDir, x) not starting with ".." means x
  // is inside (or equal to) outDir. On Windows, paths on different drives produce an
  // absolute result from relative(), which also indicates they are outside outDir.
  function isOutsideOutDir(target: string): boolean {
    const rel = relative(outDir, target);
    return rel.startsWith("..") || isAbsolute(rel);
  }
  if (!(isOutsideOutDir(normalizedRoot) && isOutsideOutDir(normalizedBuildRoot))) {
    throw new Error(
      `[furin] static: outDir resolves to "${outDir}" which is unsafe to delete. ` +
        `Use a dedicated output directory such as "dist".`
    );
  }

  const onSSR = staticConfig.onSSR ?? "error";
  const publicPath = basePath ? `${basePath}/_client/` : "/_client/";

  const renderedRoutes: string[] = [];
  const skippedRoutes: string[] = [];

  // ── 1. Validate SSR/ISR routes before doing any work ─────────────────────
  const ssgRoutes = collectSsgRoutes(routes, onSSR, skippedRoutes);

  const targetDir = join(buildRoot, "static");
  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);
  try {
    // ── 2. Build client bundle ──────────────────────────────────────────────
    const { entryChunk, cssChunks, preloadManifest } = await buildClient(ssgRoutes, {
      basePath,
      clientLogging: Boolean(options.clientLogging),
      metafilePath: options.analyze ? join(buildRoot, "analysis", "static-client.json") : undefined,
      optimizeImports: options.optimizeImports,
      outDir: targetDir,
      pagesDir: dirname(root.path),
      plugins: options.plugins,
      preloadRouteChunks: options.preload?.routeChunks,
      publicPath,
      reactCompiler: options.reactCompiler,
      rootLayout: root.path,
    });

    // ── 3. Generate HTML shell template ────────────────────────────────────
    // Emit a <link rel="icon"> only when a favicon.ico exists in the public dir.
    // This ensures the browser finds it even when the site is served from a sub-path.
    const publicFavicon = join(rootDir, "public", "favicon.ico");
    const faviconHref = existsSync(publicFavicon) ? `${basePath}/favicon.ico` : undefined;
    const shellHtml = generateProdIndexHtml(entryChunk, cssChunks, undefined, faviconHref, true);

    // ── 4. Render every page inside a temporary production bundle ───────────
    const bundle = await bundleStaticExport(
      app,
      shellHtml,
      preloadManifest,
      join(targetDir, "server"),
      rootDir,
      options
    );
    const exported = await exportStaticFromBundle(bundle, rootDir, {
      basePath,
      patterns: ssgRoutes.map((route) => route.pattern),
    });

    // ── 5. Validate every output path before writing artifacts ──────────────
    const outputs = await collectStaticOutputs(exported, outDir, basePath, onSSR, skippedRoutes);

    // ── 6. Replace outDir: public/, _client/, pages, 404.html ───────────────
    replaceOutDir(outDir, join(rootDir, "public"), join(targetDir, "client"), outputs, shellHtml);
    renderedRoutes.push(...outputs.map((output) => output.path));
  } finally {
    // ── 7. Discard intermediate build artifacts, including the bundle ───────
    rmSync(targetDir, { force: true, recursive: true });
  }

  console.log(
    `[furin] static: export complete → ${toPosixPath(outDir)}` +
      ` (${renderedRoutes.length} rendered, ${skippedRoutes.length} skipped)`
  );

  return {
    basePath,
    generatedAt: new Date().toISOString(),
    outDir: toPosixPath(outDir),
    renderedRoutes: sortRouteList(renderedRoutes),
    skippedRoutes: sortRouteList(skippedRoutes),
  };
}
