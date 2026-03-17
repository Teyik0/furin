import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimePage, RuntimeRoute } from "./client.ts";
import { type CompileContext, getCompileContext } from "./internal.ts";
import { handleISR, prerenderSSG, renderSSR } from "./render/index.ts";
import { getBuildId } from "./render/cache.ts";
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

export function createRoutePlugin(route: ResolvedRoute, root: RootLayout): AnyElysia {
  const { pattern, mode, routeChain } = route;

  const plugins: AnyElysia[] = [];

  const allParams = routeChain.find((r) => r.params)?.params;
  const allQuery = routeChain.find((r) => r.query)?.query;
  if (allParams || allQuery) {
    plugins.push(
      new Elysia().guard({
        params: allParams as AnySchema,
        query: allQuery as AnySchema,
      })
    );
  }

  plugins.push(
    new Elysia().get(pattern, async (ctx) => {
      switch (mode) {
        case "ssg": {
          const buildId = getBuildId();
          const etag = buildId ? `"${buildId}"` : null;
          if (etag && ctx.request.headers.get("if-none-match") === etag) {
            ctx.set.status = 304;
            return;
          }
          ctx.set.headers["content-type"] = "text/html; charset=utf-8";
          ctx.set.headers["cache-control"] = "public, max-age=0, must-revalidate";
          if (etag) ctx.set.headers["etag"] = etag;
          const origin = new URL(ctx.request.url).origin;
          return await prerenderSSG(route, ctx.params, root, origin);
        }

        case "isr":
          return handleISR(route, ctx, root);

        default:
          return renderSSR(route, ctx, root);
      }
    })
  );

  return plugins.reduce((app, plugin) => app.use(plugin), new Elysia());
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

export async function scanPages(pagesDir: string): Promise<{
  root: RootLayout;
  routes: ResolvedRoute[];
}> {
  const ctx = getCompileContext();
  if (ctx) {
    return loadProdRoutes(ctx);
  }
  const root = await scanRootLayout(pagesDir);
  const routes = await scanPageFiles(pagesDir, root);
  return { root, routes };
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
