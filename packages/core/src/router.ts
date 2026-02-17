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
  page: RuntimePage;
  routeChain: RuntimeRoute[];
  /** File paths of route.tsx files in the chain (same order as routeChain) */
  routeFilePaths: (string | undefined)[];
  mode: "ssr" | "ssg" | "isr";
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  ssgHtml?: string;
}

export function createRoutePlugin(route: ResolvedRoute, config: StaticOptions<string>): AnyElysia {
  const { pattern, mode, routeChain, page } = route;

  const plugins: AnyElysia[] = [];

  // 1. Merge params/query schemas from the full route chain
  const allParams = routeChain.find((r) => r.params)?.params;
  const allQuery = routeChain.find((r) => r.query)?.query;
  if (allParams || allQuery) {
    plugins.push(
      new Elysia().guard({ params: allParams as AnySchema, query: allQuery as AnySchema })
    );
  }

  // 2. Chain .resolve() for each ancestor route loader (top-down, flat accumulation)
  for (const ancestor of routeChain) {
    if (ancestor.loader) {
      const loaderFn = ancestor.loader;
      plugins.push(new Elysia().resolve(async (ctx) => loaderFn(ctx)));
    }
  }

  // 3. Chain .resolve() for the page's own loader
  if (page.loader) {
    const pageLoaderFn = page.loader;
    plugins.push(new Elysia().resolve(async (ctx) => pageLoaderFn(ctx)));
  }

  // 4. GET handler
  plugins.push(
    new Elysia().get(pattern, async (ctx) => {
      switch (mode) {
        case "ssg": {
          const html = await prerenderSSG(route, ctx.params ?? {}, config);
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        }

        case "isr":
          return handleISR(route, ctx, config);

        default:
          return renderSSR(route, ctx, config);
      }
    })
  );

  return plugins.reduce((app, plugin) => app.use(plugin), new Elysia());
}

/**
 * Scan the pages directory and resolve all routes.
 *
 * File-based routing conventions:
 * - `index.tsx`       → `/`
 * - `about.tsx`       → `/about`
 * - `blog/index.tsx`  → `/blog`
 * - `blog/[slug].tsx` → `/blog/:slug`
 * - `[...catch].tsx`  → `/*` (catch-all)
 * - `_hidden.tsx`     → ignored (underscore prefix)
 * - `route.tsx`       → skipped (imported by page files via parent)
 */
export const scanPages = async (pagesDir: string) => {
  const routes: ResolvedRoute[] = [];

  // Phase 1: Scan route.tsx files to build identity → file path map
  const routeFileMap = new Map<RuntimeRoute, string>();
  const routeGlob = new Glob("**/route.tsx");
  for await (const absolutePath of routeGlob.scan({ cwd: pagesDir, absolute: true })) {
    const mod = await import(absolutePath);
    const routeExport = mod.route ?? mod.default;
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

    // Skip underscore-prefixed files and route.tsx files
    if (fileName.startsWith("_") || fileName === "route") {
      continue;
    }

    const page = (await import(absolutePath)).default;
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
      path: absolutePath,
      routeChain,
      routeFilePaths,
      mode: resolveMode(page, routeChain),
    });
  }

  return routes;
};

function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;

  // Explicit mode always wins
  if (routeConfig.mode) {
    return routeConfig.mode;
  }

  // Check if any loader exists in the chain or on the page
  const hasLoader = routeChain.some((r) => r.loader) || !!page.loader;

  if (!hasLoader) {
    return "ssg";
  }

  // Has revalidate → ISR
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
