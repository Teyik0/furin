import type { Context } from "elysia";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { queryTagsFromData } from "../../shared/sync-query.ts";
import { autoInvalidateRegistry, getAutoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  captureISRCacheGeneration,
  type ISRCacheGeneration,
  releaseISRCacheGeneration,
  setISRCacheIfGenerationUnchanged,
} from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import type { PageCacheAdapter, PageCacheIdentity, PageCacheLease } from "../cache/page-cache.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { canonicalCacheRequest } from "../cache/route-cache.ts";
import { getLogger } from "../context-logger.ts";
import { isExternalPrerenderRequest } from "../external-prerender.ts";
import { currentInstance } from "../instance.ts";
import { resolveDocumentRevalidate } from "../router/patterns.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { injectSyncRuntimeScript, resolvePath, streamToString } from "./assemble.ts";
import { renderPayload, renderPreparedDocument } from "./document-stream.ts";
import { revalidateInBackground } from "./isr-revalidation.ts";
import {
  acquireISRLease,
  coordinateConcurrentISR,
  lookupISRCache,
  serializeISRPayload,
} from "./isr-shared-cache.ts";
import {
  hasMixedLoaderModes,
  type LoaderResult,
  runPublicLoaders,
  runSegmentPublicLoaders,
} from "./loaders.ts";
import { withNavigationHead } from "./navigation-head.ts";
import { type PreparedRender, prepareRender } from "./prepare-render.ts";
import { serializeLoaderDataNdjson } from "./route-frame-transport.ts";

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
 * Serves a document from an existing ISR cache entry, honouring ETag
 * conditional requests.
 */
function serveISRDocumentHit(
  request: ISRRequest,
  cached: ISRCacheEntry,
  isFresh: boolean
): string | undefined {
  const { buildId, ctx, revalidate, route } = request;
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

/**
 * Handles the ISR non-200 render path: shell-recovery with fallback error
 * component, structured logging, and cache-control headers.
 */
async function renderISRNon200(
  prepared: PreparedRender,
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  renderStart: number,
  buildId: string | undefined
): Promise<string> {
  const { errorDigest, headers, status } = prepared;
  const fallbackProps = { ...prepared.componentProps, ...renderPayload(prepared, undefined) };
  const { stream: reactStream, shellError } = await renderPreparedDocument(
    prepared,
    root,
    fallbackProps,
    fallbackProps
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
  }

  await reactStream.allReady;
  const html = await streamToString(reactStream);
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

async function storeRenderedISR(input: ISRCacheMissInput, entry: ISRCacheEntry): Promise<boolean> {
  if (input.pageCache !== undefined && input.pageCacheLease !== null && input.sharedAvailable) {
    try {
      return (
        (await input.pageCache.commit({
          entry: {
            cachedAt: entry.generatedAt,
            payload: serializeISRPayload(entry),
            revalidate: input.revalidate,
          },
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
  return setISRCacheIfGenerationUnchanged(input.cacheKey, entry, input.cacheGeneration);
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

type ISRMissOutcome =
  | { loaderResult: LoaderResult; response: Response; type: "redirect" }
  | { loaderResult: LoaderResult; prepared: PreparedRender; renderStart: number; type: "uncached" }
  | {
      cacheStored: boolean;
      entry: ISRCacheEntry;
      headers: { [key: string]: string };
      loaderResult: LoaderResult;
      type: "rendered";
    };

/**
 * Renders the document and its navigation data for a cache miss and stores
 * both in one entry. Non-200 renders come back `uncached` so the caller can
 * answer with an error document or the raw loader result.
 */
async function renderISRCacheMiss(input: ISRCacheMissInput): Promise<ISRMissOutcome> {
  try {
    const renderStart = Date.now();
    const loaderResult = await (hasMixedLoaderModes(input.route)
      ? runSegmentPublicLoaders(input.route, input.ctx)
      : runPublicLoaders(input.route, input.ctx));
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
      return { loaderResult, response: prepared, type: "redirect" };
    }
    const { headData, headers, syncData, status } = prepared;
    if (status !== 200) {
      return { loaderResult, prepared, renderStart, type: "uncached" };
    }

    const { shellError, stream } = await renderPreparedDocument(prepared, input.root, syncData, {});
    if (shellError) {
      prepared.status = 500;
      prepared.errorDigest = shellError.digest;
      prepared.errorMessage = shellError.message;
      return { loaderResult, prepared, renderStart, type: "uncached" };
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
    const entry: ISRCacheEntry = {
      generatedAt,
      html,
      ndjson: await serializeLoaderDataNdjson(withNavigationHead(syncData, headData), undefined),
      revalidate: input.revalidate,
    };
    const discoveredTags = queryTagsFromData(syncData);
    const identityTags = new Set(input.pageCacheIdentity.tags);
    const cacheStored =
      input.pageCache !== undefined && discoveredTags.some((tag) => !identityTags.has(tag))
        ? false
        : await storeRenderedISR(input, entry);
    if (cacheStored && input.pageCache === undefined) {
      autoInvalidateRegistry.registerLoaderTags(
        input.cacheKey,
        [...(input.route.tags ?? []), ...discoveredTags],
        "render:isr-html"
      );
    }
    return { cacheStored, entry, headers, loaderResult, type: "rendered" };
  } finally {
    await releaseISRRenderLocks(input);
  }
}

interface ISRRequest {
  buildId: string | undefined;
  ctx: Context;
  externalPrerender: boolean;
  revalidate: number;
  root: RootLayout;
  route: ResolvedRoute;
  searchRoutes: SearchRouteMetadata[] | undefined;
}

/** How one ISR request turns a cache hit or a miss render into its response. */
interface ISRResponder<T> {
  hit: (cached: ISRCacheEntry, isFresh: boolean) => T;
  miss: (outcome: ISRMissOutcome) => T | Promise<T>;
}

function createISRRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes: SearchRouteMetadata[] | undefined
): ISRRequest {
  return {
    buildId,
    ctx,
    externalPrerender: isExternalPrerenderRequest(ctx.request),
    revalidate: resolveDocumentRevalidate(route) ?? 60,
    root,
    route,
    searchRoutes,
  };
}

function serveISRDocumentMiss(
  request: ISRRequest,
  outcome: ISRMissOutcome
): Response | string | Promise<string> {
  const { buildId, ctx, externalPrerender, revalidate, root, route } = request;
  if (outcome.type === "redirect") {
    return outcome.response;
  }
  if (outcome.type === "uncached") {
    return renderISRNon200(outcome.prepared, route, ctx, root, outcome.renderStart, buildId);
  }
  for (const [key, value] of Object.entries(outcome.headers)) {
    ctx.set.headers[key] = value;
  }
  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] =
    externalPrerender || outcome.cacheStored ? isrCacheControl(true, revalidate) : "no-store";
  const etag = isrEtag(buildId, outcome.entry.generatedAt);
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  return outcome.entry.html;
}

export function handleISR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response | string | undefined> {
  const request = createISRRequest(route, ctx, root, buildId, searchRoutes);
  return resolveISR<Response | string | undefined>(request, {
    hit: (cached, isFresh) => serveISRDocumentHit(request, cached, isFresh),
    miss: (outcome) => serveISRDocumentMiss(request, outcome),
  });
}

/**
 * Navigation data for an ISR or SSG route, read from (or rendered into) the
 * same cache entry as the document. `cacheControl` is undefined when the
 * payload must not be shared; non-200 renders fall back to the loader result.
 */
export type CachedRouteData =
  | {
      cacheControl: string | undefined;
      headers: { [key: string]: string };
      ndjson: string;
      type: "payload";
    }
  | { result: LoaderResult; type: "loader" };

export function handleISRData(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<CachedRouteData> {
  const request = createISRRequest(route, ctx, root, buildId, searchRoutes);
  return resolveISR<CachedRouteData>(request, {
    hit: (cached, isFresh) => {
      getLogger().set({
        furin: { cache: isFresh ? "hit" : "stale", render: "isr", route: route.pattern },
      });
      return {
        cacheControl: isrCacheControl(isFresh, request.revalidate),
        headers: {},
        ndjson: cached.ndjson,
        type: "payload",
      };
    },
    miss: (outcome) =>
      outcome.type === "rendered"
        ? {
            cacheControl:
              request.externalPrerender || outcome.cacheStored
                ? isrCacheControl(true, request.revalidate)
                : undefined,
            headers: outcome.headers,
            ndjson: outcome.entry.ndjson,
            type: "payload",
          }
        : { result: outcome.loaderResult, type: "loader" },
  });
}

async function resolveISR<T>(request: ISRRequest, responder: ISRResponder<T>): Promise<T> {
  const { buildId, ctx, externalPrerender, revalidate, root, route, searchRoutes } = request;
  const params = ctx.params ?? {};
  const resolvedPath = resolvePath(route.pattern, params);
  const canonical = canonicalCacheRequest(route, resolvedPath, ctx);
  const { cacheKey } = canonical;
  const pageCache = externalPrerender ? undefined : getPageCacheAdapter();
  const pageCacheIdentity: PageCacheIdentity = {
    buildId: buildId ?? "",
    key: cacheKey,
    mode: "isr",
    path: resolvedPath,
    scope: currentInstance().prefix,
    tags: [
      ...new Set([...(route.tags ?? []), ...getAutoInvalidateRegistry().tagsForPath(cacheKey)]),
    ],
  };
  const serveHit = (entry: ISRCacheEntry): T => {
    const isFresh = Date.now() - entry.generatedAt < revalidate * 1000;
    if (!isFresh) {
      revalidateInBackground(
        route,
        params,
        cacheKey,
        revalidate,
        root,
        ctx,
        pageCache === undefined ? undefined : { adapter: pageCache, identity: pageCacheIdentity },
        searchRoutes
      );
    }
    return responder.hit(entry, isFresh);
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
    return serveHit(cached);
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
      return serveHit(concurrentCached);
    }
  }
  const cacheGeneration =
    externalPrerender || pageCache !== undefined ? undefined : captureISRCacheGeneration(cacheKey);
  const outcome = await renderISRCacheMiss({
    buildId,
    cacheGeneration,
    cacheKey,
    ctx: canonical.ctx,
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
  return responder.miss(outcome);
}
