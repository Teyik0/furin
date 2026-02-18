import { parse } from "node:path";
import type { StaticOptions } from "@elysiajs/static/types";
import { Glob } from "bun";
import { type AnyElysia, Elysia } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimePage, RuntimeRoute } from "./client";
import { handleISR, prerenderSSG, renderSSR } from "./render";
import { collectRouteChain, isElysionPage, isElysionRoute } from "./types";

export interface ResolvedRoute {
  pattern: string;
  path: string;
  page?: RuntimePage;
  pagePath: string;
  routeChain: RuntimeRoute[];
  routeFilePaths: (string | undefined)[];
  mode: "ssr" | "ssg" | "isr";
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  ssgHtml?: string;
}

export function createRoutePlugin(
  route: ResolvedRoute,
  config: StaticOptions<string>,
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
          const html = await prerenderSSG(route, ctx.params ?? {}, config, dev);
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        }

        case "isr":
          return handleISR(route, ctx, config, dev);

        default:
          return renderSSR(route, ctx, config, dev);
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

export async function scanPages(pagesDir: string, _dev = false) {
  const routes: ResolvedRoute[] = [];

  // Phase 1: Scan route.tsx files
  const routeFileMap = new Map<RuntimeRoute, string>();
  const routeGlob = new Glob("**/route.tsx");
  for await (const absolutePath of routeGlob.scan({ cwd: pagesDir, absolute: true })) {
    const routeExport = await loadRouteModule(absolutePath);
    if (routeExport && isElysionRoute(routeExport)) {
      routeFileMap.set(routeExport, absolutePath);
    }
  }

  // Phase 2: Scan page files
  const glob = new Glob("**/*.tsx");
  for await (const absolutePath of glob.scan({ cwd: pagesDir, absolute: true })) {
    if (![".tsx", ".ts", ".jsx", ".js"].some((ext) => absolutePath.endsWith(ext))) {
      continue;
    }

    const relativePath = absolutePath.replace(`${pagesDir}/`, "");
    const fileName = parse(relativePath).name;

    if (fileName.startsWith("_") || fileName === "route") {
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

// HMR: Accept hot module replacement
if (import.meta.hot) {
  import.meta.hot.accept();
}
