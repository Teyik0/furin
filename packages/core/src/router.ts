import { parse } from "node:path";
import type { StaticOptions } from "@elysiajs/static/types";
import { Glob } from "bun";
import { type AnyElysia, Elysia } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimePage, RuntimeRoute } from "./client";
import { handleISR, prerenderSSG, renderSSR } from "./render";
import { collectRouteChain, isElysionPage, isElysionRoute } from "./utils";

export interface ResolvedRoute {
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  mode: "ssr" | "ssg" | "isr";
  page?: RuntimePage;
  pagePath: string;
  path: string;
  pattern: string;
  routeChain: RuntimeRoute[];
  routeFilePaths: (string | undefined)[];
  ssgHtml?: string;
}

export interface RootLayout {
  path: string;
  route: RuntimeRoute;
}

export function createRoutePlugin(
  route: ResolvedRoute,
  config: StaticOptions<string>,
  root: RootLayout | null,
  dev = false
): AnyElysia {
  const { pattern, mode, routeChain } = route;

  const plugins: AnyElysia[] = [];

  const allParams = routeChain.find((r) => r.params)?.params;
  const allQuery = routeChain.find((r) => r.query)?.query;
  if (allParams || allQuery) {
    plugins.push(
      new Elysia().guard({ params: allParams as AnySchema, query: allQuery as AnySchema })
    );
  }

  for (const ancestor of routeChain) {
    if (ancestor.loader) {
      const loaderFn = ancestor.loader;
      plugins.push(new Elysia().resolve(async (ctx) => loaderFn(ctx)));
    }
  }

  plugins.push(
    new Elysia().get(pattern, async (ctx) => {
      switch (mode) {
        case "ssg": {
          ctx.set.headers["content-type"] = "text/html; charset=utf-8";
          ctx.set.headers["cache-control"] = "public, max-age=0, must-revalidate";
          return await prerenderSSG(route, ctx.params ?? {}, config, root, dev);
        }

        case "isr":
          return handleISR(route, ctx, config, root, dev);

        default:
          return renderSSR(route, ctx, config, root, dev);
      }
    })
  );

  return plugins.reduce((app, plugin) => app.use(plugin), new Elysia());
}

async function loadPageModule(pagePath: string): Promise<RuntimePage> {
  const mod = await import(pagePath);
  return mod.default;
}

async function loadRouteModule(routePath: string): Promise<RuntimeRoute | undefined> {
  const mod = await import(routePath);
  return mod.route ?? mod.default;
}

// ---------------------------------------------------------------------------
// scanPages helpers — each kept under the complexity budget
// ---------------------------------------------------------------------------

async function scanRootLayout(pagesDir: string): Promise<RootLayout | null> {
  const rootPath = `${pagesDir}/root.tsx`;
  const rootFile = Bun.file(rootPath);
  if (!(await rootFile.exists())) {
    return null;
  }

  const mod = await import(rootPath);
  const rootExport = mod.route ?? mod.default;
  if (!(rootExport && isElysionRoute(rootExport))) {
    return null;
  }

  if (!rootExport.layout) {
    console.warn(
      "[elysion] root.tsx: createRoute() has no layout — the root layout will be skipped."
    );
  }
  return { path: rootPath, route: rootExport };
}

async function scanRouteFiles(
  pagesDir: string,
  root: RootLayout | null
): Promise<Map<RuntimeRoute, string>> {
  const routeFileMap = new Map<RuntimeRoute, string>();
  // Pre-register root so its path appears in routeFilePaths (enables dedup in render/build)
  if (root) {
    routeFileMap.set(root.route, root.path);
  }
  const routeGlob = new Glob("**/route.tsx");
  for await (const absolutePath of routeGlob.scan({ cwd: pagesDir, absolute: true })) {
    const routeExport = await loadRouteModule(absolutePath);
    if (routeExport && isElysionRoute(routeExport)) {
      routeFileMap.set(routeExport, absolutePath);
    }
  }
  return routeFileMap;
}

async function scanPageFiles(
  pagesDir: string,
  routeFileMap: Map<RuntimeRoute, string>
): Promise<ResolvedRoute[]> {
  const routes: ResolvedRoute[] = [];
  const glob = new Glob("**/*.tsx");

  for await (const absolutePath of glob.scan({ cwd: pagesDir, absolute: true })) {
    if (![".tsx", ".ts", ".jsx", ".js"].some((ext) => absolutePath.endsWith(ext))) {
      continue;
    }

    const relativePath = absolutePath.replace(`${pagesDir}/`, "");
    const fileName = parse(relativePath).name;

    // Skip root.tsx, route.tsx, and files starting with _
    if (fileName.startsWith("_") || fileName === "route" || fileName === "root") {
      continue;
    }

    const page = await loadPageModule(absolutePath);
    if (!isElysionPage(page)) {
      console.warn(
        `[elysion] Skipping ${relativePath}: no valid createRoute().page() export found`
      );
      continue;
    }

    const routeChain = collectRouteChain(page);
    const routeFilePaths = routeChain.map((r) => routeFileMap.get(r));

    routes.push({
      pattern: filePathToPattern(relativePath),
      page,
      pagePath: absolutePath,
      path: absolutePath,
      routeChain,
      routeFilePaths,
      mode: resolveMode(page, routeChain),
    });
  }

  return routes;
}

export async function scanPages(
  pagesDir: string,
  _dev = false
): Promise<{
  root: RootLayout | null;
  routes: ResolvedRoute[];
}> {
  const root = await scanRootLayout(pagesDir);
  const routeFileMap = await scanRouteFiles(pagesDir, root);
  const routes = await scanPageFiles(pagesDir, routeFileMap);
  return { root, routes };
}

function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
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

function filePathToPattern(path: string): string {
  const parts = path.split("/");
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

import.meta.hot.accept();
