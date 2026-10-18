// biome-ignore-all lint/performance/noAwaitInLoops: SSG cache generation runs routes sequentially for deterministic cache output
import type { SsgCacheEntry } from "../server/cache/index.ts";
import { prerenderRoute, prerenderSSG } from "../server/render/index.ts";
import { hasRequestLoader } from "../server/render/loaders.ts";
import { expandStaticPaths, hasStaticParams } from "../server/render/static-params.ts";
import { buildRouteMatcher, resolveDocumentMode } from "../server/router/patterns.ts";
import { createSearchRouteMetadata } from "../server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";

export type SSGCacheSnapshot = Record<string, SsgCacheEntry>;

export interface RoutePrerender {
  path: string;
  /** Deferred targets are materialized later by the exact production bundle. */
  result?: SsgCacheEntry | Response;
  route: ResolvedRoute;
}

function hasRequestDependentInput(route: ResolvedRoute, root: RootLayout): boolean {
  return [root.route, ...route.routeChain].some(
    (routeConfig) =>
      routeConfig.query !== undefined
  );
}

/**
 * Renders every selected route URL known at build time. Fixed routes are always
 * known; dynamic routes contribute the values returned by staticParams(). ISR
 * routes with query schemas stay on-demand. PPR paths are collected here, then
 * rendered by the production bundle so React's postponed tree matches at runtime.
 * Vercel defers all rendering to preserve the final application's runtime configuration.
 */
export async function buildRoutePrerenders(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  basePath: string,
  deferRendering?: boolean
): Promise<RoutePrerender[]> {
  const prerenders: RoutePrerender[] = [];
  const searchRoutes = createSearchRouteMetadata(routes);
  const matchRoute = buildRouteMatcher(routes);

  for (const route of routes) {
    const documentMode = resolveDocumentMode(route);
    if (documentMode === "ssr") {
      continue;
    }
    if (hasRequestDependentInput(route, root)) {
      continue;
    }

    const paths = await expandStaticPaths(route, matchRoute, origin);
    for (const { params, path } of paths ?? []) {
      if (deferRendering || root.route.requestLoader !== undefined || hasRequestLoader(route)) {
        prerenders.push({ path, route });
        continue;
      }
      const result =
        documentMode === "ssg"
          ? await prerenderSSG(route, params, root, origin, basePath, searchRoutes)
          : await prerenderRoute(
              route,
              params,
              root,
              origin,
              "isr",
              basePath,
              searchRoutes
            );
      prerenders.push({ path, result, route });
    }
  }

  return prerenders;
}

export async function buildSSGCacheSnapshot(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  basePath?: string
): Promise<SSGCacheSnapshot> {
  const snapshot: SSGCacheSnapshot = {};
  const searchRoutes = createSearchRouteMetadata(routes);
  const matchRoute = buildRouteMatcher(routes);

  for (const route of routes) {
    if (
      resolveDocumentMode(route) !== "ssg" ||
      !hasStaticParams(route) ||
      hasRequestLoader(route)
    ) {
      continue;
    }
    const paths = await expandStaticPaths(route, matchRoute, origin);
    for (const { params, path } of paths ?? []) {
      const result = await prerenderSSG(
        route,
        params,
        root,
        origin,
        basePath,
        searchRoutes
      );
      if (!(result instanceof Response)) {
        snapshot[path] = result;
      }
    }
  }
  return snapshot;
}
