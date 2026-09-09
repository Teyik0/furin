import type { Context } from "elysia";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry, getAutoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { registerCacheInvalidator } from "../cache/registry.ts";
import { type Cache, createRouteCache, type RevalidateType } from "../cache/route-cache.ts";
import { allStateBuckets, currentInstance, type FurinInstance } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { type LoaderResult, runPublicLoaders, withRequestLoaderData } from "./loaders.ts";
import { renderSSR } from "./ssr.ts";

interface CachedPprRoute {
  generatedAt: number;
  publicResult: Extract<LoaderResult, { type: "data" }>;
  revalidate: number;
}

interface PprRouteState {
  cache: Cache<CachedPprRoute>;
  unregisterInvalidator: () => void;
}

const MAX_PPR_ROUTE_CACHE_SIZE = 1000;

const pprRouteStateKey = Symbol("furin-ppr-route-cache");

function pathFromPprCacheKey(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return null;
  }
  return new URL(key.slice(separator + 1), "http://furin.local").pathname;
}

function hasPprEntryForPath(cache: Cache<CachedPprRoute>, path: string): boolean {
  for (const key of cache.keys()) {
    if (pathFromPprCacheKey(key) === path) {
      return true;
    }
  }
  return false;
}

function createPprRouteState(instance: FurinInstance): PprRouteState {
  const registry = getAutoInvalidateRegistry(instance);
  let cache: Cache<CachedPprRoute>;
  cache = createRouteCache<CachedPprRoute>({
    maxSize: MAX_PPR_ROUTE_CACHE_SIZE,
    name: "render:ppr-public-shell",
    onDelete: (key) => {
      const path = pathFromPprCacheKey(key);
      if (path === null || hasPprEntryForPath(cache, path)) {
        return;
      }
      registry.unregisterPath(path);
    },
    pathFromKey: pathFromPprCacheKey,
  });

  return {
    cache,
    unregisterInvalidator: registerCacheInvalidator(cache, instance),
  };
}

function getPprRouteState(instance: FurinInstance): PprRouteState {
  const existing = instance.state.get(pprRouteStateKey) as PprRouteState | undefined;
  if (existing !== undefined) {
    return existing;
  }

  const state = createPprRouteState(instance);
  instance.state.set(pprRouteStateKey, state);
  return state;
}

function getPprRoutes(): Cache<CachedPprRoute> {
  return getPprRouteState(currentInstance()).cache;
}

async function buildPublicEntry(route: ResolvedRoute, ctx: Context): Promise<CachedPprRoute> {
  const result = await runPublicLoaders(route, ctx);
  if (result.type !== "data") {
    throw result.type === "redirect" ? result.response : result.error;
  }
  return {
    generatedAt: Date.now(),
    publicResult: result,
    revalidate: route.page._route.revalidate ?? 60,
  };
}

export async function renderPprRoute(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  _buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<Response> {
  const requestUrl = new URL(ctx.request.url);
  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});
  const cacheKey = `${route.mode}:${resolvedPath}${requestUrl.search}`;
  const pprRoutes = getPprRoutes();
  let cached = pprRoutes.get(cacheKey);
  if (cached === undefined) {
    cached = await buildPublicEntry(route, ctx);
    pprRoutes.set(cacheKey, cached);
    autoInvalidateRegistry.registerLoaderTags(resolvedPath, route.tags);
  } else if (route.mode === "isr" && Date.now() - cached.generatedAt >= cached.revalidate * 1000) {
    buildPublicEntry(route, ctx)
      .then((entry) => pprRoutes.set(cacheKey, entry))
      .catch(() => {
        /* Atomic ISR: retain the previous good public shell. */
      });
  }

  const actualResult = withRequestLoaderData(route, ctx, cached.publicResult);
  const response = await renderSSR(route, ctx, root, actualResult, searchRoutes);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function clearPprRouteCache(instance?: FurinInstance): void {
  const instances = instance === undefined ? allStateBuckets() : [instance];
  for (const target of instances) {
    const state = target.state.get(pprRouteStateKey) as PprRouteState | undefined;
    if (state === undefined) {
      continue;
    }
    state.cache.clear();
    state.unregisterInvalidator();
    target.state.delete(pprRouteStateKey);
  }
}

export function invalidatePprRoute(path: string, type: RevalidateType): boolean {
  let deleted = false;
  for (const instance of allStateBuckets()) {
    const state = instance.state.get(pprRouteStateKey) as PprRouteState | undefined;
    if (state === undefined) {
      continue;
    }
    deleted = state.cache.invalidatePath(path, type).deleted || deleted;
  }
  return deleted;
}
