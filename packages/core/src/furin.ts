import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import type { EmbeddedAppData } from "./internal.ts";
import { getCompileContext } from "./internal.ts";
import { consumePendingInvalidations, getBuildId, setBuildId } from "./render/cache.ts";
import { warmSSGCache } from "./render/index.ts";
import { setProductionTemplateContent, setProductionTemplatePath } from "./render/template.ts";
import { createRoutePlugin, loadProdRoutes, scanPages } from "./router.ts";
import { IS_DEV } from "./runtime-env.ts";

function resolveClientDirFromArgv(): string {
  return (
    resolveClientDirFromEnv() ??
    resolveClientDirFromModuleUrl() ??
    resolveClientDirFromProcessArgs() ??
    resolveFallbackClientDir()
  );
}

function resolveClientDirFromEnv(): string | null {
  const envClientDir = process.env.FURIN_CLIENT_DIR;
  if (!envClientDir) {
    return null;
  }
  return envClientDir.startsWith("/") ? envClientDir : resolve(process.cwd(), envClientDir);
}

function resolveClientDirFromModuleUrl(): string | null {
  try {
    const moduleUrl = new URL(import.meta.url);
    if (moduleUrl.protocol !== "file:") {
      return null;
    }
    const modulePath = fileURLToPath(moduleUrl);
    if (modulePath.includes("/$bunfs/")) {
      return null;
    }
    const moduleClientDir = join(dirname(modulePath), "client");
    if (existsSync(join(moduleClientDir, "index.html"))) {
      return moduleClientDir;
    }
  } catch {
    // ignore, fallback to argv-based resolution
  }
  return null;
}

function resolveClientDirFromProcessArgs(): string | null {
  const candidates = [
    process.argv[1],
    process.argv[0],
    (process as { argv0?: string }).argv0,
    process.execPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const resolved = resolveClientDirFromCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveClientDirFromCandidate(candidate: string): string | null {
  const name = basename(candidate);
  if (name === "bun" || name === "node") {
    return null;
  }
  if (candidate.includes("/$bunfs/") || candidate.startsWith("bunfs:")) {
    return null;
  }

  const absolute = candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
  if (existsSync(absolute)) {
    return join(dirname(absolute), "client");
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string): string | null {
  const pathEntries = process.env.PATH?.split(":") ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      return join(dirname(fullPath), "client");
    }
  }
  return null;
}

function resolveFallbackClientDir(): string {
  const defaultClientDir = resolve(process.cwd(), ".furin/build/bun/client");
  if (existsSync(join(defaultClientDir, "index.html"))) {
    return defaultClientDir;
  }

  return join(process.cwd(), "client");
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  clientDir: string
): Promise<void> {
  if (embedded) {
    if (!embedded.template) {
      throw new Error("[furin] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(embedded.template).text();
    setProductionTemplateContent(html);
    return;
  }

  const templatePath = join(clientDir, "index.html");
  if (!existsSync(templatePath)) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  setProductionTemplatePath(templatePath);
}

function buildEmbedInstance(
  instanceName: string,
  resolvedPagesDir: string,
  embedded: EmbeddedAppData
): Elysia {
  const { assets } = embedded;
  const immutableHeaders = { "Cache-Control": "public, max-age=31536000, immutable" };
  // Explicit wildcard route — lifecycle hooks don't fire for unmatched routes.
  return new Elysia({ name: instanceName, seed: resolvedPagesDir })
    .get("/_client/*", ({ params }) => {
      const filePath = assets[`/_client/${params["*"]}`];
      return filePath
        ? new Response(Bun.file(filePath), { headers: immutableHeaders })
        : new Response("Not Found", { status: 404 });
    })
    .get("/public/*", ({ params }) => {
      const filePath = assets[`/public/${params["*"]}`];
      return filePath
        ? new Response(Bun.file(filePath))
        : new Response("Not Found", { status: 404 });
    }) as unknown as Elysia;
}

async function buildDiskInstance(
  instanceName: string,
  resolvedPagesDir: string,
  clientDir: string,
  publicDir: string
): Promise<Elysia> {
  let instance = new Elysia({ name: instanceName, seed: resolvedPagesDir });

  if (existsSync(publicDir)) {
    instance = instance.use(await staticPlugin({ assets: publicDir, prefix: "/public" }));
  }

  instance = instance.use(
    await staticPlugin({
      assets: clientDir,
      prefix: "/_client",
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    })
  );
  return instance;
}

/**
 * Main Furin plugin.
 *
 * Returns a standalone Elysia instance (async function) so that routes are
 * properly registered in Elysia's router for SPA navigation to work.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await furin({ ... }))
 *   .listen(3000)
 * ```
 */
export async function furin({ pagesDir }: { pagesDir?: string }) {
  const cwd = process.cwd();
  const ctx = getCompileContext();
  const resolvedPagesDir = ctx?.rootPath
    ? dirname(ctx.rootPath)
    : resolve(cwd, pagesDir ?? "src/pages");

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `furin-${resolvedPagesDir.replaceAll("\\", "/")}`;

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    const furinDir = resolve(cwd, ".furin");
    const { root, routes } = await scanPages(resolvedPagesDir);
    console.info(
      `[furin] Configuration: ${routes.length} page(s) — ${IS_DEV ? "dev (Bun HMR)" : "production"}`
    );
    for (const route of routes) {
      const hasLayout = route.routeChain.some((r) => r.layout);
      console.info(
        `  ${route.mode.toUpperCase().padEnd(4)} ${route.pattern}${hasLayout ? " + layout" : ""}`
      );
    }
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { writeDevFiles } = await import("./build/hydrate.ts");
    writeDevFiles(routes, { outDir: furinDir, rootLayout: root.path });

    let instance = new Elysia({ name: instanceName, seed: resolvedPagesDir })
      .use(await staticPlugin({ assets: furinDir, prefix: "/_bun_hmr_entry" }))
      .use(await staticPlugin());

    for (const route of routes) {
      instance = instance.use(createRoutePlugin(route, root));
    }

    instance = instance.onAfterHandle(({ set }) => {
      const paths = consumePendingInvalidations();
      if (paths.length > 0) {
        set.headers["x-furin-revalidate"] = paths.join(",");
      }
    });

    return instance;
  }

  // ── Production ─────────────────────────────────────────────────────────
  if (!ctx) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  const { root, routes } = loadProdRoutes(ctx);

  setBuildId(ctx.buildId ?? "");

  const embedded = ctx?.embedded;
  const clientDir = embedded ? "" : resolveClientDirFromArgv();
  const publicDir = embedded ? "" : join(dirname(clientDir), "public");

  await setupProdTemplate(embedded, clientDir);

  let instance = embedded
    ? buildEmbedInstance(instanceName, resolvedPagesDir, embedded)
    : await buildDiskInstance(instanceName, resolvedPagesDir, clientDir, publicDir);

  for (const route of routes) {
    instance = instance.use(createRoutePlugin(route, root));
  }

  // Pre-render SSG routes with staticParams before the first request arrives.
  const ssgTargets = routes.filter((r) => r.mode === "ssg" && r.page?.staticParams);
  if (ssgTargets.length > 0) {
    instance = instance.onStart(async ({ server }) => {
      const origin = server?.url?.origin ?? "http://localhost:3000";
      console.log(`[furin] Warming SSG cache for ${ssgTargets.length} route(s)…`);
      await warmSSGCache(ssgTargets, root, origin);
      console.log("[furin] SSG warm-up complete.");
    });
  }

  instance = instance.onAfterHandle(({ set }) => {
    const paths = consumePendingInvalidations();
    if (paths.length > 0) {
      set.headers["x-furin-revalidate"] = paths.join(",");
    }
    const buildId = getBuildId();
    if (buildId) {
      set.headers["x-furin-build-id"] = buildId;
    }
  });

  return instance;
}

import type { RouteManifest } from "./link.tsx";
import { revalidatePath as _revalidatePath } from "./render/cache.ts";

/**
 * Programmatically invalidate the cache for a given path.
 *
 * - `type: 'page'` (default): invalidates the exact URL only.
 * - `type: 'layout'`: invalidates the path and all nested paths (prefix match).
 *
 * Works for ISR and SSG routes. SSR routes are always fresh (no server-side cache),
 * but calling this still queues a client-side prefetch invalidation via
 * the `X-Furin-Revalidate` response header.
 *
 * @returns `true` if at least one server-side cache entry was removed.
 *
 * @example
 * ```ts
 * // In an API route or webhook handler:
 * import { revalidatePath } from "@teyik0/furin";
 *
 * revalidatePath("/blog/my-post");               // invalidate a single page
 * revalidatePath("/blog", "layout");             // invalidate /blog + all children
 * ```
 */
export function revalidatePath(
  path: keyof RouteManifest extends never ? string : keyof RouteManifest | (string & {}),
  type?: "page" | "layout"
): boolean {
  return _revalidatePath(path, type);
}
