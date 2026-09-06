import { AsyncResource } from "node:async_hooks";
import type { Context } from "elysia";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { FurinDocumentFallback } from "../../client/document.tsx";
import { isNotFoundError } from "../../shared/not-found.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  captureISRCacheGeneration,
  deleteISRCache,
  getISRCache,
  pendingISRRevalidations,
  releaseISRCacheGeneration,
  setISRCacheIfGenerationUnchanged,
} from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import { pathWithRequestSearch } from "../cache/route-cache.ts";
import { createLogger, useLogger } from "../context-logger.ts";
import { currentInstance, withInstance } from "../instance.ts";
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
  return `public, max-age=0, must-revalidate, s-maxage=${sMaxAge}, stale-while-revalidate=${revalidate}`;
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
  searchRoutes?: SearchRouteMetadata[]
): string | undefined {
  const isFresh = Date.now() - cached.generatedAt < revalidate * 1000;

  if (!isFresh) {
    revalidateInBackground(route, params, cacheKey, revalidate, root, ctx, searchRoutes);
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

  useLogger().set({
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
  errorDigest: string | undefined,
  renderStart: number,
  buildId: string | undefined
): Promise<string> {
  const { assets, componentProps, element, headData, headers, status, notFoundError } = prepared;
  const fallbackProps: Record<string, unknown> = { ...componentProps };
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
    (fallback, digest) =>
      withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
        ...fallbackProps,
        __furinError: { digest, status: 500 },
        __furinStatus: 500,
      })
  );
  let finalStatus = status;
  let finalDigest = errorDigest;
  if (shellError) {
    finalStatus = 500;
    finalDigest = shellError.digest;
    useLogger().set({
      furin: {
        cache: "miss",
        digest: finalDigest,
        phase: "shell",
        render: "isr",
        route: route.pattern,
      },
    });
    fallbackProps.__furinError = { digest: finalDigest, status: finalStatus };
    fallbackProps.__furinStatus = 500;
  }
  if (!fallbackProps.__furinError && errorDigest) {
    fallbackProps.__furinError = { digest: errorDigest, status };
  }

  await reactStream.allReady;
  const reactHtml = await streamToString(reactStream);
  const html = reactHtml;
  const generatedAt = Date.now();

  const renderMs = generatedAt - renderStart;
  useLogger().set({
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

export async function handleISR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes?: SearchRouteMetadata[]
) {
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const resolvedPath = resolvePath(route.pattern, params);
  const cacheKey = pathWithRequestSearch(resolvedPath, ctx.request.url);

  const cached = getISRCache(cacheKey);
  if (cached) {
    return serveISRCacheHit(
      cached,
      ctx,
      route,
      params,
      cacheKey,
      revalidate,
      root,
      buildId,
      searchRoutes
    );
  }

  const cacheGeneration = captureISRCacheGeneration(cacheKey);
  try {
    const renderStart = Date.now();
    const loaderResult = await runPublicLoaders(route, ctx);
    const prepared = await prepareRender(
      route,
      ctx,
      root,
      undefined,
      false,
      loaderResult,
      searchRoutes
    );

    if (prepared instanceof Response) {
      return prepared;
    }

    const { assets, element, headData, headers, syncData, status, errorDigest } = prepared;

    if (status !== 200) {
      return renderISRNon200(prepared, route, ctx, root, errorDigest, renderStart, buildId);
    }

    const stream = await renderToReadableStream(
      withDocumentState(element, assets, headData, syncData)
    );
    await stream.allReady;
    const reactHtml = await streamToString(stream);
    const html = reactHtml;
    const generatedAt = Date.now();

    useLogger().set({
      furin: {
        cache: "miss",
        render: "isr",
        render_ms: generatedAt - renderStart,
        route: route.pattern,
      },
    });

    const cacheStored = setISRCacheIfGenerationUnchanged(
      cacheKey,
      { generatedAt, html, revalidate },
      cacheGeneration
    );
    if (cacheStored) {
      autoInvalidateRegistry.registerLoaderTags(cacheKey, route.tags);
    }

    const etag = isrEtag(buildId, generatedAt);
    // Apply loader-set headers first so custom headers survive, then let the
    // ISR-critical headers win (the cache contract is framework-owned).
    for (const [key, value] of Object.entries(headers)) {
      ctx.set.headers[key] = value;
    }
    ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    ctx.set.headers["cache-control"] = cacheStored ? isrCacheControl(true, revalidate) : "no-store";
    if (etag) {
      ctx.set.headers.etag = etag;
    }
    return html;
  } finally {
    releaseISRCacheGeneration(cacheKey, cacheGeneration);
  }
}

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  originalCtx: LoaderContext,
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
  const cacheGeneration = captureISRCacheGeneration(cacheKey);
  const instance = currentInstance();
  const { origin, search } = new URL(originalCtx.request.url);

  const revalidation = new Promise<void>((resolve) => {
    const resource = new AsyncResource("furin:isr-revalidation", { triggerAsyncId: 0 });
    resource.runInAsyncScope(() => {
      queueMicrotask(() => {
        withInstance(instance, () =>
          renderForPath(route, params, root, origin, "isr", undefined, searchRoutes, search)
            .then((result) => {
              if (result instanceof Response) {
                return;
              }
              // Only replace the cached entry with a healthy 200 render. The current
              // ISR cache stores HTML only, so caching non-200 output would serve it
              // back as a 200 on the next hit.
              if (result.status !== 200) {
                const logger = createLogger({});
                logger.set({
                  furin: {
                    cache: "revalidation_skipped",
                    reason: "non_200_render",
                    render: "isr",
                    route: route.pattern,
                    status: result.status,
                  },
                });
                logger.emit();
                return;
              }
              setISRCacheIfGenerationUnchanged(
                cacheKey,
                {
                  generatedAt: Date.now(),
                  html: result.html,
                  revalidate,
                },
                cacheGeneration
              );
            })
            .catch((err: unknown) => {
              const logger = createLogger({});
              if (isNotFoundError(err)) {
                deleteISRCache(cacheKey);
                logger.set({
                  furin: {
                    cache: "revalidation_invalidated",
                    reason: "not_found",
                    render: "isr",
                    route: route.pattern,
                  },
                });
                logger.emit();
                return;
              }
              logger.set({
                furin: {
                  cache: "revalidation_failed",
                  render: "isr",
                  route: route.pattern,
                },
              });
              logger.error(err instanceof Error ? err : new Error(String(err)));
              logger.emit();
            })
            .finally(() => releaseISRCacheGeneration(cacheKey, cacheGeneration))
            .finally(() => {
              resolve();
              resource.emitDestroy();
            })
        );
      });
    });
  }).finally(() => {
    if (pendingRevalidations.get(cacheKey) === revalidation) {
      pendingRevalidations.delete(cacheKey);
    }
  });
  pendingRevalidations.set(cacheKey, revalidation);
}
