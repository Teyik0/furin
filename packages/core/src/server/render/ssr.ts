// biome-ignore-all lint/correctness/useHookAtTopLevel: useLogger is not a hook attached to a react component

import type { Context } from "elysia";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import { type DocumentAssets, FurinDocumentFallback } from "../../client/document.tsx";
import { RouterContext } from "../../client/router/context.ts";
import { normalizeHref, toLogical } from "../../client/router/link-utils.ts";
import {
  createSearchStore,
  SearchStoreContext,
  searchSnapshotFromRouterContext,
} from "../../client/router/search-store.ts";
import type { RouterContextValue } from "../../client/router/types.ts";
import type { HeadOptions } from "../../client.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { containsRscSource, serializeRouteFrames } from "../../shared/route-frame.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { runInSyntheticRenderScope, useLogger } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
// FurinNotFoundError is used indirectly via buildNotFoundElement in element.tsx
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import {
  buildDeferredResolution,
  buildDeferredScript,
  buildRouteFrameCloseScript,
  buildRouteFramePushScript,
  buildRouteFrameStreamScript,
  buildRouteFrameTemplate,
  buildSyncRuntimeScript,
  resolvePath,
  streamToString,
} from "./assemble.ts";
import { withDocumentState } from "./document.tsx";
import {
  buildElement,
  buildErrorElement,
  buildNotFoundElement,
  wrapRootLayout,
} from "./element.tsx";
import {
  type LoaderResult,
  runLoaders,
  runPublicLoaders,
  serializeDeferredRejection,
} from "./loaders.ts";
import { serializeDeferredRouteFrame } from "./route-frame-transport.ts";
import { generateIndexHtml, safeJson } from "./shell.ts";
import {
  documentAssetsFromTemplate,
  getDevDocumentAssets,
  getProductionDocumentAssets,
} from "./template.ts";

// Re-export types consumed by sibling render modules (not a public barrel).
export type { LoaderContext } from "./assemble.ts";
export type { LoaderResult } from "./loaders.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RenderResult {
  headers: Record<string, string>;
  html: string;
  /**
   * NDJSON payload (one CrossJSON-serialised line) carrying the loader's
   * resolved sync + deferred data. Identical in shape to the body the live
   * `/_furin/data` endpoint emits, so the SPA client can consume both
   * interchangeably.
   */
  ndjson: string;
  status: number;
}

export interface PreparedRender {
  assets: DocumentAssets;
  /**
   * All props passed to the React component tree. For deferred renders this
   * includes the Promise objects (for `<Await resolve={promise}>`) alongside
   * the scalar sync fields. Never serialise this directly — use `syncData`.
   */
  componentProps: Record<string, unknown>;
  /**
   * Promise-valued fields from a `defer()` loader return. Undefined for normal
   * (non-deferred) loaders. These are streamed as late `<script>` chunks after
   * the React stream finishes.
   */
  deferredPromises: Record<string, Promise<unknown>> | undefined;
  element: ReactNode;
  /** Set when the prepared element is an error UI. */
  errorDigest?: string;
  headData: HeadOptions | undefined;
  headers: Record<string, string>;
  loader_ms: number;
  /**
   * Populated only when the loader threw `notFound()`. Mirrored into
   * `__FURIN_DATA__.__furinNotFound` so the client-side can render the
   * not-found UI inline on SPA navigation.
   */
  notFoundError?: { data?: unknown; message?: string };
  ssrContext: RouterContextValue;
  status: number;
  /**
   * JSON-serialisable subset of `componentProps`. For deferred renders this
   * excludes the Promise fields (those are streamed separately).
   */
  syncData: Record<string, unknown>;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function withSSRRouterContext(
  element: ReactNode,
  contextValue: RouterContextValue
): ReactNode {
  return createElement(
    SearchStoreContext.Provider,
    { value: createSearchStore(searchSnapshotFromRouterContext(contextValue)) },
    createElement(RouterContext.Provider, { value: contextValue }, element)
  );
}

interface ShellFallbackResult {
  /**
   * Set when the primary element threw synchronously during render and a
   * fallback error UI was streamed instead. Carries the digest so the caller
   * can surface it in logs and the `__furinError` payload.
   */
  shellError: { digest: string } | undefined;
  stream: Awaited<ReturnType<typeof renderToReadableStream>>;
}

async function requireDocumentStream(
  stream: Awaited<ReturnType<typeof renderToReadableStream>>
): Promise<Awaited<ReturnType<typeof renderToReadableStream>>> {
  const reader = stream.getReader();
  const first = await reader.read();
  const prefix = first.value === undefined ? "" : new TextDecoder().decode(first.value);
  if (first.done || !prefix.startsWith("<!DOCTYPE html><html")) {
    await reader.cancel();
    throw new Error(
      "[furin] The root layout must render an <html> document containing <HeadContent /> and <Scripts />."
    );
  }

  const validated = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await reader.cancel(reason);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    start(controller) {
      controller.enqueue(first.value);
    },
  }) as Awaited<ReturnType<typeof renderToReadableStream>>;
  Object.defineProperty(validated, "allReady", { value: stream.allReady });
  return validated;
}

/**
 * Renders `element` to a React stream, recovering from a synchronous shell
 * throw with a 500 error UI. The supplied error component (route-level, else
 * root-level) is tried first; if it ALSO throws, the built-in error element is
 * used, so a broken custom error page can never take down the whole response.
 *
 * Shared by SSR (which pipes the stream) and ISR/SSG non-200 (which drains it
 * to a string) — both start from this same React stream and only diverge in how
 * they consume it and which fields they log.
 */
export async function renderElementWithShellFallback(
  element: ReactNode,
  errorComponent: Parameters<typeof buildErrorElement>[0],
  ssrContext: RouterContextValue,
  wrapFallbackDocument: (element: ReactNode, digest: string) => ReactNode
): Promise<ShellFallbackResult> {
  try {
    const stream = await renderToReadableStream(element);
    return { shellError: undefined, stream: await requireDocumentStream(stream) };
  } catch (error) {
    const digest = computeErrorDigest(error);
    try {
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(errorComponent, error, digest, undefined, 500),
            ssrContext
          ),
          digest
        )
      );
      return { shellError: { digest }, stream: await requireDocumentStream(stream) };
    } catch {
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(undefined, error, digest, undefined, 500),
            ssrContext
          ),
          digest
        )
      );
      return { shellError: { digest }, stream: await requireDocumentStream(stream) };
    }
  }
}

/**
 * defer() streams data progressively — it only makes sense in SSR. In SSG/ISR
 * the HTML is pre-rendered and cached, so the deferred fields would be absent
 * from the embedded `__FURIN_DATA__` and the client `<Await>` would hydrate
 * with `undefined`. Fail fast at the loader boundary.
 */
export function assertDeferredModeAllowed(
  route: ResolvedRoute,
  deferredPromises: Record<string, Promise<unknown>> | undefined
): void {
  const deferredKeys = Object.keys(deferredPromises ?? {}).filter((key) => key !== "requestData");
  if (deferredKeys.length > 0 && route.mode !== "ssr") {
    throw new Error(
      `[furin] page "${route.pattern}" returned defer() but the route is rendered in "${route.mode}" mode. ` +
        "defer() streams data progressively and is only supported in SSR. " +
        "Return the data directly (await it inside the loader) or switch the route to SSR mode."
    );
  }
}

function currentHrefFromContext(ctx: Context, basePath: string): string {
  const pathUrl = new URL(ctx.path, "http://furin.local");
  const requestUrl = new URL(ctx.request.url);
  // For a prefixed Elysia plugin `ctx.path` is PHYSICAL (includes the mount
  // prefix). `RouterContextValue.currentHref` must be LOGICAL — the client
  // provider strips basePath the same way — or Link active-state and SSR/CSR
  // markup diverge. Synthetic renders pass logical paths; toLogical no-ops.
  return (
    normalizeHref(toLogical(pathUrl.pathname, basePath)) + (pathUrl.search || requestUrl.search)
  );
}

/**
 * Builds the success-path element and head injection. `head()` is user code
 * that runs synchronously, outside the render pipeline's shell-error handling,
 * so a throw is converted into a 500 error render that surfaces through the
 * framework error UI instead of escaping `prepareRender` and crashing the
 * request. Re-throws when `throwOnFailure` is set (build-time SSG) so CI fails
 * loudly.
 */
function buildSuccessRender(
  route: ResolvedRoute,
  root: RootLayout,
  componentProps: Record<string, unknown>,
  throwOnFailure: boolean
): {
  element: ReactNode;
  errorDigest: string | undefined;
  headData: HeadOptions | undefined;
  status: number;
} {
  try {
    const headData = route.page.head?.(componentProps);
    const element = buildElement(route, componentProps, root.route);
    return { element, errorDigest: undefined, headData, status: 200 };
  } catch (headError) {
    if (throwOnFailure) {
      throw headError;
    }
    const errorDigest = computeErrorDigest(headError);
    const element = buildErrorElement(
      route.error ?? root.error,
      headError,
      errorDigest,
      undefined,
      500
    );
    return { element, errorDigest, headData: undefined, status: 500 };
  }
}

function resolveDocumentAssets(ctx: Context): DocumentAssets | Promise<DocumentAssets> {
  const productionAssets = getProductionDocumentAssets();
  if (productionAssets !== null) {
    return productionAssets;
  }
  if (IS_DEV && ctx.server) {
    return getDevDocumentAssets(ctx.server.url.origin);
  }
  return documentAssetsFromTemplate(generateIndexHtml());
}

/**
 * Shared pipeline steps used by both `renderToHTML` (buffered) and `renderSSR`
 * (streaming). Runs loaders, builds props, head data, resolves assets,
 * and creates the React element.
 *
 * Returns the redirect Response directly when a loader redirects, so callers
 * never need try/catch for redirect handling.
 */
export async function prepareRender(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  basePath: string | undefined,
  throwOnFailure: boolean,
  precomputedLoaderResult: LoaderResult | undefined,
  searchRoutes?: SearchRouteMetadata[]
): Promise<PreparedRender | Response> {
  const loaderStart = Date.now();
  const loaderResult = precomputedLoaderResult ?? (await runLoaders(route, ctx));
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
  const syncData = isFallback ? {} : loaderResult.syncData;
  const deferredPromises =
    !isFallback && loaderResult.type === "data" ? loaderResult.deferredPromises : undefined;
  assertDeferredModeAllowed(route, deferredPromises);

  const { headers } = loaderResult;
  const componentProps = {
    ...syncData,
    ...(deferredPromises ?? {}),
    params: ctx.params,
    path: ctx.path,
    query: ctx.query,
  };

  const assets = await resolveDocumentAssets(ctx);

  let element: ReactNode;
  let headData: HeadOptions | undefined;
  let status = 200;
  let errorDigest: string | undefined;
  let notFoundError: { data?: unknown; message?: string } | undefined;
  if (loaderResult.type === "not-found") {
    element = buildNotFoundElement(route.notFound ?? root.notFound, loaderResult.error);
    status = 404;
    notFoundError = { data: loaderResult.error.data, message: loaderResult.error.message };
  } else if (loaderResult.type === "error") {
    const { status: errorStatus } = loaderResult;
    errorDigest = computeErrorDigest(loaderResult.error);
    element = buildErrorElement(
      route.error ?? root.error,
      loaderResult.error,
      errorDigest,
      loaderResult.message,
      errorStatus
    );
    status = errorStatus;
  } else {
    ({ element, errorDigest, headData, status } = buildSuccessRender(
      route,
      root,
      componentProps,
      throwOnFailure
    ));
  }
  if (isFallback) {
    element = wrapRootLayout(element, componentProps, root.route);
  }

  // Explicit basePath (static export) wins; otherwise resolve the mount
  // prefix of the instance serving this render so SSR'd <Link> hrefs match
  // the prefix-aware client hydration entry (built with `basePath: prefix`).
  const resolvedBasePath = basePath ?? currentInstance().prefix;
  const ssrContext: RouterContextValue = {
    basePath: resolvedBasePath,
    currentHref: currentHrefFromContext(ctx, resolvedBasePath),
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    invalidatePrefetch: (_path, _type) => {
      /* noop */
    },
    isNavigating: false,
    navigate: (_href, _opts) => Promise.resolve(),
    prefetch: (_href, _opts) => {
      /* noop */
    },
    refresh: (_opts) => Promise.resolve(),
    search: (ctx.query as SearchParamsInput | undefined) ?? {},
    searchRoutes: searchRoutes ?? [],
  };
  element = withSSRRouterContext(element, ssrContext);

  return {
    assets,
    componentProps,
    deferredPromises,
    element,
    errorDigest,
    headData,
    headers,
    loader_ms,
    notFoundError,
    ssrContext,
    status,
    syncData,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function renderForPath(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  mode: "ssg" | "isr",
  basePath?: string,
  searchRoutes?: SearchRouteMetadata[],
  search?: string
): Promise<RenderResult | Response> {
  return runInSyntheticRenderScope(
    async () => {
      const resolvedPath = resolvePath(route.pattern, params);
      const requestUrl = new URL(`${resolvedPath}${search ?? ""}`, origin);
      const query: { [key: string]: string | string[] } = Object.create(null);
      for (const [key, value] of requestUrl.searchParams) {
        const previous = query[key];
        if (previous === undefined) {
          query[key] = value;
        } else if (Array.isArray(previous)) {
          previous.push(value);
        } else {
          query[key] = [previous, value];
        }
      }
      const ctx: Context = {
        cookie: {},
        headers: {},
        params,
        path: resolvedPath,
        query,
        redirect: (url: string, redirectStatus: number | undefined) =>
          new Response(null, { headers: { Location: url }, status: redirectStatus ?? 302 }),
        request: new Request(requestUrl),
        set: { headers: {} },
      } as Context;

      const loaderResult = await runPublicLoaders(route, ctx);
      const prepared = await prepareRender(
        route,
        ctx,
        root,
        basePath,
        true,
        loaderResult,
        searchRoutes
      );
      if (prepared instanceof Response) {
        return prepared;
      }

      useLogger().set({
        furin: {
          cache: mode === "isr" ? "revalidated" : "miss",
          loader_ms: prepared.loader_ms,
          render: mode,
          route: route.pattern,
          ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
        },
      });

      const { assets, deferredPromises, element, headData, headers, status, syncData } = prepared;
      const stream = await renderToReadableStream(
        withDocumentState(element, assets, headData, syncData)
      );
      await stream.allReady;
      const reactHtml = await streamToString(stream);
      return {
        headers,
        html: reactHtml,
        ndjson: await serializeLoaderDataNdjson(syncData, deferredPromises),
        status,
      };
    },
    { render: mode, route: route.pattern }
  );
}

interface SsrTransportScripts {
  deferredSetupScript: string;
  runtimeScripts: string;
  usesRouteFrames: boolean;
}

async function pipeDocumentStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  beforeEntry: string,
  beforeBodyClose: () => Promise<string>
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: ReadableStream chunks must be consumed in order.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    if (pending.length > 1024) {
      await writer.write(enc.encode(pending.slice(0, -1024)));
      pending = pending.slice(-1024);
    }
  }
  pending += decoder.decode();

  const entryIndex = pending.lastIndexOf("<script");
  const entryIsInTail =
    entryIndex !== -1 && pending.slice(entryIndex).includes('data-furin-entry=""');
  const bodyCloseIndex = pending.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex === -1) {
    await writer.write(enc.encode(pending + beforeEntry + (await beforeBodyClose())));
    return;
  }

  let documentTail = pending;
  if (beforeEntry && entryIsInTail) {
    documentTail = pending.slice(0, entryIndex) + beforeEntry + pending.slice(entryIndex);
  } else if (beforeEntry) {
    documentTail = pending.slice(0, bodyCloseIndex) + beforeEntry + pending.slice(bodyCloseIndex);
  }
  const adjustedBodyCloseIndex = documentTail.toLowerCase().lastIndexOf("</body>");
  const lateScripts = await beforeBodyClose();
  await writer.write(
    enc.encode(
      documentTail.slice(0, adjustedBodyCloseIndex) +
        lateScripts +
        documentTail.slice(adjustedBodyCloseIndex)
    )
  );
}

function buildSsrTransportScripts(
  dataPayload: Record<string, unknown>,
  deferredKeys: string[],
  hasDeferred: boolean,
  shellErrored: boolean
): SsrTransportScripts {
  const usesRouteFrames = !shellErrored && (containsRscSource(dataPayload) || hasDeferred);
  const deferredSetupScript =
    hasDeferred && !usesRouteFrames ? buildDeferredScript(deferredKeys) : "";
  const dataScript = usesRouteFrames
    ? buildRouteFrameTemplate(
        serializeRouteFrames(dataPayload, hasDeferred ? deferredKeys : undefined)
      )
    : `<script id="__FURIN_DATA__" type="application/json">${safeJson(dataPayload)}</script>`;
  const routeFrameStreamScript =
    hasDeferred && usesRouteFrames ? buildRouteFrameStreamScript() : "";

  return {
    deferredSetupScript,
    runtimeScripts: `${buildSyncRuntimeScript()}${routeFrameStreamScript}${dataScript}`,
    usesRouteFrames,
  };
}

async function writeDeferredSsrChunk(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  key: string,
  promise: Promise<unknown>,
  index: number,
  usesRouteFrames: boolean
): Promise<void> {
  if (usesRouteFrames) {
    const frames = await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
    await writer.write(enc.encode(buildRouteFramePushScript(frames)));
    return;
  }

  try {
    const resolvedValue = await promise;
    const chunk = toCrossJSON(resolvedValue);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "resolve")));
  } catch (err) {
    const normalized = await serializeDeferredRejection(err);
    const chunk = toCrossJSON(normalized);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "reject")));
  }
}

async function writeDeferredSsrChunks(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  deferredPromises: Record<string, Promise<unknown>>,
  usesRouteFrames: boolean
): Promise<void> {
  await Promise.all(
    Object.entries(deferredPromises).map(([key, promise], index) =>
      writeDeferredSsrChunk(writer, enc, key, promise, index, usesRouteFrames)
    )
  );
  if (usesRouteFrames) {
    await writer.write(enc.encode(buildRouteFrameCloseScript()));
  }
}

/**
 * Serialises a loader's `syncData` + `deferredPromises` into the same one-line
 * NDJSON shape the live `/_furin/data` endpoint emits.
 */
export async function serializeLoaderDataNdjson(
  syncData: Record<string, unknown>,
  deferredPromises: Record<string, Promise<unknown>> | undefined
): Promise<string> {
  const payload: Record<string, unknown> = {
    ...syncData,
    ...(deferredPromises ?? {}),
  };
  if (containsRscSource(payload) || deferredPromises !== undefined) {
    const deferredEntries = Object.entries(deferredPromises ?? {});
    let ndjson = serializeRouteFrames(
      syncData,
      deferredEntries.length > 0 ? deferredEntries.map(([key]) => key) : undefined
    );
    await Promise.all(
      deferredEntries.map(async ([key, promise], index) => {
        ndjson += await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
      })
    );
    return ndjson;
  }
  const serialized = await toCrossJSONAsync(payload);
  return `${JSON.stringify(serialized)}\n`;
}

// ── Core pipeline ────────────────────────────────────────────────────────────

export async function renderToHTML(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes?: SearchRouteMetadata[]
): Promise<RenderResult> {
  const prepared = await prepareRender(route, ctx, root, undefined, false, undefined, searchRoutes);

  if (prepared instanceof Response) {
    throw prepared;
  }

  const { assets, deferredPromises, element, headData, headers, status, syncData } = prepared;

  const stream = await renderToReadableStream(
    withDocumentState(element, assets, headData, syncData)
  );
  await stream.allReady;
  const reactHtml = await streamToString(stream);

  return {
    headers,
    html: reactHtml,
    ndjson: await serializeLoaderDataNdjson(syncData, deferredPromises),
    status,
  };
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  precomputedLoaderResult: LoaderResult | undefined,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response> {
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    undefined,
    false,
    precomputedLoaderResult,
    searchRoutes
  );

  if (prepared instanceof Response) {
    return prepared;
  }

  useLogger().set({
    furin: {
      loader_ms: prepared.loader_ms,
      render: route.mode,
      route: route.pattern,
      ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
    },
  });

  const { assets, deferredPromises, element, headData, headers, syncData } = prepared;

  const initialDataPayload: Record<string, unknown> = { ...syncData };
  if (prepared.errorDigest) {
    initialDataPayload.__furinError = {
      digest: prepared.errorDigest,
      status: prepared.status,
    };
  }
  if (prepared.status === 404 && prepared.notFoundError) {
    initialDataPayload.__furinNotFound = prepared.notFoundError;
    initialDataPayload.__furinStatus = 404;
  }
  const requiresTransport = deferredPromises !== undefined || containsRscSource(initialDataPayload);

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    withDocumentState(
      element,
      assets,
      headData,
      requiresTransport ? undefined : initialDataPayload
    ),
    route.error ?? root.error,
    prepared.ssrContext,
    (fallback, digest) =>
      withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
        __furinError: { digest, status: 500 },
        __furinStatus: 500,
      })
  );
  const shellErrored = shellError !== undefined;
  let { errorDigest: finalDigest, status } = prepared;
  if (shellError) {
    status = 500;
    finalDigest = shellError.digest;
    useLogger().set({
      furin: { digest: finalDigest, phase: "shell", render: route.mode, route: route.pattern },
    });
  }

  const dataPayload: Record<string, unknown> = shellErrored ? {} : { ...syncData };
  if (finalDigest) {
    dataPayload.__furinError = { digest: finalDigest, status };
  }
  if (status === 404 && !shellErrored) {
    dataPayload.__furinStatus = 404;
    if (prepared.notFoundError) {
      dataPayload.__furinNotFound = prepared.notFoundError;
    }
  }
  if (
    process.env.NODE_ENV !== "production" &&
    dataPayload.__furinError !== undefined &&
    dataPayload.__furinNotFound !== undefined
  ) {
    throw new Error(
      "[furin] internal invariant violated: __furinError and __furinNotFound were both set on the same SSR payload."
    );
  }

  const hasDeferred = !shellErrored && deferredPromises !== undefined;

  const deferredKeys = hasDeferred ? Object.keys(deferredPromises) : [];
  const { deferredSetupScript, runtimeScripts, usesRouteFrames } = buildSsrTransportScripts(
    dataPayload,
    deferredKeys,
    hasDeferred,
    shellErrored
  );

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    const reader = reactStream.getReader();
    await pipeDocumentStream(
      reader,
      writer,
      enc,
      hasDeferred || usesRouteFrames ? deferredSetupScript + runtimeScripts : "",
      async () => {
        if (!hasDeferred) {
          return "";
        }
        const { readable: chunkReadable, writable: chunkWritable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        const chunkWriter = chunkWritable.getWriter();
        const chunkText = streamToString(chunkReadable);
        await writeDeferredSsrChunks(chunkWriter, enc, deferredPromises, usesRouteFrames);
        await chunkWriter.close();
        return chunkText;
      }
    );
    await writer.close();
  })().catch((err) => writer.abort(err));

  return new Response(readable, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Type": "text/html; charset=utf-8",
      ...headers,
    },
    status,
  });
}
