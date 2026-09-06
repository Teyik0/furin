// biome-ignore-all lint/performance/noAwaitInLoops: SSG rendering writes route outputs in a deterministic sequence
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { mapWithConcurrency } from "../../shared/utils/index.ts";
import type { SsgCacheEntry } from "../cache/isr-ssg.ts";
import { getSSGCache, setSSGCache } from "../cache/ssg.ts";
import { createLogger } from "../context-logger.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { renderForPath } from "./ssr.ts";

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

  const renderResult = await renderForPath(
    route,
    params,
    root,
    origin,
    "ssg",
    basePath,
    searchRoutes
  );
  if (renderResult instanceof Response) {
    return renderResult;
  }
  const result = renderResult;

  const entry: SsgCacheEntry = {
    cachedAt: Date.now(),
    html: result.html,
    ndjson: result.ndjson,
    status: result.status,
    tags: route.tags,
  };
  setSSGCache(resolvedPath, entry);

  return entry;
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
  const targets = routes.filter((r) => r.mode === "ssg" && r.page.staticParams);
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
        const paramSets = (await route.page.staticParams?.()) ?? [];
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
          await prerenderSSG(route, params, root, origin, undefined, searchRoutes);
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
