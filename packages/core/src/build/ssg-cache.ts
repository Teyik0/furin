// biome-ignore-all lint/performance/noAwaitInLoops: SSG cache generation runs routes sequentially for deterministic cache output
import type { SsgCacheEntry } from "../server/cache/index.ts";
import { resolvePath } from "../server/render/assemble.ts";
import { prerenderSSG } from "../server/render/index.ts";
import { createSearchRouteMetadata } from "../server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";

export type SSGCacheSnapshot = Record<string, SsgCacheEntry>;

export interface SSGPrerender {
  path: string;
  result: SsgCacheEntry | Response;
  route: ResolvedRoute;
}

const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;

/**
 * Renders every SSG URL known at build time. Fixed routes are always known;
 * dynamic routes contribute the values returned by staticParams().
 */
export async function buildSSGPrerenders(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  // Build-time renders run OUTSIDE any instance scope (default bucket), so a
  // prefixed app's mount prefix must be passed explicitly — otherwise the
  // snapshot HTML bakes in basePath "" and prerendered <Link> hrefs lose it.
  basePath?: string
): Promise<SSGPrerender[]> {
  const prerenders: SSGPrerender[] = [];
  const searchRoutes = createSearchRouteMetadata(routes);

  for (const route of routes) {
    if (route.mode !== "ssg") {
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
      const result = await prerenderSSG(route, params, root, origin, basePath, searchRoutes);
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
    if (route.mode !== "ssg" || !route.page.staticParams) {
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
