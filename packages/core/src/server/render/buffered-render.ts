import type { Context } from "elysia";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { queryTagsFromData } from "../../shared/sync-query.ts";
import { getLogger, runInSyntheticRenderScope } from "../context-logger.ts";
import { mergeRouteSchemas } from "../router/schema-merge.ts";
import { parseRouteParams, parseRouteQuery } from "../router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath, streamToString } from "./assemble.ts";
import { renderPayload, renderPreparedDocument } from "./document-stream.ts";
import { hasMixedLoaderModes, runPublicLoaders, runSegmentPublicLoaders } from "./loaders.ts";
import { withNavigationHead } from "./navigation-head.ts";
import { type PreparedRender, prepareRender } from "./prepare-render.ts";
import { serializeLoaderDataNdjson } from "./route-frame-transport.ts";

export interface RenderResult {
  headers: Record<string, string>;
  html: string;
  /**
   * NDJSON payload (one CrossJSON-serialised line) carrying the loader's
   * resolved sync + deferred data. Identical in shape to the body the live
   * navigation data (`?_furin=data`) emits, so the SPA client can consume both
   * interchangeably.
   */
  ndjson: string;
  queryTags?: string[];
  status: number;
}

export async function renderBufferedResult(
  prepared: PreparedRender,
  root: RootLayout
): Promise<RenderResult> {
  const { deferredPromises, headers, syncData } = prepared;
  const payload = renderPayload(prepared, undefined);
  const { shellError, stream } = await renderPreparedDocument(prepared, root, payload, {});
  await stream.allReady;
  const html = await streamToString(stream);
  return {
    headers,
    html,
    ndjson: await serializeLoaderDataNdjson(
      shellError
        ? renderPayload(prepared, shellError)
        : withNavigationHead(payload, prepared.headData),
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

      return renderBufferedResult(prepared, root);
    },
    { render: mode, route: route.pattern }
  );
}

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

  return renderBufferedResult(prepared, root);
}
