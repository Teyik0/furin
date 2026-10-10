import type { Context } from "elysia";
import { createElement, type ReactNode } from "react";
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
import { isJsonObject, serializeCompactJsonLine } from "../../shared/compact-json.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { isProductionBuild } from "../../shared/production-build.ts";
import { containsRscSource, serializeRouteFrames } from "../../shared/route-frame.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { queryTagsFromData } from "../../shared/sync-query.ts";
import { getLogger, runInSyntheticRenderScope } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
import { mergeRouteSchemas } from "../router/schema-merge.ts";
import { parseRouteParams, parseRouteQuery } from "../router/schemas.ts";
// FurinNotFoundError is used indirectly via buildNotFoundElement in element.tsx
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import { useRequestCspNonce } from "../security/csp.ts";
import {
  buildDeferredResolution,
  buildDeferredScript,
  buildRouteFrameCloseScript,
  buildRouteFramePushScript,
  buildRouteFrameStreamScript,
  buildRouteFrameTemplate,
  resolvePath,
  streamToString,
} from "./assemble.ts";
import { withDocumentState } from "./document.tsx";
import {
  buildElement,
  buildErrorElement,
  buildNotFoundElement,
  errorMessageForRender,
  wrapRootLayout,
} from "./element.tsx";
import {
  hasMixedLoaderModes,
  hasSsrLoaderAncestor,
  type LoaderResult,
  runPublicLoaders,
  runRouteLoaders,
  runSegmentPublicLoaders,
  serializeDeferredRejection,
} from "./loaders.ts";
import { renderToReadableStream } from "./react-stream.ts";
import { serializeDeferredRouteFrame } from "./route-frame-transport.ts";
import { generateIndexHtml, safeJson } from "./shell.ts";
import {
  documentAssetsFromTemplate,
  getDevDocumentAssets,
  getProductionDocumentAssets,
  getProductionPreloadManifest,
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
  queryTags?: string[];
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
  /** Public message rendered by the server error UI and serialized for hydration. */
  errorMessage?: string;
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
  shellError: { digest: string; message: string } | undefined;
  stream: Awaited<ReturnType<typeof renderToReadableStream>>;
}

function serializedErrorPayload(
  digest: string | undefined,
  message: string | undefined,
  status: number
): { digest: string; message: string; status: number } | undefined {
  return digest !== undefined && message !== undefined ? { digest, message, status } : undefined;
}

export function renderPayload(
  prepared: PreparedRender,
  shellError: { digest: string; message: string } | undefined
): { [key: string]: unknown } {
  const payload: { [key: string]: unknown } = shellError ? {} : { ...prepared.syncData };
  const status = shellError ? 500 : prepared.status;
  const error = serializedErrorPayload(
    shellError?.digest ?? prepared.errorDigest,
    shellError?.message ?? prepared.errorMessage,
    status
  );
  if (error) {
    payload.__furinError = error;
  }
  if (status === 404 && !shellError) {
    payload.__furinStatus = 404;
    if (prepared.notFoundError) {
      payload.__furinNotFound = prepared.notFoundError;
    }
  }
  if (shellError) {
    payload.__furinStatus = 500;
  }
  return payload;
}

function hasDocumentMarkers(html: string): boolean {
  return html.includes('data-furin-head=""') && html.includes('data-furin-scripts=""');
}

async function requireDocumentStream(
  stream: Awaited<ReturnType<typeof renderToReadableStream>>
): Promise<Awaited<ReturnType<typeof renderToReadableStream>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  const cancelReader = async (reason: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };
  let prefix = "";
  let done = false;
  while (!(done || hasDocumentMarkers(prefix))) {
    // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be inspected in order.
    const { done: streamDone, value } = await reader.read().catch((error: unknown) => {
      reader.releaseLock();
      throw error;
    });
    done = streamDone;
    if (value !== undefined) {
      buffered.push(value);
      prefix += decoder.decode(value, { stream: !done });
    }
  }
  if (!(prefix.startsWith("<!DOCTYPE html><html") && hasDocumentMarkers(prefix))) {
    await cancelReader(undefined);
    throw new Error(
      "[furin] The root layout must render an <html> document containing <HeadContent /> and <Scripts />."
    );
  }

  const validated = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await cancelReader(reason);
    },
    async pull(controller) {
      const next = await reader.read().catch((error: unknown) => {
        reader.releaseLock();
        throw error;
      });
      if (next.done) {
        reader.releaseLock();
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    start(controller) {
      for (const chunk of buffered) {
        controller.enqueue(chunk);
      }
      if (done) {
        reader.releaseLock();
        controller.close();
      }
    },
  }) as Awaited<ReturnType<typeof renderToReadableStream>>;
  Object.defineProperty(validated, "allReady", { value: stream.allReady });
  return validated;
}

/**
 * Renders `element` to a React stream. Development propagates synchronous shell
 * failures to its diagnostic overlay. Production recovers with a 500 error UI:
 * the supplied error component (route-level, else root-level) is tried first;
 * if it ALSO throws, the built-in error element is used.
 *
 * Shared by SSR (which pipes the stream) and ISR/SSG non-200 (which drains it
 * to a string) — both start from this same React stream and only diverge in how
 * they consume it and which fields they log.
 */
export async function renderElementWithShellFallback(
  element: ReactNode,
  errorComponent: Parameters<typeof buildErrorElement>[0],
  ssrContext: RouterContextValue,
  wrapFallbackDocument: (element: ReactNode, digest: string, message: string) => ReactNode,
  nonce?: string,
  signal?: AbortSignal
): Promise<ShellFallbackResult> {
  const options = { nonce, signal };
  try {
    const stream = await renderToReadableStream(element, options);
    return { shellError: undefined, stream: await requireDocumentStream(stream) };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (IS_DEV) {
      throw error;
    }
    const digest = computeErrorDigest(error);
    try {
      const message = errorMessageForRender(errorComponent, error, undefined);
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(errorComponent, error, digest, message, 500),
            ssrContext
          ),
          digest,
          message
        ),
        options
      );
      return { shellError: { digest, message }, stream: await requireDocumentStream(stream) };
    } catch {
      const message = errorMessageForRender(undefined, error, undefined);
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(undefined, error, digest, message, 500),
            ssrContext
          ),
          digest,
          message
        ),
        options
      );
      return { shellError: { digest, message }, stream: await requireDocumentStream(stream) };
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
  const requestKeys = new Set(route.requestKeys);
  const deferredKeys = Object.keys(deferredPromises ?? {}).filter((key) => !requestKeys.has(key));
  if (deferredKeys.length > 0 && route.mode !== "ssr" && !hasSsrLoaderAncestor(route)) {
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
  headContext: Record<string, unknown>,
  throwOnFailure: boolean
): {
  element: ReactNode;
  errorDigest: string | undefined;
  errorMessage: string | undefined;
  headData: HeadOptions | undefined;
  status: number;
} {
  try {
    const headData = route.page.head?.({ ...headContext });
    const element = buildElement(route, componentProps, root.route);
    return { element, errorDigest: undefined, errorMessage: undefined, headData, status: 200 };
  } catch (headError) {
    if (throwOnFailure) {
      throw headError;
    }
    const errorDigest = computeErrorDigest(headError);
    const errorMessage = errorMessageForRender(route.error ?? root.error, headError, undefined);
    const element = buildErrorElement(
      route.error ?? root.error,
      headError,
      errorDigest,
      errorMessage,
      500
    );
    return { element, errorDigest, errorMessage, headData: undefined, status: 500 };
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

function withRouteModulePreloads(assets: DocumentAssets, pattern: string): DocumentAssets {
  const modulePreloads = getProductionPreloadManifest()?.routes[pattern];
  return modulePreloads ? { ...assets, modulePreloads } : assets;
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
  const loaderResult = precomputedLoaderResult ?? (await runRouteLoaders(route, ctx));
  const loader_ms = Date.now() - loaderStart;

  if (loaderResult.type === "redirect") {
    return loaderResult.response;
  }

  // Build-time paths (SSG) rethrow loader failures; authored notFound results
  // still render their 404 document for static export.
  if (throwOnFailure && loaderResult.type === "error") {
    throw loaderResult.error;
  }

  const isNotFound = loaderResult.type === "not-found";
  const isError = loaderResult.type === "error";
  const isFallback = isNotFound || isError;
  const syncData = isFallback
    ? { params: ctx.params, path: ctx.path, query: ctx.query }
    : loaderResult.syncData;
  const deferredPromises =
    !isFallback && loaderResult.type === "data" ? loaderResult.deferredPromises : undefined;
  assertDeferredModeAllowed(route, deferredPromises);

  const { headers } = loaderResult;
  const componentProps =
    deferredPromises === undefined ? syncData : { ...syncData, ...deferredPromises };

  const assets = withRouteModulePreloads(await resolveDocumentAssets(ctx), route.pattern);
  const errorComponent = route.error ?? root.error;

  let element: ReactNode;
  let headData: HeadOptions | undefined;
  let status = 200;
  let errorDigest: string | undefined;
  let errorMessage: string | undefined;
  let notFoundError: { data?: unknown; message?: string } | undefined;
  if (loaderResult.type === "not-found") {
    element = buildNotFoundElement(route.notFound ?? root.notFound, loaderResult.error);
    status = 404;
    notFoundError = { data: loaderResult.error.data, message: loaderResult.error.message };
  } else if (loaderResult.type === "error") {
    const { status: errorStatus } = loaderResult;
    errorDigest = computeErrorDigest(loaderResult.error);
    errorMessage = errorMessageForRender(errorComponent, loaderResult.error, loaderResult.message);
    element = buildErrorElement(
      errorComponent,
      loaderResult.error,
      errorDigest,
      errorMessage,
      errorStatus
    );
    status = errorStatus;
  } else {
    ({ element, errorDigest, errorMessage, headData, status } = buildSuccessRender(
      route,
      root,
      componentProps,
      syncData,
      throwOnFailure
    ));
  }
  if (isFallback || status !== 200) {
    element = wrapRootLayout(element, componentProps, root.route);
  }

  // Explicit basePath (static export) wins; otherwise resolve the mount
  // prefix of the instance serving this render so SSR'd <Link> hrefs match
  // the prefix-aware client hydration entry (built with `basePath: prefix`).
  const resolvedBasePath = basePath ?? currentInstance().prefix;
  const ssrContext: RouterContextValue = {
    basePath: resolvedBasePath,
    currentHref: currentHrefFromContext(ctx, resolvedBasePath),
    currentPattern: route.pattern,
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
    errorMessage,
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

export function renderPreparedDocument(
  prepared: PreparedRender,
  route: ResolvedRoute,
  root: RootLayout,
  data: object,
  fallbackData: object
): Promise<ShellFallbackResult> {
  const { assets, element, headData } = prepared;
  return renderElementWithShellFallback(
    withDocumentState(element, assets, headData, data),
    route.error ?? root.error,
    prepared.ssrContext,
    (fallback, digest, message) =>
      withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
        ...fallbackData,
        __furinError: { digest, message, status: 500 },
        __furinStatus: 500,
      })
  );
}

async function renderBufferedResult(
  prepared: PreparedRender,
  route: ResolvedRoute,
  root: RootLayout
): Promise<RenderResult> {
  const { deferredPromises, headers, syncData } = prepared;
  const payload = renderPayload(prepared, undefined);
  const { shellError, stream } = await renderPreparedDocument(prepared, route, root, payload, {});
  await stream.allReady;
  const html = await streamToString(stream);
  return {
    headers,
    html,
    ndjson: await serializeLoaderDataNdjson(
      shellError ? renderPayload(prepared, shellError) : payload,
      shellError ? undefined : deferredPromises
    ),
    ...(shellError ? {} : { queryTags: queryTagsFromData(syncData) }),
    status: shellError ? 500 : prepared.status,
  };
}

async function normalizePrerenderContext(
  route: ResolvedRoute,
  ctx: Omit<Context, "params" | "query"> & {
    params: { [key: string]: unknown };
    query: SearchParamsInput;
  }
): Promise<void> {
  const parsedParams = await parseRouteParams(
    ctx.params,
    mergeRouteSchemas(route.routeChain, "params")
  );
  if (!parsedParams.ok) {
    throw new Error(`[furin] Invalid prerender params for "${route.pattern}".`, {
      cause: parsedParams.errors,
    });
  }
  ctx.params = parsedParams.params;
  const querySchema = mergeRouteSchemas(route.routeChain, "query");
  if (querySchema === undefined) {
    return;
  }
  const parsedQuery = await parseRouteQuery(new URL(ctx.request.url), querySchema);
  if (!parsedQuery.ok) {
    throw new Error(`[furin] Invalid prerender query for "${route.pattern}".`, {
      cause: parsedQuery.errors,
    });
  }
  ctx.query = parsedQuery.query;
}

export function renderForPath(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  mode: "ssg" | "isr",
  basePath?: string,
  searchRoutes?: SearchRouteMetadata[],
  search?: string,
  requestContext?: Context
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
      const ctx: Context =
        requestContext ??
        ({
          cookie: {},
          headers: {},
          params,
          path: resolvedPath,
          query,
          redirect: (url: string, redirectStatus: number | undefined) =>
            new Response(null, { headers: { Location: url }, status: redirectStatus ?? 302 }),
          request: new Request(requestUrl),
          set: { headers: {} },
        } as Context);

      if (requestContext === undefined) {
        await normalizePrerenderContext(route, ctx);
      }

      const loaderResult = await (hasMixedLoaderModes(route)
        ? runSegmentPublicLoaders(route, ctx)
        : runPublicLoaders(route, ctx));
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

      getLogger().set({
        furin: {
          cache: mode === "isr" ? "revalidated" : "miss",
          loader_ms: prepared.loader_ms,
          render: mode,
          route: route.pattern,
          ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
        },
      });

      return renderBufferedResult(prepared, route, root);
    },
    { render: mode, route: route.pattern }
  );
}

interface SsrTransportScripts {
  deferredSetupScript: string;
  runtimeScripts: string;
  usesRouteFrames: boolean;
}

export function injectAfterEntry(
  html: string,
  injection: string,
  fallbackIndex: number,
  hasEntryModule: boolean
): string | undefined {
  const entryMarkerIndex = html.indexOf('data-furin-entry=""');
  if (entryMarkerIndex === -1) {
    if (hasEntryModule) {
      return;
    }
    return html.slice(0, fallbackIndex) + injection + html.slice(fallbackIndex);
  }
  const entryEndIndex = html.indexOf("</script>", entryMarkerIndex);
  if (entryEndIndex === -1) {
    return;
  }
  const insertionIndex = entryEndIndex + "</script>".length;
  return html.slice(0, insertionIndex) + injection + html.slice(insertionIndex);
}

function scriptsMarkerEnd(html: string): number | undefined {
  const markerIndex = html.indexOf('data-furin-scripts=""');
  if (markerIndex === -1) {
    return;
  }
  const closeIndex = html.indexOf("</script>", markerIndex);
  return closeIndex === -1 ? undefined : closeIndex + "</script>".length;
}

async function pipeDocumentStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  beforeEntry: string,
  hasEntryModule: boolean,
  beforeBodyClose: () => Promise<void>,
  documentFooter: () => string
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let entryHandled = false;
  let deferredWrites: Promise<void> | undefined;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: ReadableStream chunks must be consumed in order.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    if (entryHandled) {
      await writer.write(enc.encode(chunk));
      continue;
    }

    pending += chunk;
    const scriptsEndIndex = scriptsMarkerEnd(pending);
    if (scriptsEndIndex !== undefined) {
      const entryMarker = pending.indexOf('data-furin-entry=""');
      const entryEnd = entryMarker === -1 ? -1 : pending.indexOf("</script>", entryMarker);
      const shellEnd = entryEnd === -1 ? scriptsEndIndex : entryEnd + "</script>".length;
      const shell = injectAfterEntry(
        pending.slice(0, shellEnd),
        beforeEntry,
        shellEnd,
        hasEntryModule
      );
      if (shell === undefined) {
        continue;
      }
      await writer.write(enc.encode(shell));
      const tail = pending.slice(shellEnd);
      pending = "";
      entryHandled = true;
      deferredWrites = beforeBodyClose();
      deferredWrites.catch(() => undefined);
      await writer.write(enc.encode(tail));
    }
  }
  const finalChunk = decoder.decode();
  if (!entryHandled) {
    await writer.write(enc.encode(pending + finalChunk + beforeEntry));
    await beforeBodyClose();
    await writer.write(enc.encode(documentFooter()));
    return;
  }

  if (finalChunk.length > 0) {
    await writer.write(enc.encode(finalChunk));
  }
  await deferredWrites;
  await writer.write(enc.encode(documentFooter()));
}

export function buildSsrTransportScripts(
  dataPayload: Record<string, unknown>,
  deferredKeys: string[],
  hasDeferred: boolean,
  shellErrored: boolean,
  nonce?: string,
  jsonCompatible?: boolean
): SsrTransportScripts {
  const usesRouteFrames =
    !shellErrored && (hasDeferred || !(jsonCompatible ?? isJsonObject(dataPayload)));
  const deferredSetupScript =
    hasDeferred && !usesRouteFrames ? buildDeferredScript(deferredKeys, nonce) : "";
  const dataScript = usesRouteFrames
    ? buildRouteFrameTemplate(
        serializeRouteFrames(dataPayload, hasDeferred ? deferredKeys : undefined)
      )
    : `<script id="__FURIN_DATA__" type="application/json">${safeJson(dataPayload)}</script>`;
  const routeFrameStreamScript =
    hasDeferred && usesRouteFrames ? buildRouteFrameStreamScript(nonce) : "";

  return {
    deferredSetupScript,
    runtimeScripts: `${routeFrameStreamScript}${dataScript}`,
    usesRouteFrames,
  };
}

async function writeDeferredSsrChunk(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  key: string,
  promise: Promise<unknown>,
  index: number,
  usesRouteFrames: boolean,
  nonce?: string
): Promise<void> {
  if (usesRouteFrames) {
    const frames = await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
    await writer.write(enc.encode(buildRouteFramePushScript(frames, nonce)));
    return;
  }

  try {
    const resolvedValue = await promise;
    const chunk = toCrossJSON(resolvedValue);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "resolve", nonce)));
  } catch (err) {
    const normalized = await serializeDeferredRejection(err);
    const chunk = toCrossJSON(normalized);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "reject", nonce)));
  }
}

export async function writeDeferredSsrChunks(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  deferredPromises: Record<string, Promise<unknown>>,
  usesRouteFrames: boolean,
  nonce?: string,
  signal?: AbortSignal
): Promise<void> {
  await Promise.all(
    Object.entries(deferredPromises).map(([key, promise], index) =>
      writeDeferredSsrChunk(
        writer,
        enc,
        key,
        waitForDeferred(promise, signal),
        index,
        usesRouteFrames,
        nonce
      )
    )
  );
  if (usesRouteFrames) {
    await writer.write(enc.encode(buildRouteFrameCloseScript(nonce)));
  }
}

function waitForDeferred(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined
): Promise<unknown> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
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
  const deferredEntries = Object.entries(deferredPromises ?? {});
  if (containsRscSource(payload) || deferredEntries.length > 0) {
    let ndjson = serializeRouteFrames(
      syncData,
      deferredEntries.map(([key]) => key)
    );
    await Promise.all(
      deferredEntries.map(async ([key, promise], index) => {
        ndjson += await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
      })
    );
    return ndjson;
  }
  const compactJson = serializeCompactJsonLine(payload);
  if (compactJson !== undefined) {
    return compactJson;
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

  return renderBufferedResult(prepared, route, root);
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  precomputedLoaderResult: LoaderResult | undefined,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response> {
  const nonce = useRequestCspNonce(ctx.request);
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

  getLogger().set({
    furin: {
      loader_ms: prepared.loader_ms,
      render: route.mode,
      route: route.pattern,
      ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
    },
  });

  const { assets, deferredPromises, element, headData, headers } = prepared;

  const initialDataPayload = renderPayload(prepared, undefined);
  const jsonCompatible = deferredPromises === undefined && isJsonObject(initialDataPayload);
  const requiresTransport = !jsonCompatible;
  const renderAbort = new AbortController();
  const abortRequest = () => renderAbort.abort(ctx.request.signal.reason);
  if (ctx.request.signal.aborted) {
    abortRequest();
  } else {
    ctx.request.signal.addEventListener("abort", abortRequest, { once: true });
  }

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    withDocumentState(
      element,
      assets,
      headData,
      requiresTransport ? undefined : initialDataPayload,
      nonce,
      jsonCompatible
    ),
    route.error ?? root.error,
    prepared.ssrContext,
    (fallback, digest, message) =>
      withDocumentState(
        createElement(FurinDocumentFallback, null, fallback),
        assets,
        headData,
        {
          __furinError: { digest, message, status: 500 },
          __furinStatus: 500,
        },
        nonce,
        true
      ),
    nonce,
    renderAbort.signal
  ).catch((error: unknown) => {
    ctx.request.signal.removeEventListener("abort", abortRequest);
    throw error;
  });
  const shellErrored = shellError !== undefined;
  let { errorDigest: finalDigest, status } = prepared;
  if (shellError) {
    status = 500;
    finalDigest = shellError.digest;
    getLogger().set({
      furin: { digest: finalDigest, phase: "shell", render: route.mode, route: route.pattern },
    });
  }

  const dataPayload = renderPayload(prepared, shellError);
  if (
    !isProductionBuild() &&
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
    shellErrored,
    nonce,
    jsonCompatible
  );

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let documentFooter = "";
  // biome-ignore lint/correctness/noUndeclaredVariables: HTMLRewriter is a Bun runtime global declared by bun-types.
  const framedDocument = new HTMLRewriter()
    .on("body,html", {
      element(documentElement) {
        documentElement.onEndTag((tag) => {
          documentFooter += `</${tag.name}>`;
          tag.remove();
        });
      },
    })
    .transform(new Response(reactStream));
  const reader = (framedDocument.body as ReadableStream<Uint8Array>).getReader();
  const abortOutput = () => {
    writer.abort(renderAbort.signal.reason).catch(() => undefined);
  };
  renderAbort.signal.addEventListener("abort", abortOutput, { once: true });
  if (renderAbort.signal.aborted) {
    abortOutput();
  }
  writer.closed.catch((error: unknown) => {
    renderAbort.abort(error);
  });

  (async () => {
    try {
      await pipeDocumentStream(
        reader,
        writer,
        enc,
        hasDeferred || usesRouteFrames ? deferredSetupScript + runtimeScripts : "",
        assets.entryModule !== undefined,
        async () => {
          if (!hasDeferred) {
            return;
          }
          await writeDeferredSsrChunks(
            writer,
            enc,
            deferredPromises,
            usesRouteFrames,
            nonce,
            renderAbort.signal
          );
        },
        () => documentFooter
      );
      await writer.close();
    } catch (error) {
      renderAbort.abort(error);
      await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    } finally {
      ctx.request.signal.removeEventListener("abort", abortRequest);
      renderAbort.signal.removeEventListener("abort", abortOutput);
      reader.releaseLock();
    }
  })().catch(() => undefined);

  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(readable, {
    headers: responseHeaders,
    status,
  });
}
