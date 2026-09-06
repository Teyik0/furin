import { type AnyElysia, type Context, Elysia, t } from "elysia";
import { toCrossJSONAsync } from "seroval";
import type { HeadOptions } from "../../client.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import type { FurinSchema } from "../../shared/elysia-contract.ts";
import { containsRscSource, serializeRouteFrames } from "../../shared/route-frame.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { useLogger } from "../context-logger.ts";
import {
  currentInstrumentationRequest,
  emitPayloadSerialized,
} from "../devtools/instrumentation.ts";
import { injectSyncRuntimeScript, resolvePath } from "../render/assemble.ts";
import { handleISR } from "../render/isr.ts";
import {
  hasRequestLoader,
  type LoaderResult,
  runLoaders,
  runPublicLoaders,
  withRequestLoaderData,
} from "../render/loaders.ts";
import { renderPprRoute } from "../render/ppr-route.ts";
import { createDeferredRouteFrameStream } from "../render/route-frame-transport.ts";
import { extractTitle } from "../render/shell.ts";
import { prerenderSSG } from "../render/ssg.ts";
import { renderSSR } from "../render/ssr.ts";
import { IS_DEV } from "../runtime-env.ts";
import { handleDevRequest } from "./hmr.ts";
import { buildRouteMatcher } from "./patterns.ts";
import { mergeRouteSchemas } from "./schema-merge.ts";
import { parseDataEndpointPath, parseRouteParams, parseRouteQuery } from "./schemas.ts";
import type { ResolvedRoute, ResolvedRoutesSource, RootLayout } from "./types.ts";

interface DataRouteParamsInput {
  [key: string]: unknown;
}

type SyntheticDataContext = Omit<Context, "params" | "query"> & {
  params: DataRouteParamsInput;
  query: SearchParamsInput;
};

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

async function runDataEndpointLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  if (route.mode !== "isr" && route.mode !== "ssg") {
    return runLoaders(route, ctx);
  }

  const result = await runPublicLoaders(route, ctx);
  if (result.type !== "data" || !hasRequestLoader(route)) {
    return result;
  }
  return withRequestLoaderData(route, ctx, result);
}

async function createLoaderDataResponse(
  result: LoaderResult,
  route: ResolvedRoute,
  requestUrl: string
): Promise<Response> {
  if (result.type === "redirect") {
    const redirectUrl = new URL(result.response.headers.get("location") ?? "/", requestUrl);
    const serialized = await toCrossJSONAsync({
      __furinRedirect: redirectUrl.pathname + redirectUrl.search,
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
  if (result.type === "not-found") {
    const serialized = await toCrossJSONAsync({
      __furinNotFound: { data: result.error.data, message: result.error.message },
      __furinStatus: 404,
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
      status: 200,
    });
  }
  if (result.type === "error") {
    const serialized = await toCrossJSONAsync({
      __furinError: {
        digest: computeErrorDigest(result.error),
        message: result.message,
        status: result.status,
      },
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
      status: result.status,
    });
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
  const body = serializeRouteFrames(syncDataWithTitle, undefined);
  emitSerializedPayload(
    body,
    containsRscSource(syncDataWithTitle) ? "rsc" : "route-data",
    requestUrl
  );
  return new Response(body, {
    headers: {
      ...result.headers,
      "content-type": "application/x-furin-route",
    },
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
  const entry = await prerenderSSG(route, ctx.params ?? {}, root, origin, undefined, searchRoutes);

  // Loader issued a redirect — forward it directly to the client.
  if (entry instanceof Response) {
    return entry;
  }

  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});

  // ETag: "buildId:cachedAt" — unique per render cycle, changes after revalidatePath
  const etag = buildId ? `"${buildId}:${entry.cachedAt}"` : null;
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  // Browser: max-age=0 + must-revalidate → always validates via ETag (304 = free)
  // CDN:     s-maxage=31536000 → cache for 1 year, purge via revalidatePath + purger
  ctx.set.headers["cache-control"] = "public, max-age=0, must-revalidate, s-maxage=31536000";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.headers["cache-tag"] = resolvedPath;
  return injectSyncRuntimeScript(entry.html);
}

export function createRoutePlugin(
  route: ResolvedRoute,
  root: RootLayout,
  buildId?: string,
  searchRoutes?: SearchRouteMetadata[]
): AnyElysia {
  const resolvedBuildId = buildId ?? "";
  const { pattern, routeChain } = route;

  const allParams = mergeRouteSchemas(routeChain, "params");
  const allQuery = mergeRouteSchemas(routeChain, "query");

  // Guard and handler MUST live in the same Elysia scope so that validation
  // (including default-filling) applies to the route handler's ctx.query.
  const plugin = new Elysia();

  if (allParams || allQuery) {
    plugin.guard({
      params: allParams as FurinSchema,
      query: allQuery as FurinSchema,
    });
  }

  plugin.get(pattern, (ctx) =>
    renderResolvedRoute(route, ctx, root, resolvedBuildId, searchRoutes)
  );

  return plugin;
}

export function renderResolvedRoute(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): unknown {
  // Dev mode: re-imports page + layouts on every request via the
  // ?furin-server cache-buster. Only loader output is cached in dev; HTML is
  // always reassembled with the latest Bun client chunk URL.
  if (IS_DEV) {
    return handleDevRequest(route, ctx, root, searchRoutes);
  }

  if ((route.mode === "ssg" || route.mode === "isr") && hasRequestLoader(route)) {
    return renderPprRoute(route, ctx, root, buildId, searchRoutes);
  }

  if (route.mode === "ssg") {
    return handleSSGRequest(route, ctx, root, buildId, searchRoutes);
  }

  if (route.mode === "isr") {
    ctx.set.headers["cache-tag"] = resolvePath(route.pattern, ctx.params ?? {});
    return handleISR(route, ctx, root, buildId, searchRoutes);
  }

  return renderSSR(route, ctx, root, undefined, searchRoutes);
}

/**
 * Elysia plugin that handles `GET /_furin/data?path=<logicalHref>`.
 *
 * Returns route-frame loader data for successful routes. Deferred routes stream
 * the initial sync frame first, then append one frame batch per settled Promise.
 * SPA navigation calls this endpoint via `parseDeferredNdjson`, which supports
 * both route frames and legacy NDJSON sentinels.
 *
 * Special fields emitted alongside data:
 *   - `__furinStatus: 404` — when the loader called `notFound()`
 *   - `__furinNotFound`    — not-found payload
 *   - `__furinRedirect`    — logical path after a server-side redirect
 */
export function createDataEndpoint(routesSource: ResolvedRoutesSource): AnyElysia {
  const plugin = new Elysia();
  let matchedRoutes = typeof routesSource === "function" ? routesSource() : routesSource;
  let matchRoute = buildRouteMatcher(matchedRoutes);

  plugin.get(
    "/_furin/data",
    async (ctx) => {
      const rawPath = ctx.query.path;
      if (!rawPath || typeof rawPath !== "string") {
        return new Response("Missing required query param: path", { status: 400 });
      }

      const parsed = parseDataEndpointPath(rawPath);
      if (!parsed) {
        return new Response("Invalid path", { status: 400 });
      }
      const { url, pathname } = parsed;

      // Rewrite the request-scoped wide event so logs / drains report the
      // *logical* path the user navigated to (e.g. "/board/123/card/456")
      // instead of the technical "/_furin/data" transport URL. We set this
      // before the route-match check so 404s also surface the attempted path
      // — otherwise monitoring just sees "GET /_furin/data 404" with no clue.
      const wideEventLog = useLogger();
      wideEventLog.set({ path: rawPath });

      const currentRoutes = typeof routesSource === "function" ? routesSource() : routesSource;
      if (currentRoutes !== matchedRoutes) {
        matchedRoutes = currentRoutes;
        matchRoute = buildRouteMatcher(matchedRoutes);
      }
      const matched = matchRoute(pathname);

      if (!matched) {
        return new Response("Route not found", { status: 404 });
      }

      // Now that we know the matched pattern, add it as a stable aggregation
      // key for drains (e.g. "p99 latency by route").
      wideEventLog.set({ routePattern: matched.route.pattern });

      // Build a synthetic Elysia-compatible context for the matched route.
      // Loaders receive request, params, query, set, headers, and cookie.
      // Build the synthetic URL from the parsed `pathname + search` only —
      // never from `rawPath` directly — so an attacker cannot smuggle a
      // foreign origin into `syntheticRequest.url`.
      // Forward the real request headers (cookies, auth) so loaders reading
      // `request.headers` behave the same during SPA navigation as in SSR.
      const syntheticRequest = new Request(new URL(pathname + url.search, ctx.request.url), {
        headers: ctx.request.headers,
      });
      const syntheticSet = { headers: {} as Record<string, string>, status: 200 as number };
      const syntheticCtx: SyntheticDataContext = {
        cookie: ctx.cookie,
        headers: ctx.headers,
        params: matched.params,
        path: pathname,
        query: Object.fromEntries(url.searchParams),
        // Loader-emitted redirects flow through `runLoaders` → `result.type
        // === "redirect"` and are converted to NDJSON below. The Response we
        // return here only has to be detectable by that pipeline.
        redirect: (location: string, status?: number) =>
          new Response(null, { headers: { location }, status: status ?? 302 }),
        request: syntheticRequest,
        set: syntheticSet,
        // Synthetic `status` helper: numeric codes only. Callers that reach
        // this endpoint never dispatch a string-keyed status; rejecting them
        // is safer than coercing via `Number(code)` and silently producing
        // `NaN`.
        status: (code: number) => new Response(null, { status: code }),
      } as unknown as SyntheticDataContext;

      // Normalize params and query through the route chain schemas so SPA and
      // document requests expose identical typed/defaulted inputs.
      const mergedParams = mergeRouteSchemas(matched.route.routeChain, "params");
      const mergedQuery = mergeRouteSchemas(matched.route.routeChain, "query");
      const parsedParams = await parseRouteParams(matched.params, mergedParams);
      if (!parsedParams.ok) {
        return Response.json(
          { errors: parsedParams.errors, message: "Invalid params", type: "validation" },
          { status: 422 }
        );
      }
      const parsedQuery = await parseRouteQuery(url, mergedQuery);
      if (!parsedQuery.ok) {
        return Response.json(
          { errors: parsedQuery.errors, message: "Invalid query", type: "validation" },
          { status: 422 }
        );
      }
      syntheticCtx.params = parsedParams.params;
      syntheticCtx.query = parsedQuery.query as SearchParamsInput;

      const result = await runDataEndpointLoaders(
        matched.route,
        syntheticCtx as unknown as Context
      );

      return createLoaderDataResponse(result, matched.route, syntheticRequest.url);
    },
    {
      query: t.Object({ path: t.Optional(t.String()) }),
    }
  );

  return plugin;
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
function withResolvedHead(
  route: ResolvedRoute,
  syncData: Record<string, unknown>
): Record<string, unknown> {
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
  const title = extractTitle(headOptions.meta);
  if (title === undefined) {
    return { ...syncData, __furinHead: headOptions };
  }
  return { ...syncData, __furinHead: headOptions, __furinTitle: title };
}
