import type { Context } from "elysia";
import { createElement, type ReactNode } from "react";
import type { DocumentAssets } from "../../client/document.tsx";
import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { resolveRouteElement, selectRouteBoundary } from "../../client/route-element.tsx";
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
import {
  failRouteMatches,
  loaderFailureIndex,
  type RouteMatchFailure,
} from "../../shared/route-matches.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { currentInstance, isDevelopment } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { errorMessageForRender, SERVER_RESET_NOOP } from "./element.tsx";
import { hasSsrLoaderAncestor, type LoaderResult, runRouteLoaders } from "./loaders.ts";
import { generateIndexHtml } from "./shell.ts";
import {
  documentAssetsFromTemplate,
  getDevDocumentAssets,
  getProductionDocumentAssets,
  getProductionPreloadManifest,
} from "./template.ts";

export interface PreparedRender {
  assets: DocumentAssets;
  /**
   * All props passed to the React component tree. For deferred renders this
   * includes the Promise objects (for `<Await resolve={promise}>`) alongside
   * the scalar sync fields. Never serialise this directly — use `syncData`.
   */
  componentProps: RuntimeData;
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
  ssrContext: RouterContextValue;
  status: number;
  /**
   * JSON-serialisable subset of `componentProps`, including the route matches
   * (with the failed segment on error and not-found renders). For deferred
   * renders this excludes the Promise fields (those are streamed separately).
   */
  syncData: RuntimeData;
}

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

function resolveDocumentAssets(ctx: Context): DocumentAssets | Promise<DocumentAssets> {
  const productionAssets = getProductionDocumentAssets();
  if (productionAssets !== null) {
    return productionAssets;
  }
  if (isDevelopment() && ctx.server) {
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

  const { deferredPromises, headers } = loaderResult;
  assertDeferredModeAllowed(route, deferredPromises);

  const assets = withRouteModulePreloads(await resolveDocumentAssets(ctx), route.pattern);

  let { syncData } = loaderResult;
  let headData: HeadOptions | undefined;
  let status = 200;
  let errorDigest: string | undefined;
  let errorMessage: string | undefined;
  const failSegment = (index: number, failure: RouteMatchFailure) => {
    syncData = failRouteMatches(syncData, index, failure);
  };
  const failWithError = (index: number, error: unknown, message: string | undefined) => {
    const { component } = selectRouteBoundary(route.segmentBoundaries, root, index, "error");
    errorDigest = computeErrorDigest(error);
    errorMessage = errorMessageForRender(component, error, message);
    failSegment(index, {
      error: { digest: errorDigest, message: errorMessage, status },
      status: "error",
    });
  };
  if (loaderResult.type === "not-found") {
    status = 404;
    const { data, message } = loaderResult.error;
    failSegment(loaderFailureIndex(syncData), { error: { data, message }, status: "notFound" });
  } else if (loaderResult.type === "error") {
    ({ status } = loaderResult);
    failWithError(loaderFailureIndex(syncData), loaderResult.error, loaderResult.message);
  } else {
    // `head()` is user code that runs outside the render pipeline's shell-error
    // handling: a throw fails the page segment with a 500 instead of escaping
    // `prepareRender`. Build-time SSG rethrows so CI fails loudly.
    try {
      headData = route.page.head?.({ ...syncData });
    } catch (headError) {
      if (throwOnFailure) {
        throw headError;
      }
      status = 500;
      failWithError(route.routeChain.length, headError, undefined);
    }
  }
  const componentProps =
    deferredPromises === undefined ? syncData : { ...syncData, ...deferredPromises };
  let element = resolveRouteElement({
    boundaries: route.segmentBoundaries,
    boundaryOptions: undefined,
    chain: route.routeChain,
    data: componentProps,
    page: { component: route.page.component, pattern: route.pattern },
    reset: SERVER_RESET_NOOP,
    rootBoundary: root,
  });

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
    ssrContext,
    status,
    syncData,
  };
}
