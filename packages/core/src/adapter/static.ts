import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildClient } from "../build/client.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, StaticTargetBuildManifest } from "../build/types.ts";
import type { StaticExportConfig } from "../config.ts";
import { resolvePath } from "../render/assemble.ts";
import { prerenderSSG } from "../render/index.ts";
import { generateProdIndexHtml } from "../render/shell.ts";
import { setProductionTemplateContent } from "../render/template.ts";
import type { ResolvedRoute, RootLayout } from "../router.ts";

/** Maximum concurrent pre-render calls (mirrors warmSSGCache). */
const STATIC_CONCURRENCY = 4;

/** Pattern that identifies a dynamic route segment. */
const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;

/** Strips all trailing slashes from a string. */
const TRAILING_SLASHES_RE = /\/+$/;

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Converts a URL path to a filesystem output path.
 * "/"              → "outDir/index.html"
 * "/docs/routing"  → "outDir/docs/routing/index.html"
 *
 * The resolved path is validated to stay within `outDir` so that `..`
 * segments injected via dynamic `staticParams()` values cannot escape
 * the output directory.
 */
function pathToOutputFile(urlPath: string, outDir: string): string {
  const normalizedOutDir = resolve(outDir);
  if (urlPath === "/" || urlPath === "") {
    return join(normalizedOutDir, "index.html");
  }
  const resolved = resolve(normalizedOutDir, urlPath.slice(1), "index.html");
  if (!resolved.startsWith(`${normalizedOutDir}${sep}`)) {
    throw new Error(
      `[furin] static: unsafe output path detected for URL "${urlPath}" — path traversal via ".." is not allowed.`
    );
  }
  return resolved;
}

// ── Pre-render worker ─────────────────────────────────────────────────────────

async function prerenderAndWrite(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  outDir: string,
  renderedRoutes: string[],
  skippedRoutes: string[],
  basePath: string
): Promise<void> {
  const urlPath = resolvePath(route.pattern, params);
  const outputFile = pathToOutputFile(urlPath, outDir);

  try {
    const entry = await prerenderSSG(route, params, root, "http://localhost", basePath);

    if (entry instanceof Response) {
      console.warn(
        `[furin] static: route "${route.pattern}" loader returned a redirect — skipping.`
      );
      return;
    }

    ensureDir(dirname(outputFile));
    writeFileSync(outputFile, entry.html);
    renderedRoutes.push(urlPath);
    console.log(`[furin] static:   ${urlPath} → ${toPosixPath(outputFile)}`);
  } catch (err) {
    console.error(
      `[furin] static: prerender failed for "${route.pattern}" (params: ${JSON.stringify(params)}):`,
      err
    );
    skippedRoutes.push(urlPath);
  }
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
  const nonSsg = routes.filter((r) => r.mode !== "ssg");

  if (nonSsg.length === 0) {
    return routes;
  }

  if (onSSR === "error") {
    const list = nonSsg.map((r) => `  • ${r.pattern} (mode: ${r.mode})`).join("\n");
    throw new Error(
      "[furin] Cannot produce a static export: the following routes are not SSG and cannot be pre-rendered.\n" +
        `Either change their mode to "ssg", remove them, or set \`onSSR: "skip"\` in your static config.\n\n` +
        `${list}`
    );
  }

  // onSSR === "skip"
  for (const r of nonSsg) {
    console.warn(
      `[furin] static: skipping route "${r.pattern}" (mode=${r.mode}) — not statically exportable.`
    );
    skippedRoutes.push(r.pattern);
  }

  return routes.filter((r) => r.mode === "ssg");
}

// ── Task queue builder ────────────────────────────────────────────────────────

/**
 * Builds the flat list of pre-render tasks for all SSG routes.
 * Dynamic routes without staticParams() are warned about and pushed to skippedRoutes.
 */
async function buildTaskQueue(
  ssgRoutes: ResolvedRoute[],
  root: RootLayout,
  outDir: string,
  renderedRoutes: string[],
  skippedRoutes: string[],
  basePath: string
): Promise<Array<() => Promise<void>>> {
  const tasks: Array<() => Promise<void>> = [];

  for (const route of ssgRoutes) {
    if (!DYNAMIC_SEGMENT_RE.test(route.pattern)) {
      tasks.push(() =>
        prerenderAndWrite(route, {}, root, outDir, renderedRoutes, skippedRoutes, basePath)
      );
      continue;
    }

    if (!route.page.staticParams) {
      console.warn(
        `[furin] static: skipping dynamic route "${route.pattern}" — no staticParams() defined.`
      );
      skippedRoutes.push(route.pattern);
      continue;
    }

    try {
      const paramSets = (await route.page.staticParams()) ?? [];
      for (const params of paramSets) {
        tasks.push(() =>
          prerenderAndWrite(route, params, root, outDir, renderedRoutes, skippedRoutes, basePath)
        );
      }
    } catch (err) {
      console.error(`[furin] static: staticParams() failed for "${route.pattern}":`, err);
      skippedRoutes.push(route.pattern);
    }
  }

  return tasks;
}

// ── Concurrency runner ────────────────────────────────────────────────────────

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  const queue = [...tasks];
  const workerCount = Math.min(concurrency, Math.max(queue.length, 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        await queue.shift()?.();
      }
    })
  );
}

// ── Main adapter ──────────────────────────────────────────────────────────────

export async function buildStaticTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  root: RootLayout,
  options: BuildAppOptions
): Promise<StaticTargetBuildManifest> {
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

  const outDir = resolve(rootDir, staticConfig.outDir ?? "dist");

  // Guard against destructive rmSync on obviously wrong output directories.
  const normalizedRoot = resolve(rootDir);
  const normalizedBuildRoot = resolve(buildRoot);
  if (
    outDir === normalizedRoot ||
    outDir === normalizedBuildRoot ||
    outDir === "/" ||
    outDir === "."
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

  // ── 2. Clean & create output directories ─────────────────────────────────
  rmSync(outDir, { force: true, recursive: true });
  ensureDir(outDir);

  const targetDir = join(buildRoot, "static");
  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  // ── 3. Build client bundle ────────────────────────────────────────────────
  const { entryChunk, cssChunks } = await buildClient(ssgRoutes, {
    outDir: targetDir,
    rootLayout: root.path,
    plugins: options.plugins,
    publicPath,
    basePath,
  });

  // ── 4. Generate HTML shell template ──────────────────────────────────────
  // Emit a <link rel="icon"> only when a favicon.ico exists in the public dir.
  // This ensures the browser finds it even when the site is served from a sub-path.
  const publicFavicon = join(rootDir, "public", "favicon.ico");
  const faviconHref = existsSync(publicFavicon) ? `${basePath}/favicon.ico` : undefined;
  const shellHtml = generateProdIndexHtml(entryChunk, cssChunks, undefined, faviconHref);

  // ── 5. Prime the renderer with the production shell ──────────────────────
  // Must be called before any prerenderSSG invocation.
  // prepareRender() checks getProductionTemplate() first (before IS_DEV), so
  // setting the content here is sufficient — no need to flip IS_DEV globally.
  setProductionTemplateContent(shellHtml);

  // ── 6. Copy public/ → outDir/ ─────────────────────────────────────────────
  const publicSrcDir = join(rootDir, "public");
  if (existsSync(publicSrcDir)) {
    cpSync(publicSrcDir, outDir, { recursive: true });
  }

  // ── 7. Copy _client/ chunks → outDir/_client/ ────────────────────────────
  const clientSrcDir = join(targetDir, "client");
  if (existsSync(clientSrcDir)) {
    cpSync(clientSrcDir, join(outDir, "_client"), { recursive: true });
  }

  // ── 8. Pre-render SSG routes ──────────────────────────────────────────────
  const tasks = await buildTaskQueue(
    ssgRoutes,
    root,
    outDir,
    renderedRoutes,
    skippedRoutes,
    basePath
  );
  // Snapshot after queue-building: routes skipped due to missing staticParams() are
  // already recorded; only routes added during task execution are prerender failures.
  const afterQueueCount = skippedRoutes.length;
  await runWithConcurrency(tasks, STATIC_CONCURRENCY);

  // Fail the build when onSSR="error" and any prerender task was recorded as skipped.
  if (onSSR === "error" && skippedRoutes.length > afterQueueCount) {
    const failed = skippedRoutes.slice(afterQueueCount);
    const list = failed.map((r) => `  • ${r}`).join("\n");
    throw new Error(
      `[furin] static: ${failed.length} route(s) failed to pre-render:\n${list}\n` +
        `Set \`onSSR: "skip"\` in your static config to suppress this error.`
    );
  }

  // ── 9. Write 404.html (SPA fallback for GitHub Pages) ───────────────────
  writeFileSync(join(outDir, "404.html"), shellHtml);
  console.log("[furin] static: wrote 404.html (SPA shell fallback)");

  // ── 10. Clean up intermediate build artifacts ────────────────────────────
  rmSync(targetDir, { force: true, recursive: true });

  console.log(
    `[furin] static: export complete → ${toPosixPath(outDir)}` +
      ` (${renderedRoutes.length} rendered, ${skippedRoutes.length} skipped)`
  );

  return {
    basePath,
    generatedAt: new Date().toISOString(),
    outDir: toPosixPath(outDir),
    renderedRoutes,
    skippedRoutes,
  };
}
