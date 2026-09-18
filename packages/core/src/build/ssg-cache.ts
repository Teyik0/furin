// biome-ignore-all lint/performance/noAwaitInLoops: SSG cache generation runs routes sequentially for deterministic cache output
import type { SsgCacheEntry } from "../server/cache/index.ts";
import { resolvePath } from "../server/render/assemble.ts";
import { prerenderRoute, prerenderSSG } from "../server/render/index.ts";
import { hasRequestLoader } from "../server/render/loaders.ts";
import { buildRouteMatcher } from "../server/router/patterns.ts";
import { createSearchRouteMetadata } from "../server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";

export type SSGCacheSnapshot = Record<string, SsgCacheEntry>;

export interface RoutePrerender {
  path: string;
  /** PPR targets are materialized later by the exact production bundle. */
  result?: SsgCacheEntry | Response;
  route: ResolvedRoute;
}

const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;

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
 */
export async function buildRoutePrerenders(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  basePath: string
): Promise<RoutePrerender[]> {
  const prerenders: RoutePrerender[] = [];
  const searchRoutes = createSearchRouteMetadata(routes);
  const matchRoute = buildRouteMatcher(routes);

  for (const route of routes) {
    if (route.mode === "ssr") {
      continue;
    }
    if (hasRequestDependentInput(route, root)) {
      continue;
    }

    let paramSets: Record<string, string>[];
    if (!DYNAMIC_SEGMENT_RE.test(route.pattern)) {
      paramSets = [{}];
    } else if (route.page.staticParams) {
      const resolvedParams = await route.page.staticParams();
      if (!Array.isArray(resolvedParams)) {
        throw new TypeError(
          `[furin] staticParams() for "${route.pattern}" must return an array.`
        );
      }
      paramSets = resolvedParams;
    } else {
      continue;
    }

    for (const params of paramSets) {
      const path = resolvePath(route.pattern, params);
      if (matchRoute(path)?.route !== route) {
        continue;
      }
      if (hasRequestLoader(route)) {
        prerenders.push({ path, route });
        continue;
      }
      const result =
        route.mode === "ssg"
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

  for (const route of routes) {
    if (route.mode !== "ssg" || !route.page.staticParams || hasRequestLoader(route)) {
      continue;
    }
    const paramSets = await route.page.staticParams();
    for (const params of paramSets) {
      const result = await prerenderSSG(
        route,
        params,
        root,
        origin,
        basePath,
        searchRoutes
      );
      if (!(result instanceof Response)) {
        snapshot[resolvePath(route.pattern, params)] = result;
      }
    }
  }
  return snapshot;
}
