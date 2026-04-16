import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildClient } from "../build/client.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { BuildAppOptions, StaticTargetBuildManifest } from "../build/types.ts";
import type { StaticExportConfig } from "../config.ts";
import { prerenderSSG } from "../render/index.ts";
import { generateProdIndexHtml } from "../render/shell.ts";
import { setProductionTemplateContent } from "../render/template.ts";
import type { ResolvedRoute, RootLayout } from "../router.ts";
import { __setDevMode } from "../runtime-env.ts";

/** Maximum concurrent pre-render calls (mirrors warmSSGCache). */
const STATIC_CONCURRENCY = 4;

/** Pattern that identifies a dynamic route segment. */
const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Resolves a route pattern + params into a concrete URL path.
 * "/blog/:slug" + { slug: "hello" } → "/blog/hello"
 */
function resolveStaticPath(pattern: string, params: Record<string, string>): string {
  let path = pattern;
  for (const [key, val] of Object.entries(params)) {
    path = path.replace(key === "*" ? "*" : `:${key}`, val);
  }
  return path;
}

/**
 * Converts a URL path to a filesystem output path.
 * "/"              → "outDir/index.html"
 * "/docs/routing"  → "outDir/docs/routing/index.html"
 */
function pathToOutputFile(urlPath: string, outDir: string): string {
  if (urlPath === "/" || urlPath === "") {
    return join(outDir, "index.html");
  }
  return join(outDir, urlPath.slice(1), "index.html");
}

// ── Pre-render worker ─────────────────────────────────────────────────────────

async function prerenderAndWrite(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  outDir: string,
  renderedRoutes: string[],
  basePath: string
): Promise<void> {
  const urlPath = resolveStaticPath(route.pattern, params);
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
      tasks.push(() => prerenderAndWrite(route, {}, root, outDir, renderedRoutes, basePath));
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
        tasks.push(() => prerenderAndWrite(route, params, root, outDir, renderedRoutes, basePath));
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
  const basePath = staticConfig.basePath ?? "";
  const outDir = resolve(rootDir, staticConfig.outDir ?? "dist");
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
  const shellHtml = generateProdIndexHtml(entryChunk, cssChunks);

  // ── 5. Prime the renderer for production mode ─────────────────────────────
  // CRITICAL: must be called before any prerenderSSG invocation.
  // Without this, prepareRender() tries to fetch the dev HMR template.
  __setDevMode(false);
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
  await runWithConcurrency(tasks, STATIC_CONCURRENCY);

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
