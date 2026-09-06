// biome-ignore-all lint/performance/noAwaitInLoops: SSG cache generation runs routes sequentially for deterministic cache output
import type { SsgCacheEntry } from "../server/cache/index.ts";
import { resolvePath } from "../server/render/assemble.ts";
import { prerenderSSG } from "../server/render/index.ts";
import { createSearchRouteMetadata } from "../server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../server/router/types.ts";

export type SSGCacheSnapshot = Record<string, SsgCacheEntry>;

export async function buildSSGCacheSnapshot(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  // Build-time renders run OUTSIDE any instance scope (default bucket), so a
  // prefixed app's mount prefix must be passed explicitly — otherwise the
  // snapshot HTML bakes in basePath "" and prerendered <Link> hrefs lose it.
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
      const entry = await prerenderSSG(route, params, root, origin, basePath, searchRoutes);
      if (entry instanceof Response) {
        continue;
      }
      snapshot[resolvePath(route.pattern, params)] = entry;
    }
  }

  return snapshot;
}
