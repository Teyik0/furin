import type { Context } from "elysia";
import { toCrossJSONAsync } from "seroval";
import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { toLogical } from "../../client/router/link-utils.ts";
import type { HeadOptions } from "../../client.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { isWithinPrefix } from "../../shared/prefix.ts";
import { containsRscSource, isRouteFrameLine } from "../../shared/route-frame.ts";
import { failRouteMatches, loaderFailureIndex } from "../../shared/route-matches.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import {
  currentInstrumentationRequest,
  emitPayloadSerialized,
} from "../devtools/instrumentation.ts";
import { isExternalPrerenderRequest } from "../external-prerender.ts";
import { currentInstance } from "../instance.ts";
import { injectSyncRuntimeScript, resolvePath } from "../render/assemble.ts";
import { type CachedRouteData, handleISR, handleISRData } from "../render/isr.ts";
import {
  hasMixedLoaderModes,
  type LoaderResult,
  runLoaders,
  runMixedLoaders,
  runPublicLoaders,
} from "../render/loaders.ts";
import { withNavigationHead } from "../render/navigation-head.ts";
import { type PprShell, renderPprRoute, runPprPublicLoaders } from "../render/ppr-route.ts";
import { hasRequestLoader, withRequestLoaderData } from "../render/request-loaders.ts";
import {
  createDeferredRouteFrameStream,
  serializeLoaderDataNdjson,
} from "../render/route-frame-transport.ts";
import { prerenderRoute, prerenderRuntimeSSG } from "../render/ssg.ts";
import { renderSSR } from "../render/ssr.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { CurrentRoute, PagePorts } from "./dispatch.ts";
import { resolveDocumentMode, resolveDocumentRevalidate } from "./patterns.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

interface DataRouteParamsInput {
  [key: string]: unknown;
}

type SyntheticDataContext = Omit<Context, "params" | "query"> & {
  params: DataRouteParamsInput;
  query: SearchParamsInput;
};

type RouteDataContext = Pick<SyntheticDataContext, "params" | "path" | "query">;

function emitSerializedPayload(body: string, kind: "route-data" | "rsc", requestUrl: string): void {
  if (!IS_DEV) {
    return;
  }
  const request = currentInstrumentationRequest();
  if (request === undefined) {
    return;
  }
  emitPayloadSerialized({
    bytes: new TextEncoder().encode(body).byteLength,
    kind,
    operationId: request.operationId,
    path: new URL(requestUrl).pathname,
    requestId: request.requestId,
  });
}

/** Whether a route is partially prerendered: a requestLoader below an SSG or ISR document. */
export function isPprRoute(route: ResolvedRoute): boolean {
  return resolveDocumentMode(route) !== "ssr" && hasRequestLoader(route);
}

/**
 * A PPR route's shell source, and the route to render it with: the page
 * cache's, or without one a fresh prerender from the runtime's loader result.
 */
async function resolvePprShell(
  current: CurrentRoute,
  ctx: Context,
  purpose: "data" | "document",
  ports: PagePorts
): Promise<{ route: ResolvedRoute; source: PprShell }> {
  if (ports.cache.pages) {
    return { route: current.route, source: { type: "cached" } };
  }
  const publicResult = await ports.cache.loaders(current, ctx, purpose);
  const route =
    publicResult === undefined || publicResult.type === "data"
      ? await ports.modules.render(current.route)
      : current.route;
  return { route, source: { publicResult, type: "fresh" } };
}

async function runDataEndpointLoaders(
  current: CurrentRoute,
  ctx: Context,
  searchRoutes: SearchRouteMetadata[],
  ports: PagePorts
): Promise<LoaderResult> {
  const { root, route } = current;
  if (hasMixedLoaderModes(route)) {
    return runMixedLoaders(route, ctx);
  }
  if (resolveDocumentMode(route) === "ssr") {
    return runLoaders(route, ctx);
  }

  let result: LoaderResult;
  if (hasRequestLoader(route)) {
    const shell = await resolvePprShell(current, ctx, "data", ports);
    result = await runPprPublicLoaders(
      shell.route,
      ctx,
      currentInstance().buildId,
      root,
      searchRoutes,
      shell.source
    );
  } else {
    result =
      (await ports.cache.loaders(current, ctx, "data")) ?? (await runPublicLoaders(route, ctx));
  }
  if (result.type !== "data" || !hasRequestLoader(route)) {
    return result;
  }
  return withRequestLoaderData(route, ctx, result);
}

async function serializeLoaderDataResponse(
  result: LoaderResult,
  route: ResolvedRoute,
  requestUrl: string,
  routeContext: RouteDataContext
): Promise<Response> {
  if (result.type === "redirect") {
    // The request scope serializes every data redirect, guards' included.
    return result.response;
  }
  if (result.type === "not-found") {
    const body = await serializeLoaderDataNdjson(
      failRouteMatches(result.syncData, loaderFailureIndex(result.syncData), {
        error: { data: result.error.data, message: result.error.message },
        status: "notFound",
      }),
      result.deferredPromises
    );
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson" },
      status: 200,
    });
  }
  if (result.type === "error") {
    return createRouteDataErrorResponse(
      result.error,
      result.message,
      result.status,
      routeContext,
      result.syncData,
      result.deferredPromises
    );
  }

  const syncDataWithTitle = withResolvedHead(route, result.syncData);
  if (result.deferredPromises !== undefined) {
    return new Response(
      createDeferredRouteFrameStream(syncDataWithTitle, result.deferredPromises),
      {
        headers: {
          ...result.headers,
          "content-type": "application/x-furin-route",
        },
      }
    );
  }
  const hasRsc = containsRscSource(syncDataWithTitle);
  const body = await serializeLoaderDataNdjson(syncDataWithTitle, undefined);
  emitSerializedPayload(body, hasRsc ? "rsc" : "route-data", requestUrl);
  return new Response(body, {
    headers: {
      ...result.headers,
      "content-type": hasRsc ? "application/x-furin-route" : "application/x-ndjson",
    },
  });
}

/** Encodes a redirect as the navigation payload SPA data requests understand. */
export async function serializeNavigationRedirect(
  response: Response,
  pageUrl: URL,
  prefix: string
): Promise<Response> {
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }
  const target = new URL(location, pageUrl);
  const href =
    target.origin === pageUrl.origin && isWithinPrefix(target.pathname, prefix)
      ? toLogical(target.pathname, prefix) + target.search + target.hash
      : target.href;
  const serialized = await toCrossJSONAsync({ __furinRedirect: href });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("location");
  headers.set("content-type", "application/x-ndjson");
  headers.set("cache-control", "private, no-store");
  return new Response(`${JSON.stringify(serialized)}\n`, { headers });
}

function navigationDataCacheControl(route: ResolvedRoute): string {
  if (resolveDocumentMode(route) === "ssg") {
    return "public, max-age=0, must-revalidate, s-maxage=31536000";
  }
  const revalidate = resolveDocumentRevalidate(route) ?? 60;
  return `public, max-age=0, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`;
}

function applyNavigationDataCache(
  response: Response,
  result: LoaderResult,
  route: ResolvedRoute,
  requestUrl: string,
  pageCache: boolean
): Response {
  const cacheable =
    pageCache &&
    resolveDocumentMode(route) !== "ssr" &&
    !hasRequestLoader(route) &&
    result.type === "data" &&
    result.deferredPromises === undefined;
  if (!cacheable) {
    response.headers.set("cache-control", "private, no-store");
    response.headers.delete("cache-tag");
    return response;
  }

  const { pathname } = new URL(requestUrl);
  response.headers.set("cache-tag", pathname);
  response.headers.set("cache-control", navigationDataCacheControl(route));
  return response;
}

async function createLoaderDataResponse(
  result: LoaderResult,
  route: ResolvedRoute,
  requestUrl: string,
  routeContext: RouteDataContext,
  pageCache: boolean
): Promise<Response> {
  const response = await serializeLoaderDataResponse(result, route, requestUrl, routeContext);
  return result.type === "redirect"
    ? response
    : applyNavigationDataCache(response, result, route, requestUrl, pageCache);
}

/**
 * SSG navigation data from the same cache entry as the document. A loader
 * failure falls back to the live loader path so the client receives the
 * regular error payload.
 */
async function readSSGRouteData(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes: SearchRouteMetadata[]
): Promise<CachedRouteData | undefined> {
  let runtimeResult: Awaited<ReturnType<typeof prerenderRuntimeSSG>>;
  try {
    runtimeResult = await prerenderRuntimeSSG(
      route,
      ctx.params ?? {},
      root,
      new URL(ctx.request.url).origin,
      currentInstance().buildId,
      searchRoutes
    );
  } catch {
    return;
  }
  const { cacheStored, entry } = runtimeResult;
  if (entry instanceof Response) {
    return { result: { response: entry, type: "redirect" }, type: "loader" };
  }
  if (entry.status !== 200) {
    return;
  }
  return {
    cacheControl: cacheStored ? navigationDataCacheControl(route) : undefined,
    headers: {},
    ndjson: entry.ndjson,
    type: "payload",
  };
}

/**
 * Reads navigation data through the render cache that backs the document, so
 * SPA navigations to ISR/SSG pages reuse (or populate) the same entry instead
 * of re-running public loaders. Mirrors `renderResolvedRoute`: SSR documents,
 * requestLoader (PPR) routes and runtimes without a page cache never take this
 * path, so private data is never served from a shared entry.
 */
function readCachedRouteData(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes: SearchRouteMetadata[]
): Promise<CachedRouteData | undefined> | undefined {
  if (hasRequestLoader(route) || isExternalPrerenderRequest(ctx.request)) {
    return;
  }
  const documentMode = resolveDocumentMode(route);
  if (documentMode === "isr") {
    return handleISRData(route, ctx, root, currentInstance().buildId, searchRoutes);
  }
  if (documentMode === "ssg") {
    return readSSGRouteData(route, ctx, root, searchRoutes);
  }
}

function cachedRouteDataResponse(
  payload: Extract<CachedRouteData, { type: "payload" }>,
  requestUrl: string
): Response {
  const firstLine = payload.ndjson.slice(0, payload.ndjson.indexOf("\n"));
  const headers = new Headers(payload.headers);
  headers.set(
    "content-type",
    isRouteFrameLine(firstLine) ? "application/x-furin-route" : "application/x-ndjson"
  );
  if (payload.cacheControl === undefined) {
    headers.set("cache-control", "private, no-store");
  } else {
    headers.set("cache-control", payload.cacheControl);
    headers.set("cache-tag", new URL(requestUrl).pathname);
  }
  return new Response(payload.ndjson, { headers });
}

/** Serialise navigation data after Elysia has run the matched page's hooks. */
export async function renderRouteData(
  current: CurrentRoute,
  ctx: Context,
  searchRoutes: SearchRouteMetadata[],
  logicalHref: string,
  ports: PagePorts
): Promise<Response> {
  const logicalContext = Object.create(ctx, {
    path: { enumerable: true, value: new URL(logicalHref, ctx.request.url).pathname },
  }) as Context;
  const requestUrl = new URL(logicalHref, ctx.request.url).href;
  const { root, route } = current;
  const cached = ports.cache.pages
    ? await readCachedRouteData(route, logicalContext, root, searchRoutes)
    : undefined;
  if (cached?.type === "payload") {
    return cachedRouteDataResponse(cached, requestUrl);
  }
  const result =
    cached?.result ?? (await runDataEndpointLoaders(current, logicalContext, searchRoutes, ports));
  return createLoaderDataResponse(result, route, requestUrl, logicalContext, ports.cache.pages);
}

export async function createRouteDataErrorResponse(
  error: unknown,
  message: string,
  status: number,
  routeContext: RouteDataContext | undefined,
  data: RuntimeData | undefined,
  deferredPromises: { [key: string]: Promise<unknown> } | undefined
): Promise<Response> {
  const payload = {
    ...data,
    ...(routeContext
      ? { params: routeContext.params, path: routeContext.path, query: routeContext.query }
      : {}),
  };
  const body = await serializeLoaderDataNdjson(
    failRouteMatches(payload, loaderFailureIndex(payload), {
      error: { digest: computeErrorDigest(error), message, status },
      status: "error",
    }),
    deferredPromises
  );
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson" },
    status,
  });
}

/** @internal Handles a production SSG route — sets ETags, Cache-Control, and Cache-Tag. */
async function handleSSGRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<unknown> {
  const { origin } = new URL(ctx.request.url);
  const params = ctx.params ?? {};
  const externalPrerender = isExternalPrerenderRequest(ctx.request);
  const runtimeResult = externalPrerender
    ? {
        cacheStored: true,
        entry: await prerenderRoute(
          route,
          params,
          root,
          origin,
          "ssg",
          undefined,
          searchRoutes,
          ctx
        ),
      }
    : await prerenderRuntimeSSG(route, params, root, origin, buildId, searchRoutes);
  const { cacheStored, entry } = runtimeResult;

  // Loader issued a redirect — forward it directly to the client.
  if (entry instanceof Response) {
    return entry;
  }

  ctx.set.status = entry.status;

  const resolvedPath = resolvePath(route.pattern, params);

  // ETag: "buildId:cachedAt" — unique per render cycle, changes after revalidatePath
  const etag = buildId ? `"${buildId}:${entry.cachedAt}"` : null;
  if (entry.status === 200 && etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  // Browser: max-age=0 + must-revalidate → always validates via ETag (304 = free)
  // CDN:     s-maxage=31536000 → cache for 1 year, purge via revalidatePath + purger
  ctx.set.headers["cache-control"] =
    cacheStored && entry.status === 200
      ? "public, max-age=0, must-revalidate, s-maxage=31536000"
      : "no-store";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.headers["cache-tag"] = resolvedPath;
  return injectSyncRuntimeScript(entry.html);
}

/**
 * Renders a page document: PPR documents prerendered and resumed, through the
 * page cache when the runtime has one; SSG and ISR documents through the page
 * cache too; every other document live with the loader result the runtime's
 * cache policy supplies.
 */
export async function renderResolvedRoute(
  current: CurrentRoute,
  ctx: Context,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined,
  ports: PagePorts
): Promise<unknown> {
  const { root, route } = current;
  const documentMode = resolveDocumentMode(route);
  if (isPprRoute(route)) {
    const shell = await resolvePprShell(current, ctx, "document", ports);
    return renderPprRoute(shell.route, ctx, root, buildId, searchRoutes, shell.source);
  }
  if (ports.cache.pages && documentMode !== "ssr") {
    if (documentMode === "ssg") {
      return handleSSGRequest(route, ctx, root, buildId, searchRoutes);
    }
    ctx.set.headers["cache-tag"] = resolvePath(route.pattern, ctx.params ?? {});
    return handleISR(route, ctx, root, buildId, searchRoutes);
  }
  const loaderResult = await ports.cache.loaders(current, ctx, "document");
  const renderRoute = loaderResult?.type === "data" ? await ports.modules.render(route) : route;
  return renderSSR(renderRoute, ctx, root, loaderResult, searchRoutes);
}

/**
 * Runs the matched page's `head()` against the resolved sync data and, when it
 * yields a title, returns a copy of `syncData` carrying the reserved
 * `__furinTitle` field. `head()` never executes in the browser, so this is the
 * only channel through which SPA navigation can learn the new document title.
 *
 * Deferred fields are absent from `syncData` (they are still Promises), so a
 * `head()` that reads one sees `undefined` — titles should be derived from
 * synchronous loader data. A throwing `head()` is swallowed: a missing title
 * must never break the data response.
 */
function withResolvedHead(route: ResolvedRoute, syncData: RuntimeData): RuntimeData {
  const { head } = route.page;
  if (!head) {
    return syncData;
  }
  let headOptions: HeadOptions;
  try {
    headOptions = head(syncData);
  } catch {
    return syncData;
  }
  return withNavigationHead(syncData, headOptions);
}
