import { AsyncResource } from "node:async_hooks";
import type { Context } from "elysia";
import { createElement } from "react";
import { FurinDocumentFallback } from "../../client/document.tsx";
import { isNotFoundError } from "../../shared/not-found.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  captureISRCacheGeneration,
  deleteISRCache,
  getISRCache,
  type ISRCacheGeneration,
  pendingISRRevalidations,
  releaseISRCacheGeneration,
  setISRCacheIfGenerationUnchanged,
} from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import type {
  PageCacheAdapter,
  PageCacheEntry,
  PageCacheIdentity,
  PageCacheLease,
} from "../cache/page-cache.ts";
import { waitForPageCacheEntry } from "../cache/page-cache.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { pathWithRequestSearch } from "../cache/route-cache.ts";
import { createLogger, getLogger } from "../context-logger.ts";
import { isExternalPrerenderRequest } from "../external-prerender.ts";
import { currentInstance, withInstance } from "../instance.ts";
import { resolveRouteRevalidate } from "../router/patterns.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import {
  injectSyncRuntimeScript,
  type LoaderContext,
  resolvePath,
  streamToString,
} from "./assemble.ts";
import { withDocumentState } from "./document.tsx";
import { runPublicLoaders } from "./loaders.ts";
import {
  type PreparedRender,
  prepareRender,
  renderElementWithShellFallback,
  renderForPath,
} from "./ssr.ts";

/**
 * Builds the Cache-Control header value for an ISR response.
 */
function isrCacheControl(isFresh: boolean, revalidate: number): string {
  const sMaxAge = isFresh ? revalidate : 0;
  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${revalidate}`;
}

/**
 * ETag for an ISR entry: `"buildId:generatedAt"`. Null when no build ID is
 * available (dev), which disables conditional requests for that response.
 */
function isrEtag(buildId: string | undefined, generatedAt: number): string | null {
  return buildId ? `"${buildId}:${generatedAt}"` : null;
}

/**
 * Serves a response from an existing ISR cache entry.
 * Handles stale-while-revalidate background refresh and ETag conditional requests.
 */
function serveISRCacheHit(
  cached: ISRCacheEntry,
  ctx: Context,
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  buildId: string | undefined,
  sharedCache: SharedPageCacheContext | undefined,
  searchRoutes?: SearchRouteMetadata[]
): string | undefined {
  const isFresh = Date.now() - cached.generatedAt < revalidate * 1000;

  if (!isFresh) {
    revalidateInBackground(
      route,
      params,
      cacheKey,
      revalidate,
      root,
      ctx,
      sharedCache,
      searchRoutes
    );
  }

  const etag = isrEtag(buildId, cached.generatedAt);
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    ctx.set.headers.etag = etag;
    ctx.set.headers["cache-control"] = isrCacheControl(isFresh, revalidate);
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = isrCacheControl(isFresh, revalidate);
  if (etag) {
    ctx.set.headers.etag = etag;
  }

  getLogger().set({
    furin: { cache: isFresh ? "hit" : "stale", render: "isr", route: route.pattern },
  });
  return injectSyncRuntimeScript(cached.html);
}

interface SharedPageCacheContext {
  adapter: PageCacheAdapter;
  identity: PageCacheIdentity;
}

/**
 * Handles the ISR non-200 render path: shell-recovery with fallback error
 * component, structured logging, and cache-control headers.
 */
async function renderISRNon200(
  prepared: PreparedRender,
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  errorDigest: string | undefined,
  renderStart: number,
  buildId: string | undefined
): Promise<string> {
  const {
    assets,
    componentProps,
    element,
    errorMessage,
    headData,
    headers,
    status,
    notFoundError,
  } = prepared;
  const fallbackProps: Record<string, unknown> = { ...componentProps };
  if (errorDigest !== undefined && errorMessage !== undefined) {
    fallbackProps.__furinError = { digest: errorDigest, message: errorMessage, status };
  }
  if (status === 404) {
    fallbackProps.__furinStatus = 404;
    if (notFoundError) {
      fallbackProps.__furinNotFound = notFoundError;
    }
  }

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    withDocumentState(element, assets, headData, fallbackProps),
    route.error ?? root.error,
    prepared.ssrContext,
    (fallback, digest, message) =>
      withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
        ...fallbackProps,
        __furinError: { digest, message, status: 500 },
        __furinStatus: 500,
      })
  );
  let finalStatus = status;
  let finalDigest = errorDigest;
  if (shellError) {
    finalStatus = 500;
    finalDigest = shellError.digest;
    getLogger().set({
      furin: {
        cache: "miss",
        digest: finalDigest,
        phase: "shell",
        render: "isr",
        route: route.pattern,
      },
    });
    fallbackProps.__furinError = {
      digest: finalDigest,
      message: shellError.message,
      status: finalStatus,
    };
    fallbackProps.__furinStatus = 500;
  }
  if (!fallbackProps.__furinError && errorDigest !== undefined && errorMessage !== undefined) {
    fallbackProps.__furinError = { digest: errorDigest, message: errorMessage, status };
  }

  await reactStream.allReady;
  const reactHtml = await streamToString(reactStream);
  const html = reactHtml;
  const generatedAt = Date.now();

  const renderMs = generatedAt - renderStart;
  getLogger().set({
    furin: {
      cache: "miss",
      render: "isr",
      render_ms: renderMs,
      route: route.pattern,
      ...(finalDigest ? { digest: finalDigest } : {}),
      status: finalStatus,
    },
  });

  const etag = isrEtag(buildId, generatedAt);
  // Apply loader-set headers first so custom headers survive, then let the
  // ISR-critical headers win (the cache contract is framework-owned).
  for (const [key, value] of Object.entries(headers)) {
    ctx.set.headers[key] = value;
  }
  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = "no-store";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.status = finalStatus;
  return html;
}

function toISRCacheEntry(entry: PageCacheEntry, revalidate: number): ISRCacheEntry {
  return {
    generatedAt: entry.cachedAt,
    html: entry.payload,
    revalidate: entry.revalidate ?? revalidate,
  };
}

interface ISRCacheLookup {
  cached: ISRCacheEntry | undefined;
  sharedAvailable: boolean;
}

async function lookupISRCache(
  pageCache: PageCacheAdapter | undefined,
  identity: PageCacheIdentity,
  cacheKey: string,
  externalPrerender: boolean,
  revalidate: number
): Promise<ISRCacheLookup> {
  if (pageCache === undefined) {
    return {
      cached: externalPrerender ? undefined : getISRCache(cacheKey),
      sharedAvailable: false,
    };
  }
  try {
    const entry = await pageCache.read(identity);
    return {
      cached: entry === null ? undefined : toISRCacheEntry(entry, revalidate),
      sharedAvailable: true,
    };
  } catch {
    getLogger().warn("ISR shared page cache read failed; rendering fresh with no-store");
    return { cached: undefined, sharedAvailable: false };
  }
}

interface ISRLeaseResult {
  lease: PageCacheLease | null;
  sharedAvailable: boolean;
}

const SHARED_ISR_LEASE_MS = 30_000;
const SHARED_ISR_WAIT_SLICE_MS = 2000;

async function acquireISRLease(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity
): Promise<ISRLeaseResult> {
  try {
    return {
      lease: await pageCache.acquire({ identity, leaseMs: SHARED_ISR_LEASE_MS }),
      sharedAvailable: true,
    };
  } catch {
    getLogger().warn("ISR shared page cache lease failed; rendering fresh with no-store");
    return { lease: null, sharedAvailable: false };
  }
}

interface ISRCoordinationResult extends ISRCacheLookup {
  lease: PageCacheLease | null;
}

function coordinateConcurrentISR(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity,
  revalidate: number
): Promise<ISRCoordinationResult> {
  return coordinateConcurrentISRUntil(
    pageCache,
    identity,
    revalidate,
    Date.now() + SHARED_ISR_LEASE_MS
  );
}

async function coordinateConcurrentISRUntil(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity,
  revalidate: number,
  deadline: number
): Promise<ISRCoordinationResult> {
  if (Date.now() >= deadline) {
    return { cached: undefined, lease: null, sharedAvailable: true };
  }
  try {
    const entry = await waitForPageCacheEntry(pageCache, identity, SHARED_ISR_WAIT_SLICE_MS);
    if (entry !== null) {
      return {
        cached: toISRCacheEntry(entry, revalidate),
        lease: null,
        sharedAvailable: true,
      };
    }
  } catch {
    getLogger().warn("ISR shared page cache wait failed; rendering fresh with no-store");
    return { cached: undefined, lease: null, sharedAvailable: false };
  }
  const leaseResult = await acquireISRLease(pageCache, identity);
  if (!leaseResult.sharedAvailable || leaseResult.lease !== null) {
    return { cached: undefined, ...leaseResult };
  }
  return coordinateConcurrentISRUntil(pageCache, identity, revalidate, deadline);
}

interface ISRCacheMissInput {
  buildId: string | undefined;
  cacheGeneration: ISRCacheGeneration | undefined;
  cacheKey: string;
  ctx: Context;
  externalPrerender: boolean;
  pageCache: PageCacheAdapter | undefined;
  pageCacheIdentity: PageCacheIdentity;
  pageCacheLease: PageCacheLease | null;
  revalidate: number;
  root: RootLayout;
  route: ResolvedRoute;
  searchRoutes: SearchRouteMetadata[] | undefined;
  sharedAvailable: boolean;
}

async function storeRenderedISR(
  input: ISRCacheMissInput,
  html: string,
  generatedAt: number
): Promise<boolean> {
  if (input.pageCache !== undefined && input.pageCacheLease !== null && input.sharedAvailable) {
    try {
      return (
        (await input.pageCache.commit({
          entry: { cachedAt: generatedAt, payload: html, revalidate: input.revalidate },
          identity: input.pageCacheIdentity,
          lease: input.pageCacheLease,
        })) === "stored"
      );
    } catch {
      getLogger().warn("ISR shared page cache write failed; serving fresh with no-store");
      return false;
    }
  }
  if (input.cacheGeneration === undefined) {
    return false;
  }
  return setISRCacheIfGenerationUnchanged(
    input.cacheKey,
    { generatedAt, html, revalidate: input.revalidate },
    input.cacheGeneration
  );
}

async function releaseISRRenderLocks(input: ISRCacheMissInput): Promise<void> {
  if (input.pageCache !== undefined && input.pageCacheLease !== null) {
    try {
      await input.pageCache.release({
        identity: input.pageCacheIdentity,
        lease: input.pageCacheLease,
      });
    } catch {
      getLogger().warn("ISR shared page cache lease release failed");
    }
  }
  if (input.cacheGeneration !== undefined) {
    releaseISRCacheGeneration(input.cacheKey, input.cacheGeneration);
  }
}

async function renderISRCacheMiss(input: ISRCacheMissInput): Promise<Response | string> {
  try {
    const renderStart = Date.now();
    const loaderResult = await runPublicLoaders(input.route, input.ctx);
    const prepared = await prepareRender(
      input.route,
      input.ctx,
      input.root,
      undefined,
      false,
      loaderResult,
      input.searchRoutes
    );
    if (prepared instanceof Response) {
      return prepared;
    }
    const { assets, element, headData, headers, syncData, status, errorDigest } = prepared;
    if (status !== 200) {
      return renderISRNon200(
        prepared,
        input.route,
        input.ctx,
        input.root,
        errorDigest,
        renderStart,
        input.buildId
      );
    }

    const { shellError, stream } = await renderElementWithShellFallback(
      withDocumentState(element, assets, headData, syncData),
      input.route.error ?? input.root.error,
      prepared.ssrContext,
      (fallback, digest, message) =>
        withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
          __furinError: { digest, message, status: 500 },
          __furinStatus: 500,
        })
    );
    if (shellError) {
      prepared.status = 500;
      prepared.errorDigest = shellError.digest;
      prepared.errorMessage = shellError.message;
      return renderISRNon200(
        prepared,
        input.route,
        input.ctx,
        input.root,
        shellError.digest,
        renderStart,
        input.buildId
      );
    }
    await stream.allReady;
    const html = await streamToString(stream);
    const generatedAt = Date.now();
    getLogger().set({
      furin: {
        cache: "miss",
        render: "isr",
        render_ms: generatedAt - renderStart,
        route: input.route.pattern,
      },
    });
    const cacheStored = await storeRenderedISR(input, html, generatedAt);
    if (cacheStored && input.pageCache === undefined) {
      autoInvalidateRegistry.registerLoaderTags(input.cacheKey, input.route.tags);
    }

    for (const [key, value] of Object.entries(headers)) {
      input.ctx.set.headers[key] = value;
    }
    input.ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    input.ctx.set.headers["cache-control"] =
      input.externalPrerender || cacheStored ? isrCacheControl(true, input.revalidate) : "no-store";
    const etag = isrEtag(input.buildId, generatedAt);
    if (etag) {
      input.ctx.set.headers.etag = etag;
    }
    return html;
  } finally {
    await releaseISRRenderLocks(input);
  }
}

export async function handleISR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes?: SearchRouteMetadata[]
) {
  const revalidate = resolveRouteRevalidate(route.page) ?? 60;
  const params = ctx.params ?? {};
  const resolvedPath = resolvePath(route.pattern, params);
  const cacheKey = pathWithRequestSearch(resolvedPath, ctx.request.url);
  const externalPrerender = isExternalPrerenderRequest(ctx.request);
  const pageCache = externalPrerender ? undefined : getPageCacheAdapter();
  const pageCacheIdentity: PageCacheIdentity = {
    buildId: buildId ?? "",
    key: cacheKey,
    mode: "isr",
    path: resolvedPath,
    scope: currentInstance().prefix,
    tags: route.tags ?? [],
  };

  const lookup = await lookupISRCache(
    pageCache,
    pageCacheIdentity,
    cacheKey,
    externalPrerender,
    revalidate
  );
  const { cached, sharedAvailable: initialSharedAvailable } = lookup;
  if (cached !== undefined) {
    return serveISRCacheHit(
      cached,
      ctx,
      route,
      params,
      cacheKey,
      revalidate,
      root,
      buildId,
      pageCache === undefined ? undefined : { adapter: pageCache, identity: pageCacheIdentity },
      searchRoutes
    );
  }

  let pageCacheLease: PageCacheLease | null = null;
  let sharedAvailable = initialSharedAvailable;
  if (pageCache !== undefined && sharedAvailable) {
    const leaseResult = await acquireISRLease(pageCache, pageCacheIdentity);
    ({ lease: pageCacheLease, sharedAvailable } = leaseResult);
  }
  if (pageCache !== undefined && sharedAvailable && pageCacheLease === null) {
    const concurrent = await coordinateConcurrentISR(pageCache, pageCacheIdentity, revalidate);
    const {
      cached: concurrentCached,
      lease: concurrentLease,
      sharedAvailable: concurrentAvailable,
    } = concurrent;
    sharedAvailable = concurrentAvailable;
    pageCacheLease = concurrentLease;
    if (concurrentCached !== undefined) {
      return serveISRCacheHit(
        concurrentCached,
        ctx,
        route,
        params,
        cacheKey,
        revalidate,
        root,
        buildId,
        { adapter: pageCache, identity: pageCacheIdentity },
        searchRoutes
      );
    }
  }
  const cacheGeneration =
    externalPrerender || pageCache !== undefined ? undefined : captureISRCacheGeneration(cacheKey);
  return renderISRCacheMiss({
    buildId,
    cacheGeneration,
    cacheKey,
    ctx,
    externalPrerender,
    pageCache,
    pageCacheIdentity,
    pageCacheLease,
    revalidate,
    root,
    route,
    searchRoutes,
    sharedAvailable,
  });
}

function revalidateInBackground(
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
  const { origin, search } = new URL(originalCtx.request.url);

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
  const logger = createLogger({});
  if (isNotFoundError(error)) {
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
    return;
  }
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
    if (result.status !== 200) {
      logRevalidationSkipped(input.route, "non_200_render", result.status);
      return;
    }
    if (input.sharedCache !== undefined && lease !== null) {
      await input.sharedCache.adapter.commit({
        entry: { cachedAt: Date.now(), payload: result.html, revalidate: input.revalidate },
        identity: input.sharedCache.identity,
        lease,
      });
    } else if (input.cacheGeneration !== undefined) {
      setISRCacheIfGenerationUnchanged(
        input.cacheKey,
        { generatedAt: Date.now(), html: result.html, revalidate: input.revalidate },
        input.cacheGeneration
      );
    }
  } catch (error: unknown) {
    await handleBackgroundRevalidationError(input, error);
  } finally {
    await releaseBackgroundRevalidation(input, lease);
  }
}
