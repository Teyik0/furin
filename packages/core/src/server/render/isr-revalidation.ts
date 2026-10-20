import { AsyncResource } from "node:async_hooks";
import { isNotFoundError } from "../../shared/not-found.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  captureISRCacheGeneration,
  deleteISRCache,
  type ISRCacheGeneration,
  pendingISRRevalidations,
  releaseISRCacheGeneration,
  setISRCacheIfGenerationUnchanged,
} from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import type { PageCacheLease } from "../cache/page-cache.ts";
import { createLogger, getLogger } from "../context-logger.ts";
import { currentInstance, withInstance } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import type { LoaderContext } from "./assemble.ts";
import { renderForPath } from "./buffered-render.ts";
import { type SharedPageCacheContext, serializeISRPayload } from "./isr-shared-cache.ts";

export function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  originalCtx: LoaderContext,
  sharedCache: SharedPageCacheContext | undefined,
  searchRoutes?: SearchRouteMetadata[]
) {
  const pendingRevalidations = pendingISRRevalidations();
  if (pendingRevalidations.has(cacheKey)) {
    const logger = createLogger({});
    logger.set({
      furin: {
        cache: "revalidation_skipped",
        reason: "already_in_flight",
        render: "isr",
        route: route.pattern,
      },
    });
    logger.emit();
    return;
  }
  const cacheGeneration =
    sharedCache === undefined ? captureISRCacheGeneration(cacheKey) : undefined;
  const instance = currentInstance();
  const { origin } = new URL(originalCtx.request.url);
  const { search } = new URL(cacheKey, origin);

  const input: BackgroundRevalidationInput = {
    cacheGeneration,
    cacheKey,
    origin,
    params,
    revalidate,
    root,
    route,
    search,
    searchRoutes,
    sharedCache,
  };

  const revalidation = new Promise<void>((resolve) => {
    const resource = new AsyncResource("furin:isr-revalidation", { triggerAsyncId: 0 });
    resource.runInAsyncScope(() => {
      queueMicrotask(() => {
        withInstance(instance, () => performBackgroundRevalidation(input)).finally(() => {
          resolve();
          resource.emitDestroy();
        });
      });
    });
  }).finally(() => {
    if (pendingRevalidations.get(cacheKey) === revalidation) {
      pendingRevalidations.delete(cacheKey);
    }
  });
  pendingRevalidations.set(cacheKey, revalidation);
}

interface BackgroundRevalidationInput {
  cacheGeneration: ISRCacheGeneration | undefined;
  cacheKey: string;
  origin: string;
  params: Record<string, string>;
  revalidate: number;
  root: RootLayout;
  route: ResolvedRoute;
  search: string;
  searchRoutes: SearchRouteMetadata[] | undefined;
  sharedCache: SharedPageCacheContext | undefined;
}

function logRevalidationSkipped(route: ResolvedRoute, reason: string, status?: number): void {
  const logger = createLogger({});
  logger.set({
    furin: {
      cache: "revalidation_skipped",
      reason,
      render: "isr",
      route: route.pattern,
      ...(status === undefined ? {} : { status }),
    },
  });
  logger.emit();
}

async function handleBackgroundRevalidationError(
  input: BackgroundRevalidationInput,
  error: unknown
): Promise<void> {
  if (isNotFoundError(error)) {
    await invalidateBackgroundNotFound(input);
    return;
  }
  const logger = createLogger({});
  logger.set({
    furin: {
      cache: "revalidation_failed",
      render: "isr",
      route: input.route.pattern,
    },
  });
  logger.error(error instanceof Error ? error : new Error(String(error)));
  logger.emit();
}

async function invalidateBackgroundNotFound(input: BackgroundRevalidationInput): Promise<void> {
  if (input.sharedCache === undefined && !input.cacheGeneration?.valid) {
    return;
  }
  const logger = createLogger({});
  if (input.sharedCache === undefined) {
    deleteISRCache(input.cacheKey);
  } else {
    try {
      await input.sharedCache.adapter.invalidate({
        kind: "path",
        path: input.sharedCache.identity.path,
        scope: input.sharedCache.identity.scope,
        type: "page",
      });
    } catch {
      logger.warn("ISR shared page cache invalidation failed after not-found revalidation");
    }
  }
  logger.set({
    furin: {
      cache: "revalidation_invalidated",
      reason: "not_found",
      render: "isr",
      route: input.route.pattern,
    },
  });
  logger.emit();
}

async function releaseBackgroundRevalidation(
  input: BackgroundRevalidationInput,
  lease: PageCacheLease | null
): Promise<void> {
  if (input.sharedCache !== undefined && lease !== null) {
    try {
      await input.sharedCache.adapter.release({ identity: input.sharedCache.identity, lease });
    } catch {
      getLogger().warn("ISR shared page cache lease release failed");
    }
  }
  if (input.cacheGeneration !== undefined) {
    releaseISRCacheGeneration(input.cacheKey, input.cacheGeneration);
  }
}

async function performBackgroundRevalidation(input: BackgroundRevalidationInput): Promise<void> {
  let lease: PageCacheLease | null = null;
  try {
    if (input.sharedCache !== undefined) {
      lease = await input.sharedCache.adapter.acquire({
        identity: input.sharedCache.identity,
        leaseMs: 30_000,
      });
      if (lease === null) {
        logRevalidationSkipped(input.route, "already_in_flight");
        return;
      }
    }
    const result = await renderForPath(
      input.route,
      input.params,
      input.root,
      input.origin,
      "isr",
      undefined,
      input.searchRoutes,
      input.search
    );
    if (result instanceof Response) {
      return;
    }
    if (result.status === 404) {
      await invalidateBackgroundNotFound(input);
      return;
    }
    if (result.status !== 200) {
      logRevalidationSkipped(input.route, "non_200_render", result.status);
      return;
    }
    const entry: ISRCacheEntry = {
      generatedAt: Date.now(),
      html: result.html,
      ndjson: result.ndjson,
      revalidate: input.revalidate,
    };
    if (input.sharedCache !== undefined && lease !== null) {
      const { identity } = input.sharedCache;
      const identityTags = new Set(identity.tags);
      if ((result.queryTags ?? []).some((tag) => !identityTags.has(tag))) {
        return;
      }
      await input.sharedCache.adapter.commit({
        entry: {
          cachedAt: entry.generatedAt,
          payload: serializeISRPayload(entry),
          revalidate: input.revalidate,
        },
        identity: input.sharedCache.identity,
        lease,
      });
    } else if (input.cacheGeneration !== undefined) {
      const stored = setISRCacheIfGenerationUnchanged(input.cacheKey, entry, input.cacheGeneration);
      if (stored) {
        autoInvalidateRegistry.registerLoaderTags(
          input.cacheKey,
          [...(input.route.tags ?? []), ...(result.queryTags ?? [])],
          "render:isr-html"
        );
      }
    }
  } catch (error: unknown) {
    await handleBackgroundRevalidationError(input, error);
  } finally {
    await releaseBackgroundRevalidation(input, lease);
  }
}
