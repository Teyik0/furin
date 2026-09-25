// biome-ignore-all lint/performance/noAwaitInLoops: SSG rendering writes route outputs in a deterministic sequence
import type { Context } from "elysia";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { mapWithConcurrency } from "../../shared/utils/index.ts";
import type { SsgCacheEntry } from "../cache/isr-ssg.ts";
import type { PageCacheAdapter, PageCacheIdentity, PageCacheLease } from "../cache/page-cache.ts";
import { waitForPageCacheEntry } from "../cache/page-cache.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { getSSGCache, setSSGCache } from "../cache/ssg.ts";
import { createLogger, getLogger } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { renderForPath } from "./ssr.ts";
import { hasStaticParams, resolveStaticParams } from "./static-params.ts";

export async function prerenderRoute(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  mode: "ssg" | "isr",
  basePath: string | undefined,
  searchRoutes: SearchRouteMetadata[] | undefined,
  requestContext?: Context
): Promise<SsgCacheEntry | Response> {
  const renderResult = await renderForPath(
    route,
    params,
    root,
    origin,
    mode,
    basePath,
    searchRoutes,
    undefined,
    requestContext
  );
  if (renderResult instanceof Response) {
    return renderResult;
  }

  return {
    cachedAt: Date.now(),
    html: renderResult.html,
    ndjson: renderResult.ndjson,
    status: renderResult.status,
    tags: route.tags,
  };
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  basePath?: string,
  searchRoutes?: SearchRouteMetadata[]
): Promise<SsgCacheEntry | Response> {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = getSSGCache(resolvedPath);
  if (cached) {
    if (cached.tags === route.tags) {
      return cached;
    }
    const taggedEntry: SsgCacheEntry = { ...cached, tags: route.tags };
    setSSGCache(resolvedPath, taggedEntry);
    return taggedEntry;
  }

  const entry = await prerenderRoute(route, params, root, origin, "ssg", basePath, searchRoutes);
  if (entry instanceof Response) {
    return entry;
  }
  setSSGCache(resolvedPath, entry);

  return entry;
}

export interface RuntimeSsgResult {
  cacheStored: boolean;
  entry: SsgCacheEntry | Response;
}

function parseSharedSsgEntry(payload: string): SsgCacheEntry | undefined {
  const value: unknown = JSON.parse(payload);
  if (
    typeof value !== "object" ||
    value === null ||
    !("cachedAt" in value) ||
    typeof value.cachedAt !== "number" ||
    !("html" in value) ||
    typeof value.html !== "string" ||
    !("ndjson" in value) ||
    typeof value.ndjson !== "string" ||
    !("status" in value) ||
    typeof value.status !== "number" ||
    ("tags" in value &&
      value.tags !== undefined &&
      (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")))
  ) {
    return;
  }
  return value as SsgCacheEntry;
}

interface SharedSsgInput {
  identity: PageCacheIdentity;
  pageCache: PageCacheAdapter;
  renderFresh: () => Promise<SsgCacheEntry | Response>;
}

async function renderAndStoreSharedSsg(
  input: SharedSsgInput,
  lease: PageCacheLease | null
): Promise<RuntimeSsgResult> {
  try {
    const entry = await input.renderFresh();
    if (entry instanceof Response || lease === null) {
      return { cacheStored: false, entry };
    }
    let cacheStored = false;
    try {
      cacheStored =
        (await input.pageCache.commit({
          entry: { cachedAt: entry.cachedAt, payload: JSON.stringify(entry), revalidate: null },
          identity: input.identity,
          lease,
        })) === "stored";
    } catch {
      getLogger().warn("SSG shared page cache write failed; serving fresh with no-store");
    }
    return { cacheStored, entry };
  } finally {
    if (lease !== null) {
      try {
        await input.pageCache.release({ identity: input.identity, lease });
      } catch {
        getLogger().warn("SSG shared page cache lease release failed");
      }
    }
  }
}

async function resolveSharedSsg(input: SharedSsgInput): Promise<RuntimeSsgResult> {
  try {
    const cached = await input.pageCache.read(input.identity);
    if (cached !== null) {
      const entry = parseSharedSsgEntry(cached.payload);
      if (entry !== undefined) {
        return { cacheStored: true, entry };
      }
    }
  } catch {
    getLogger().warn("SSG shared page cache read failed; rendering fresh with no-store");
    return { cacheStored: false, entry: await input.renderFresh() };
  }

  let lease: PageCacheLease | null;
  try {
    lease = await input.pageCache.acquire({ identity: input.identity, leaseMs: 30_000 });
  } catch {
    getLogger().warn("SSG shared page cache lease failed; rendering fresh with no-store");
    return { cacheStored: false, entry: await input.renderFresh() };
  }
  if (lease === null) {
    try {
      const concurrent = await waitForPageCacheEntry(input.pageCache, input.identity, 2000);
      if (concurrent !== null) {
        const entry = parseSharedSsgEntry(concurrent.payload);
        if (entry !== undefined) {
          return { cacheStored: true, entry };
        }
      }
    } catch {
      getLogger().warn("SSG shared page cache wait failed; rendering fresh with no-store");
    }
  }
  return renderAndStoreSharedSsg(input, lease);
}

export async function prerenderRuntimeSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<RuntimeSsgResult> {
  const pageCache = getPageCacheAdapter();
  if (pageCache === undefined) {
    return {
      cacheStored: true,
      entry: await prerenderSSG(route, params, root, origin, undefined, searchRoutes),
    };
  }

  const resolvedPath = resolvePath(route.pattern, params);
  const identity: PageCacheIdentity = {
    buildId,
    key: resolvedPath,
    mode: "ssg",
    path: resolvedPath,
    scope: currentInstance().prefix,
    tags: route.tags ?? [],
  };
  const renderFresh = () =>
    prerenderRoute(route, params, root, origin, "ssg", undefined, searchRoutes);
  return resolveSharedSsg({ identity, pageCache, renderFresh });
}

/**
 * Emits a single structured error log for an SSG warm-up/prerender failure.
 * Centralises the repeated `createLogger → set → error → emit` dance so every
 * failure path stays consistent.
 */
function logSsgError(furin: Record<string, unknown>, error: unknown): void {
  const logger = createLogger({});
  logger.set({ furin });
  logger.error(error instanceof Error ? error : new Error(String(error)));
  logger.emit();
}

/** Maximum number of concurrent `prerenderSSG` calls during SSG warm-up. */
const SSG_WARM_CONCURRENCY = 4;

/**
 * Pre-renders all SSG routes that declare `staticParams` and populates the
 * in-memory cache before the first real request arrives.
 */
export async function warmSSGCache(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string,
  searchRoutes?: SearchRouteMetadata[]
): Promise<void> {
  const targets = routes.filter((r) => r.mode === "ssg" && hasStaticParams(r));
  const warmupLogger = createLogger({});
  warmupLogger.set({
    furin: {
      action: "warmup",
      render: "ssg",
      routes: targets.length,
    },
  });
  warmupLogger.emit();

  type StaticParamsResult =
    | { error: unknown; route: ResolvedRoute }
    | { paramSets: Record<string, string>[]; route: ResolvedRoute };

  const staticParamsResults: StaticParamsResult[] = await mapWithConcurrency(
    targets,
    SSG_WARM_CONCURRENCY,
    async (route) => {
      try {
        const paramSets = (await resolveStaticParams(route, origin)) ?? [];
        return { paramSets, route };
      } catch (err) {
        return { error: err, route };
      }
    }
  );

  const tasks: Array<() => Promise<void>> = [];
  for (const result of staticParamsResults) {
    if ("error" in result) {
      logSsgError(
        { action: "warmup_failed", render: "ssg", route: result.route.pattern },
        result.error
      );
      continue;
    }
    const { route, paramSets } = result;
    if (!Array.isArray(paramSets)) {
      logSsgError(
        { action: "warmup_failed", render: "ssg", route: route.pattern },
        new Error(`staticParams() for "${route.pattern}" returned a non-array value`)
      );
      continue;
    }
    for (const params of paramSets) {
      tasks.push(async () => {
        try {
          await prerenderRuntimeSSG(
            route,
            params,
            root,
            origin,
            currentInstance().buildId,
            searchRoutes
          );
        } catch (err) {
          logSsgError({ action: "prerender_failed", render: "ssg", route: route.pattern }, err);
        }
      });
    }
  }

  if (tasks.length === 0) {
    return;
  }

  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(SSG_WARM_CONCURRENCY, tasks.length) }, async () => {
    while (queue.length > 0) {
      await queue.shift()?.();
    }
  });
  await Promise.all(workers);
}
