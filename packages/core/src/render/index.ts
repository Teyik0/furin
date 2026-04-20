import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { RouterContext, type RouterContextValue } from "../link.tsx";
import { FurinNotFoundError } from "../not-found.ts";
import type { RootLayout } from "../router.ts";
import { assembleHTML, resolvePath, splitTemplate, streamToString } from "./assemble.ts";
import {
  getISRCache,
  getSSGCache,
  type ISRCacheEntry,
  type SsgCacheEntry,
  setISRCache,
  setSSGCache,
} from "./cache.ts";
import { computeErrorDigest } from "./digest.ts";
import { buildElement, buildErrorElement, buildNotFoundElement } from "./element.tsx";
import { runLoaders } from "./loaders.ts";
import { buildHeadInjection, safeJson } from "./shell.ts";
import { getDevTemplate, getProductionTemplate } from "./template.ts";

// ── Re-exports (public API) ──────────────────────────────────────────────────
// biome-ignore lint/performance/noBarrelFile: acnowledged
export { type LoaderContext, streamToString } from "./assemble.ts";
export { buildElement } from "./element.tsx";
export { type LoaderResult, runLoaders } from "./loaders.ts";

// ── Types ────────────────────────────────────────────────────────────────────

import type { Context } from "elysia";
import { runInSyntheticRenderScope, useLogger } from "../context-logger.ts";
import type { ResolvedRoute } from "../router.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { LoaderContext } from "./assemble.ts";
import { generateIndexHtml } from "./shell.ts";

interface RenderResult {
  headers: Record<string, string>;
  html: string;
}

// ── Shared render preparation ────────────────────────────────────────────────

interface PreparedRender {
  componentProps: Record<string, unknown>;
  element: ReactNode;
  /** Set when the prepared element is an error UI. Surfaced to the client via
   * `__FURIN_DATA__.__furinError.digest` and logged server-side. */
  errorDigest?: string;
  headData: string;
  headers: Record<string, string>;
  loader_ms: number;
  /**
   * Slice 8 — populated only when the loader threw `notFound()`. Mirrored into
   * `__FURIN_DATA__.__furinNotFound` so the client-side `classifySpaResponse`
   * can render the not-found UI inline on SPA navigation instead of falling
   * back to a full-page reload.
   */
  notFoundError?: { data?: unknown; message?: string };
  status: number;
  template: string;
}

/**
 * Shared pipeline steps used by both `renderToHTML` (buffered) and `renderSSR`
 * (streaming). Runs loaders, builds props, head injection, resolves template,
 * and creates the React element.
 *
 * Returns the redirect Response directly when a loader redirects, so callers
 * never need try/catch for redirect handling.
 */
async function prepareRender(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  basePath: string | undefined,
  throwOnFailure: boolean
): Promise<PreparedRender | Response> {
  const loaderStart = Date.now();
  const loaderResult = await runLoaders(route, ctx, root.route);
  const loader_ms = Date.now() - loaderStart;

  if (loaderResult.type === "redirect") {
    return loaderResult.response;
  }

  // Build-time paths (SSG) opt into re-throwing so CI fails loudly instead of
  // silently generating a 404/500 page for buggy loaders.
  if (throwOnFailure && (loaderResult.type === "not-found" || loaderResult.type === "error")) {
    throw loaderResult.error;
  }

  const isNotFound = loaderResult.type === "not-found";
  const isError = loaderResult.type === "error";
  const isFallback = isNotFound || isError;
  const data = isFallback ? {} : loaderResult.data;
  const headers = loaderResult.headers;
  const componentProps = {
    ...data,
    params: ctx.params,
    query: ctx.query,
    path: ctx.path,
  };

  const headData = isFallback ? "" : buildHeadInjection(route.page?.head?.(componentProps));

  // An explicitly-set production template (static pre-render, compiled Bun server)
  // always wins over the IS_DEV flag.  This decouples template resolution from the
  // IS_DEV singleton so callers never need to flip IS_DEV just to get the right shell.
  const prodTemplate = getProductionTemplate();
  const template =
    prodTemplate ??
    (IS_DEV ? await getDevTemplate(new URL(ctx.request.url).origin) : generateIndexHtml());

  let element: ReactNode;
  let status = 200;
  let errorDigest: string | undefined;
  let notFoundError: { data?: unknown; message?: string } | undefined;
  if (loaderResult.type === "not-found") {
    element = buildNotFoundElement(route.notFound ?? root.notFound, loaderResult.error);
    status = 404;
    notFoundError = { message: loaderResult.error.message, data: loaderResult.error.data };
  } else if (loaderResult.type === "error") {
    errorDigest = computeErrorDigest(loaderResult.error);
    element = buildErrorElement(route.error ?? root.error, loaderResult.error, errorDigest);
    status = 500;
  } else {
    element = buildElement(route, componentProps, root.route);
  }

  // During static pre-render, inject a RouterContext so Link components render
  // hrefs with the correct basePath prefix and active-state detection works.
  // Only injected when basePath is explicitly provided (opt-in, static adapter only).
  if (basePath !== undefined) {
    const ssrContext: RouterContextValue = {
      basePath,
      currentHref: ctx.path,
      navigate: () => Promise.resolve(),
      prefetch: () => {
        /* noop */
      },
      invalidatePrefetch: () => {
        /* noop */
      },
      refresh: () => Promise.resolve(),
      isNavigating: false,
      defaultPreload: "intent",
      defaultPreloadDelay: 50,
      defaultPreloadStaleTime: 30_000,
    };
    element = createElement(RouterContext.Provider, { value: ssrContext }, element);
  }

  return {
    componentProps,
    element,
    errorDigest,
    headData,
    headers,
    loader_ms,
    notFoundError,
    status,
    template,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderForPath(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  mode: "ssg" | "isr",
  basePath?: string
): Promise<RenderResult | Response> {
  return runInSyntheticRenderScope(
    async () => {
      const resolvedPath = resolvePath(route.pattern, params);
      const ctx: Context = {
        params,
        query: {},
        request: new Request(`${origin}${resolvedPath}`),
        headers: {},
        cookie: {},
        redirect: (url: string, status: number | undefined) =>
          new Response(null, { status: status ?? 302, headers: { Location: url } }),
        set: { headers: {} },
        path: resolvedPath,
      } as Context;

      const prepared = await prepareRender(route, ctx, root, basePath, true);
      if (prepared instanceof Response) {
        return prepared;
      }

      useLogger().set({
        furin: {
          render: mode,
          route: route.pattern,
          loader_ms: prepared.loader_ms,
          ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
        },
      });

      const { componentProps, element, headData, headers, template } = prepared;
      const stream = await renderToReadableStream(element);
      await stream.allReady;
      const reactHtml = await streamToString(stream);
      return {
        html: assembleHTML(template, headData, reactHtml, componentProps),
        headers,
      };
    },
    { route: route.pattern, render: mode }
  );
}

// ── Core pipeline ────────────────────────────────────────────────────────────

export async function renderToHTML(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<RenderResult> {
  const prepared = await prepareRender(route, ctx, root, undefined, false);

  // Redirect — re-throw so callers like prerenderSSG / handleISR can catch it
  if (prepared instanceof Response) {
    throw prepared;
  }

  const { componentProps, element, headData, headers, template } = prepared;

  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);

  return {
    html: assembleHTML(template, headData, reactHtml, componentProps),
    headers,
  };
}

// ── Public render functions ──────────────────────────────────────────────────

export async function renderToStream(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<ReadableStream | Response> {
  const response = await renderSSR(route, ctx, root);
  if (!response.ok) {
    return response;
  }
  return response.body ?? new ReadableStream();
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin = "http://localhost:3000",
  basePath?: string
): Promise<SsgCacheEntry | Response> {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = getSSGCache(resolvedPath);
  if (cached && !IS_DEV) {
    return cached;
  }

  const renderResult = await renderForPath(route, params, root, origin, "ssg", basePath);
  if (renderResult instanceof Response) {
    return renderResult;
  }
  const result = renderResult;

  const entry: SsgCacheEntry = { html: result.html, cachedAt: Date.now() };

  if (!IS_DEV) {
    setSSGCache(resolvedPath, entry);
  }

  return entry;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<Response> {
  const prepared = await prepareRender(route, ctx, root, undefined, false);

  // Redirect — return directly as a Response
  if (prepared instanceof Response) {
    return prepared;
  }

  useLogger().set({
    furin: {
      render: route.mode,
      route: route.pattern,
      loader_ms: prepared.loader_ms,
      ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
    },
  });

  const { componentProps, element, headData, headers, template } = prepared;

  // Split template around placeholders
  const { headPre, bodyPre, bodyPost } = splitTemplate(template);

  // Shell-render gate: if the React shell (pre-Suspense render) throws, recover
  // by rendering the nearest error.tsx. If THAT also throws, fall back to the
  // built-in DefaultErrorComponent to break recursion.
  let reactStream: ReadableStream<Uint8Array>;
  let status = prepared.status;
  let shellErrored = false;
  let finalDigest = prepared.errorDigest;
  try {
    reactStream = await renderToReadableStream(element);
  } catch (shellError) {
    shellErrored = true;
    status = 500;
    finalDigest = computeErrorDigest(shellError);
    // Log the shell-render error — prepared.errorDigest (if any) was for the
    // loader-level error that never made it to the stream; this is a new one.
    useLogger().set({
      furin: { render: route.mode, route: route.pattern, digest: finalDigest, phase: "shell" },
    });
    try {
      reactStream = await renderToReadableStream(
        buildErrorElement(route.error ?? root.error, shellError, finalDigest)
      );
    } catch {
      // User's error.tsx also threw — render the built-in default which is
      // pure markup and cannot crash.
      reactStream = await renderToReadableStream(
        buildErrorElement(undefined, shellError, finalDigest)
      );
    }
  }

  // In error-recovery mode, don't inject loader data (it may contain the
  // failing state that caused the crash). Use an empty payload so rehydration
  // is a no-op rather than repeating the error. When we DO have a digest
  // (either from loader error or shell recovery), expose it under __furinError
  // so the client-side ErrorBoundary can surface the same id on rehydrate.
  const dataPayload: Record<string, unknown> = shellErrored ? {} : { ...componentProps };
  if (finalDigest) {
    dataPayload.__furinError = { digest: finalDigest };
  }
  // Slice 8 — SPA 404 signal. When the loader threw `notFound()`, the response
  // status is 404 and the body contains the rendered not-found UI. We ALSO
  // embed a machine-readable signal in __FURIN_DATA__ so that a mid-SPA-nav
  // client can detect the case without guessing from the HTML, and render the
  // not-found component inline instead of performing a jarring full-page
  // reload. Mirrors the existing `__furinError.digest` channel for 500s.
  if (status === 404 && !shellErrored) {
    dataPayload.__furinStatus = 404;
    if (prepared.notFoundError) {
      dataPayload.__furinNotFound = prepared.notFoundError;
    }
  }
  const dataScript = `<script id="__FURIN_DATA__" type="application/json">${safeJson(
    dataPayload
  )}</script>`;

  // Pipe head + React stream + tail into a single ReadableStream
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    await writer.write(enc.encode(headPre + headData + bodyPre));
    const reader = reactStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await writer.write(value);
    }
    await writer.write(enc.encode(dataScript + bodyPost));
    await writer.close();
  })().catch((err) => writer.abort(err));

  return new Response(readable, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...headers,
    },
  });
}

// ── Catch-all 404 ────────────────────────────────────────────────────────────

/**
 * Renders the root-level not-found component into a complete 404 HTML Response.
 * Used by the Elysia `.onError` catch-all when no route matches the request URL.
 *
 * Template resolution mirrors the main render path:
 *   prod template (if pre-rendered / compiled server)
 *   → dev template from Bun's HTML bundler (in dev, for the rewritten script tag)
 *   → static `generateIndexHtml()` (last-resort fallback; test harness, SSR with no request).
 *
 * The dev-template branch is critical: Bun's HTML bundler rewrites
 * `./_hydrate.tsx` to the hashed client chunk URL (e.g. `/_bun/client/index-*.js`).
 * If we served the raw `generateIndexHtml()` output, the browser would try to
 * load `./_hydrate.tsx` relative to the current URL (e.g. `/foo/_hydrate.tsx`),
 * 404, and the page would be left static — so clicking any in-page link would
 * trigger a full document load instead of SPA navigation.
 *
 * If the user's not-found.tsx itself throws, falls back to the built-in
 * DefaultNotFoundComponent to break recursion.
 *
 * @param root    - Resolved root layout (carries the user's `not-found.tsx` ref).
 * @param request - The incoming request. Required in dev to resolve the HMR
 *   entry origin. Pass `undefined` in contexts where no request is available
 *   (tests, SSG warmup) — the function will fall through to the static shell.
 */
export async function renderRootNotFound(
  root: RootLayout,
  request: Request | undefined
): Promise<Response> {
  const prodTemplate = getProductionTemplate();
  let template: string;
  if (prodTemplate !== null) {
    template = prodTemplate;
  } else if (IS_DEV && request !== undefined) {
    try {
      template = await getDevTemplate(new URL(request.url).origin);
    } catch {
      // Loopback failed (server not listening yet, URL unreachable, etc.) —
      // still return SOMETHING so the user doesn't see a raw error. The
      // generated HTML will be non-interactive (see JSDoc), but that's
      // strictly better than a 500.
      template = generateIndexHtml();
    }
  } else {
    template = generateIndexHtml();
  }
  const notFoundError = new FurinNotFoundError(undefined);

  let reactStream: Awaited<ReturnType<typeof renderToReadableStream>>;
  try {
    reactStream = await renderToReadableStream(buildNotFoundElement(root.notFound, notFoundError));
  } catch {
    // User's not-found.tsx crashed — fall back to the built-in default.
    reactStream = await renderToReadableStream(buildNotFoundElement(undefined, notFoundError));
  }
  await reactStream.allReady;
  const reactHtml = await streamToString(reactStream);
  // Embed the SPA 404 signal so client-side `fetchPageState` can detect the
  // catch-all 404 via `classifySpaResponse` and render inline instead of doing
  // a jarring full-page reload when navigating to an unmatched URL.
  const html = assembleHTML(template, "", reactHtml, { __furinStatus: 404 });

  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── ISR helpers ──────────────────────────────────────────────────────────────

/**
 * Builds the Cache-Control header value for an ISR response.
 * Browser: max-age=0 + must-revalidate forces a conditional request every time.
 * CDN:     s-maxage=N + stale-while-revalidate=N allow CDN-level serving + BG refresh.
 */
function isrCacheControl(isFresh: boolean, revalidate: number): string {
  const sMaxAge = isFresh ? revalidate : 0;
  return `public, max-age=0, must-revalidate, s-maxage=${sMaxAge}, stale-while-revalidate=${revalidate}`;
}

/**
 * Serves a response from an existing ISR cache entry.
 * Handles stale-while-revalidate background refresh and ETag conditional requests.
 * Returns `undefined` when a 304 Not Modified is sent (no body needed).
 */
function serveISRCacheHit(
  cached: ISRCacheEntry,
  ctx: Context,
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  buildId: string
): string | undefined {
  const isFresh = Date.now() - cached.generatedAt < revalidate * 1000;

  // Kick off background refresh for stale entries *before* the ETag check
  // so conditional requests (304) do not permanently suppress cache refreshes.
  if (!isFresh) {
    revalidateInBackground(route, params, cacheKey, revalidate, root, ctx);
  }

  // ETag = "buildId:generatedAt" — encodes both the deploy version and freshness.
  // Only emit when buildId is non-empty (dev has no buildId).
  const etag = buildId ? `"${buildId}:${cached.generatedAt}"` : null;
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    // RFC 7232 §4.1: a 304 MUST echo the ETag and SHOULD include Cache-Control
    // so the browser continues sending If-None-Match on future requests.
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

  useLogger().set({ furin: { render: "isr", route: route.pattern, cache: "hit" } });
  return cached.html;
}

export async function handleISR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId = ""
) {
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const cacheKey = resolvePath(route.pattern, params);

  const cached = getISRCache(cacheKey);
  if (cached && !IS_DEV) {
    return serveISRCacheHit(cached, ctx, route, params, cacheKey, revalidate, root, buildId);
  }

  const renderStart = Date.now();
  const prepared = await prepareRender(route, ctx, root, undefined, false);

  // Redirect — return directly
  if (prepared instanceof Response) {
    return prepared;
  }

  const { componentProps, element, headData, template, status, errorDigest, notFoundError } =
    prepared;

  if (status !== 200) {
    const fallbackProps: Record<string, unknown> = { ...componentProps };
    if (status === 404) {
      fallbackProps.__furinStatus = 404;
      if (notFoundError) {
        fallbackProps.__furinNotFound = notFoundError;
      }
    }
    if (errorDigest) {
      fallbackProps.__furinError = { digest: errorDigest };
    }

    const stream = await renderToReadableStream(element);
    await stream.allReady;
    const reactHtml = await streamToString(stream);
    const html = assembleHTML(template, headData, reactHtml, fallbackProps);
    const generatedAt = Date.now();

    const etag = buildId ? `"${buildId}:${generatedAt}"` : null;
    ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    ctx.set.headers["cache-control"] = isrCacheControl(false, revalidate);
    if (etag) {
      ctx.set.headers.etag = etag;
    }
    ctx.set.status = status;
    return html;
  }

  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);
  const html = assembleHTML(template, headData, reactHtml, componentProps);
  const generatedAt = Date.now();

  useLogger().set({
    furin: {
      render: "isr",
      route: route.pattern,
      cache: "miss",
      render_ms: generatedAt - renderStart,
    },
  });

  if (!IS_DEV) {
    setISRCache(cacheKey, { html, generatedAt, revalidate });
  }

  const etag = buildId ? `"${buildId}:${generatedAt}"` : null;
  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = isrCacheControl(true, revalidate);
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  return html;
}

// ── SSG warm-up ──────────────────────────────────────────────────────────────

/** Maximum number of concurrent `prerenderSSG` calls during SSG warm-up. */
const SSG_WARM_CONCURRENCY = 4;

/**
 * Pre-renders all SSG routes that declare `staticParams` and populates the
 * in-memory cache before the first real request arrives.
 * Should be called from the Elysia `onStart` hook (production only).
 *
 * Uses a bounded worker pool (SSG_WARM_CONCURRENCY slots) so large sites
 * with many routes × param sets cannot exhaust memory or CPU during startup.
 * Failures are isolated per (route, params) pair and logged without aborting
 * the rest of the warm-up.
 */
export async function warmSSGCache(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<void> {
  const targets = routes.filter((r) => r.mode === "ssg" && r.page.staticParams);
  console.log(`[furin] Warming SSG cache for ${targets.length} route(s)…`);

  // Collect all (route, params) render tasks, handling per-route errors early.
  const tasks: Array<() => Promise<void>> = [];
  for (const route of targets) {
    let paramSets: Record<string, string>[];
    try {
      paramSets = (await route.page.staticParams?.()) ?? [];
    } catch (err) {
      console.error(`[furin] SSG warm-up failed for ${route.pattern}:`, err);
      continue;
    }
    for (const params of paramSets) {
      tasks.push(async () => {
        try {
          await prerenderSSG(route, params, root, origin);
        } catch (err) {
          console.error(`[furin] SSG prerender failed for ${route.pattern}:`, err);
        }
      });
    }
  }

  if (tasks.length === 0) {
    return;
  }

  // Drain the task queue with a fixed-size worker pool.
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(SSG_WARM_CONCURRENCY, tasks.length) }, async () => {
    while (queue.length > 0) {
      await queue.shift()?.();
    }
  });
  await Promise.all(workers);
}

/** Tracks in-flight ISR revalidations to prevent thundering herd. */
const pendingRevalidations = new Set<string>();

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  originalCtx: LoaderContext
) {
  if (pendingRevalidations.has(cacheKey)) {
    return; // Already revalidating — skip duplicate work
  }
  pendingRevalidations.add(cacheKey);

  renderForPath(route, params, root, new URL(originalCtx.request.url).origin, "isr")
    .then((result) => {
      if (result instanceof Response) {
        // A loader called ctx.redirect() during ISR revalidation.
        // Silently drop it — the next real request will hit the loader again.
        return;
      }
      setISRCache(cacheKey, {
        html: result.html,
        generatedAt: Date.now(),
        revalidate,
      });
    })
    .catch((err: unknown) => {
      console.error("[furin] ISR background revalidation failed:", err);
    })
    .finally(() => {
      pendingRevalidations.delete(cacheKey);
    });
}
