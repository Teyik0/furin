import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { type AnyElysia, type Context, Elysia } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimePage, RuntimeRoute } from "./client.ts";
import { type CompileContext, getCompileContext } from "./internal.ts";
import { resolvePath } from "./render/assemble.ts";
import { handleISR, prerenderSSG, renderSSR } from "./render/index.ts";
import { IS_DEV } from "./runtime-env.ts";
import {
  collectRouteChainFromRoute,
  isFurinPage,
  isFurinRoute,
  validateRouteChain,
} from "./utils.ts";

export interface ResolvedRoute {
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  mode: "ssr" | "ssg" | "isr";
  page: RuntimePage;
  path: string;
  pattern: string;
  routeChain: RuntimeRoute[];
  ssgHtml?: string;
}

export interface RootLayout {
  path: string;
  route: RuntimeRoute;
}

export function loadProdRoutes(ctx: CompileContext): {
  root: RootLayout;
  routes: ResolvedRoute[];
} {
  const rootMod = ctx.modules[ctx.rootPath] as Record<string, unknown>;
  const rootExport = rootMod.route ?? rootMod.default;
  if (!(rootExport && isFurinRoute(rootExport) && rootExport.layout)) {
    throw new Error("[furin] root.tsx: createRoute() with layout not found in CompileContext.");
  }
  const root: RootLayout = { path: ctx.rootPath, route: rootExport };

  const routes: ResolvedRoute[] = [];
  for (const { pattern, path, mode } of ctx.routes) {
    const pageMod = ctx.modules[path] as { default: RuntimePage };
    const page: RuntimePage = pageMod.default;
    if (!isFurinPage(page)) {
      throw new Error(`[furin] ${path}: invalid page module in CompileContext.`);
    }
    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
    validateRouteChain(routeChain, root.route, path);
    routes.push({ pattern, page, path, routeChain, mode });
  }

  return { root, routes };
}

export async function scanPages(pagesDir: string): Promise<{
  root: RootLayout;
  routes: ResolvedRoute[];
}> {
  const root = await scanRootLayout(pagesDir);
  const routes = await scanPageFiles(pagesDir, root);
  return { root, routes };
}

export async function scanRootLayout(pagesDir: string): Promise<RootLayout> {
  const rootPath = `${pagesDir}/root.tsx`;
  const ctx = getCompileContext();
  if (!(existsSync(rootPath) || ctx?.modules[rootPath])) {
    throw new Error("[furin] root.tsx: not found.");
  }

  const mod = (ctx?.modules[rootPath] ?? (await import(rootPath))) as Record<string, unknown>;
  const rootExport = mod.route ?? mod.default;
  if (!(rootExport && isFurinRoute(rootExport))) {
    throw new Error("[furin] root.tsx: createRoute() export not found.");
  }

  if (!rootExport.layout) {
    throw new Error("[furin] root.tsx: createRoute() has no layout.");
  }
  return { path: rootPath, route: rootExport };
}

async function scanPageFiles(pagesDir: string, root: RootLayout): Promise<ResolvedRoute[]> {
  const routes: ResolvedRoute[] = [];

  for (const absolutePath of await collectPageFilePaths(pagesDir)) {
    if (![".tsx", ".ts", ".jsx", ".js"].some((ext) => absolutePath.endsWith(ext))) {
      continue;
    }

    const relativePath = absolutePath.replace(`${pagesDir}/`, "");
    const fileName = parse(relativePath).name;

    // Skip root.tsx, and files starting with _
    if (fileName.startsWith("_") || fileName === "root") {
      continue;
    }

    if (IS_DEV) {
      routes.push(await buildDevRoute(absolutePath, relativePath, root));
      continue;
    }

    const ctx = getCompileContext();
    const pageMod = (ctx?.modules[absolutePath] ?? (await import(absolutePath))) as {
      default: RuntimePage;
    };
    const page: RuntimePage = pageMod.default;
    if (!isFurinPage(page)) {
      throw new Error(`[furin] ${relativePath}: no valid createRoute().page() export found`);
    }

    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);

    validateRouteChain(routeChain, root.route, relativePath);

    routes.push({
      pattern: filePathToPattern(relativePath),
      page,
      path: absolutePath,
      routeChain,
      mode: resolveMode(page, routeChain),
    });
  }

  return routes;
}

async function buildDevRoute(
  absolutePath: string,
  relativePath: string,
  root: RootLayout
): Promise<ResolvedRoute> {
  // Import via the virtual namespace (registerDevPagePlugin must be called first)
  // so page files stay out of --hot's module graph. We still extract the route
  // chain at startup for type generation, guards, and mode resolution — matching
  // prod behavior exactly.
  let page: RuntimePage | undefined;
  let routeChain: RuntimeRoute[] = [];

  try {
    const pageMod = (await import(`${absolutePath}?furin-server&t=${Date.now()}`)) as {
      default: RuntimePage;
    };
    if (isFurinPage(pageMod.default)) {
      page = pageMod.default;
      routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
      validateRouteChain(routeChain, root.route, relativePath);
    }
  } catch {
    // Page will be loaded on first request in createRoutePlugin as fallback
  }

  // Dev stub: a minimal RuntimePage that passes isFurinPage() but is never
  // actually rendered — createRoutePlugin always re-imports from disk in dev mode.
  const devStubPage: RuntimePage = {
    __type: "FURIN_PAGE",
    _route: { __type: "FURIN_ROUTE" },
    component: () => null,
  };

  return {
    pattern: filePathToPattern(relativePath),
    path: absolutePath,
    mode: page ? resolveMode(page, routeChain) : "ssr",
    // Still lazily re-imported on each request in createRoutePlugin for fresh code
    page: page ?? devStubPage,
    routeChain,
  };
}

// ── Query-default redirect ──────────────────────────────────────────────────
// Validator-agnostic: after Elysia applies defaults (TypeBox, Zod, Valibot…),
// compare the raw URL query keys with the resolved ctx.query keys. If ctx.query
// contains keys absent from the URL, defaults were applied → 302 redirect to
// the canonical URL so the address bar always reflects the actual app state.

/** @internal Exported for unit testing. */
export function queryDefaultRedirectHook({ request, query, status, set }: Context) {
  const resolvedQuery = query as Record<string, unknown>;
  const queryKeys = Object.keys(resolvedQuery);
  if (queryKeys.length === 0) {
    return;
  }

  const rawParams = new URL(request.url).searchParams;

  let needsRedirect = false;
  for (const key of queryKeys) {
    if (!rawParams.has(key) && resolvedQuery[key] != null) {
      needsRedirect = true;
      break;
    }
  }
  if (!needsRedirect) {
    return;
  }

  const url = new URL(request.url);
  for (const [k, v] of Object.entries(resolvedQuery)) {
    if (v != null) {
      url.searchParams.set(k, String(v));
    }
  }

  set.headers.location = url.pathname + url.search;
  return status("Found");
}

/** @internal Handles a request in dev mode — re-imports the page fresh on every request. */
async function handleDevRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<unknown> {
  // Load the page via ?furin-server virtual namespace so it stays out of
  // --hot's file watcher, then hand off to renderSSR which runs loaders,
  // renders React to HTML, and injects __FURIN_DATA__.
  try {
    let currentRoot = root;
    const rootMod = (await import(`${root.path}?furin-server&t=${Date.now()}`)) as Record<
      string,
      unknown
    >;
    const rootExport = rootMod.route ?? rootMod.default;
    if (rootExport && isFurinRoute(rootExport) && rootExport.layout) {
      currentRoot = { path: root.path, route: rootExport };
    }

    const pageMod = await import(`${route.path}?furin-server&t=${Date.now()}`);
    const page = pageMod.default;
    if (page && isFurinPage(page)) {
      const chain = collectRouteChainFromRoute(page._route as RuntimeRoute);
      return renderSSR({ ...route, page, routeChain: chain }, ctx, currentRoot);
    }
  } catch (err) {
    console.error(`[furin] Dev page load error for ${route.path}:`, err);
  }
  // Fallback: page couldn't load — return a clear error response rather than
  // delegating to renderSSR with an undefined page.
  return new Response(
    `<!doctype html><html><body><h1>Page load error</h1><p>Could not load ${route.path}. Check the server console for details.</p></body></html>`,
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/** @internal Handles a production SSG route — sets ETags, Cache-Control, and Cache-Tag. */
async function handleSSGRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string
): Promise<unknown> {
  const origin = new URL(ctx.request.url).origin;
  const entry = await prerenderSSG(route, ctx.params, root, origin);

  // Loader issued a redirect — forward it directly to the client.
  if (entry instanceof Response) {
    return entry;
  }

  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});

  // ETag: "buildId:cachedAt" — unique per render cycle, changes after revalidatePath
  const etag = buildId ? `"${buildId}:${entry.cachedAt}"` : null;
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  // Browser: max-age=0 + must-revalidate → always validates via ETag (304 = free)
  // CDN:     s-maxage=31536000 → cache for 1 year, purge via revalidatePath + purger
  ctx.set.headers["cache-control"] = "public, max-age=0, must-revalidate, s-maxage=31536000";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.headers["cache-tag"] = resolvedPath;
  return entry.html;
}

export function createRoutePlugin(route: ResolvedRoute, root: RootLayout, buildId = ""): AnyElysia {
  const { pattern, routeChain } = route;

  // TODO: merge schemas from all routeChain entries (requires TypeBox t.Object/t.Composite)
  // For now, prefer the leaf route's schema (last in chain) over ancestor routes.
  const allParams = routeChain.findLast((r) => r.params)?.params;
  const allQuery = routeChain.findLast((r) => r.query)?.query;
  const hasQuerySchema = !!allQuery;

  // Guard and handler MUST live in the same Elysia scope so that validation
  // (including default-filling) applies to the route handler's ctx.query.
  const plugin = new Elysia();

  if (allParams || allQuery) {
    plugin.guard({
      params: allParams as AnySchema,
      query: allQuery as AnySchema,
    });
  }

  plugin.get(pattern, (ctx) => {
    // Redirect when Elysia applied query defaults (validator-agnostic)
    if (hasQuerySchema) {
      const redirect = queryDefaultRedirectHook(ctx);
      if (redirect) {
        return redirect;
      }
    }

    if (IS_DEV) {
      return handleDevRequest(route, ctx, root);
    }

    if (route.mode === "ssg") {
      return handleSSGRequest(route, ctx, root, buildId);
    }

    if (route.mode === "isr") {
      ctx.set.headers["cache-tag"] = resolvePath(route.pattern, ctx.params ?? {});
      return handleISR(route, ctx, root, buildId);
    }

    return renderSSR(route, ctx, root);
  });

  return plugin;
}

async function collectPageFilePaths(dir: string): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectPageFilePaths(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;

  if (routeConfig.mode) {
    return routeConfig.mode;
  }

  const hasLoader = routeChain.some((r) => r.loader) || !!page.loader;

  if (!hasLoader) {
    return "ssg";
  }

  if (routeConfig.revalidate && routeConfig.revalidate > 0) {
    return "isr";
  }

  return "ssr";
}

export function filePathToPattern(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const segments: string[] = [];

  for (const part of parts) {
    const name = parse(part).name;

    if (name === "index") {
      continue;
    }

    if (name.startsWith("[") && name.endsWith("]")) {
      const inner = name.slice(1, -1);

      if (inner.startsWith("...")) {
        segments.push("*");
        continue;
      }

      segments.push(`:${inner}`);
      continue;
    }

    segments.push(name);
  }

  return `/${segments.join("/")}`;
}
