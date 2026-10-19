import { type AnyElysia, type Context, problem } from "elysia";
import { toLogical } from "../../client/router/link-utils.ts";
import type {
  FurinNativeRouteContext,
  FurinRouteDispatcher,
  FurinRouteKey,
} from "../../define-route.ts";
import { stripNavigationDataSearch } from "../../shared/navigation-data.ts";
import { isWithinPrefix } from "../../shared/prefix.ts";
import { getLogger } from "../context-logger.ts";
import {
  adoptScopedRequest,
  allInstances,
  enterRequestScope,
  type FurinInstance,
  isNavigationDataRequest,
  markNavigationDataRequest,
  normalizePrefix,
  scopedInstance,
} from "../instance.ts";
import type { LoaderResult } from "../render/loaders.ts";
import { renderRootNotFound } from "../render/not-found.ts";
import { buildRouteMatcher } from "./patterns.ts";
import { renderResolvedRoute, renderRouteData, serializeNavigationRedirect } from "./plugin.ts";
import { mergeRouteSchemas } from "./schema-merge.ts";
import { type createSearchRouteMetadata, parseRouteParams, parseRouteQuery } from "./schemas.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

/** A route and its root layout, with the modules current for one request. */
export interface CurrentRoute {
  root: RootLayout;
  route: ResolvedRoute;
}

/**
 * What a runtime plugs into the shared page pipeline. Development and
 * production dispatch, validate and render pages through the same code: they
 * differ only in where routes and modules come from and in what is cached.
 */
export interface PagePorts {
  /** Cache policy. */
  cache: {
    /**
     * The loader result of a live render, or `undefined` to let the renderer
     * run the loaders.
     */
    loaders: (current: CurrentRoute, ctx: Context) => Promise<LoaderResult | undefined>;
    /**
     * Whether SSG, ISR and PPR documents, and their navigation data, are
     * served through the page cache. Otherwise every document renders live.
     */
    pages: boolean;
  };
  /** Module loader. */
  modules: {
    /** Serves navigation data with the route's current modules. */
    data: (
      route: ResolvedRoute,
      root: RootLayout,
      serve: (current: CurrentRoute) => Promise<Response>
    ) => Promise<Response>;
    /** Serves a document with the route's current modules. */
    document: (
      route: ResolvedRoute,
      root: RootLayout,
      serve: (current: CurrentRoute) => Promise<unknown>
    ) => Promise<unknown>;
    /** The route to render once its loaders returned data. */
    render: (route: ResolvedRoute) => Promise<ResolvedRoute>;
  };
  /** Route source. */
  routes: {
    /** Whether a route of the table still has its page module. */
    has: (route: ResolvedRoute) => boolean;
    /** Whether Elysia validated and decoded native page route params. */
    validatesParams: boolean;
  };
}

/** Renders the pages of one route table (production, or one development snapshot). */
export interface RouteRenderer {
  /** Renders the page a native Elysia route handler was bound to. */
  native: FurinRouteDispatcher;
  /**
   * The runtime's single not-found path: renders a page Elysia has no route
   * for (a root catch-all page, a page added in development), else the root
   * not-found document.
   */
  notFound: (context: FurinNativeRouteContext) => Promise<unknown>;
}

/** How a runtime answers page dispatch and SPA navigation requests. */
export interface RuntimeRoutes {
  /** Whether a logical path matches one of the runtime's pages. */
  matches: (path: string) => boolean;
  /** Development: reconciles the route topology before an HMR data refresh. */
  refresh: (() => Promise<void>) | undefined;
  renderer: () => RouteRenderer;
}

const runtimeRoutes = new WeakMap<FurinInstance, RuntimeRoutes>();

export function bindRuntimeRoutes(instance: FurinInstance, routes: RuntimeRoutes): void {
  runtimeRoutes.set(instance, routes);
}

/** Whether a request targets a registered page in the specified Furin mount. */
export function isFurinPageRequest(request: Request, prefix: string): boolean {
  if (request.method !== "GET") {
    return false;
  }
  const { pathname } = new URL(request.url);
  const mountPrefix = normalizePrefix(prefix);
  const containing = allInstances().filter((instance) => isWithinPrefix(pathname, instance.prefix));
  const longest = Math.max(-1, ...containing.map((instance) => instance.prefix.length));
  const owners = containing.filter((instance) => instance.prefix.length === longest);
  if (owners.length > 1) {
    throw new Error(
      `[furin] isFurinPageRequest() is ambiguous for ${JSON.stringify(pathname)}: ${owners.length} Furin runtimes declare that prefix. Call it while handling a request of the application that mounts them.`
    );
  }
  const [owner] = owners;
  const routes = owner?.prefix === mountPrefix ? runtimeRoutes.get(owner) : undefined;
  if (!routes) {
    return false;
  }
  const path = pathname.slice(mountPrefix.length) || "/";
  if (
    path.startsWith("/_client/") ||
    path.startsWith("/_furin/") ||
    path.startsWith("/_bun_hmr_entry") ||
    path.startsWith("/public/") ||
    path === "/favicon.ico"
  ) {
    return false;
  }
  return routes.matches(path);
}

/**
 * Removes the `?_furin=data` marker from a page request under `prefix`, or
 * returns `undefined` when the request is not a navigation data request.
 */
function stripNavigationDataRequest(request: Request, prefix: string): Request | undefined {
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  const search = isWithinPrefix(url.pathname, prefix)
    ? stripNavigationDataSearch(url.search)
    : undefined;
  if (search === undefined) {
    return;
  }
  url.search = search;
  return new Request(url, request);
}

/**
 * Data requests are fetched with `redirect: "manual"`, so any redirect — from
 * a parent guard or a loader — reaches the client as a navigation payload.
 */
function serializeDataRedirect(response: Response, page: Request): Response | Promise<Response> {
  if (response.status < 300 || response.status >= 400) {
    return response;
  }
  return serializeNavigationRedirect(response, new URL(page.url), scopedInstance()?.prefix ?? "");
}

type RequestWrap = Parameters<AnyElysia["wrap"]>[0];

/**
 * The runtime's `.wrap()`: binds requests under its prefix to the runtime and
 * strips the navigation data marker before routing, so the page route itself
 * (with every parent guard) serves SPA navigation data.
 */
export function createRequestScope(instance: FurinInstance): RequestWrap {
  return (fetch) =>
    (request, ...rest) =>
      enterRequestScope(instance, request, () => {
        const page = stripNavigationDataRequest(request, instance.prefix);
        if (page) {
          adoptScopedRequest(page);
          markNavigationDataRequest();
        }
        const routes = runtimeRoutes.get(instance);
        const pageRequest = page ?? request;
        const { pathname } = new URL(pageRequest.url);
        const refresh =
          isNavigationDataRequest() &&
          pageRequest.headers.get("x-furin-hmr-refresh") === "1" &&
          isWithinPrefix(pathname, instance.prefix) &&
          routes?.matches(pathname.slice(instance.prefix.length) || "/")
            ? routes.refresh
            : undefined;
        const dispatch = () =>
          page
            ? Promise.resolve(fetch(page, ...rest)).then((response) =>
                serializeDataRedirect(response, page)
              )
            : fetch(request, ...rest);
        return refresh ? refresh().then(dispatch) : dispatch();
      });
}

function listenerOrigin(context: FurinNativeRouteContext): string | undefined {
  return (context.server as { url?: { origin: string } } | undefined)?.url?.origin;
}

/**
 * Creates the renderer of one route table. `resolve` maps the key a native
 * handler was bound to onto its route — no URL is matched again.
 */
export function createRouteRenderer(
  instance: FurinInstance,
  routes: ResolvedRoute[],
  root: RootLayout,
  buildId: string,
  searchRoutes: ReturnType<typeof createSearchRouteMetadata>,
  resolve: (key: FurinRouteKey) => ResolvedRoute | undefined,
  ports: PagePorts
): RouteRenderer {
  const { prefix } = instance;
  const matchRoute = buildRouteMatcher(routes);

  const render = async (
    context: FurinNativeRouteContext,
    route: ResolvedRoute,
    params: { [key: string]: unknown },
    paramsValidated: boolean
  ): Promise<unknown> => {
    const requestUrl = new URL(context.request.url);
    const logicalPath = toLogical(requestUrl.pathname, prefix);
    const parsedParams = paramsValidated
      ? { ok: true as const, params }
      : await parseRouteParams(params, mergeRouteSchemas(route.routeChain, "params"));
    if (!parsedParams.ok) {
      return problem(422, { detail: "Invalid params", errors: parsedParams.errors });
    }
    const parsedQuery = await parseRouteQuery(
      requestUrl,
      mergeRouteSchemas(route.routeChain, "query")
    );
    if (!parsedQuery.ok) {
      return problem(422, { detail: "Invalid query", errors: parsedQuery.errors });
    }
    context.params = parsedParams.params;
    context.query = parsedQuery.query;
    const ctx = context as unknown as Context;
    if (isNavigationDataRequest()) {
      getLogger().set({ path: logicalPath + requestUrl.search, routePattern: route.pattern });
      return ports.modules.data(route, root, (current) =>
        renderRouteData(current, ctx, searchRoutes, logicalPath + requestUrl.search, ports)
      );
    }
    return ports.modules.document(route, root, (current) =>
      renderResolvedRoute(current, ctx, buildId, searchRoutes, ports)
    );
  };

  const notFound = (context: FurinNativeRouteContext): Promise<unknown> => {
    const { request } = context;
    const matched =
      request.method === "GET"
        ? matchRoute(toLogical(new URL(request.url).pathname, prefix))
        : null;
    if (matched && ports.routes.has(matched.route)) {
      return render(context, matched.route, matched.params, false);
    }
    // The router loads a URL without a page as a document, which renders the
    // root not-found page: rendering it for the data request would be wasted.
    if (isNavigationDataRequest()) {
      return Promise.resolve(
        new Response(null, { headers: { "cache-control": "private, no-store" }, status: 404 })
      );
    }
    return renderRootNotFound(root, request, listenerOrigin(context));
  };

  return {
    native: (context, routeKey) => {
      const route = resolve(routeKey);
      // Development: the mounted Elysia route can outlive its source file.
      if (!(route && ports.routes.has(route))) {
        return notFound(context);
      }
      // Production's native route has already validated and decoded params;
      // the development shell is schema-free so it follows edited schemas.
      // Elysia leaves params undefined on static routes.
      const nativeParams = (context.params ?? {}) as { [key: string]: unknown };
      return render(context, route, nativeParams, ports.routes.validatesParams);
    },
    notFound,
  };
}

function ownerRenderer(fallback: FurinInstance | undefined): RouteRenderer {
  const instance = scopedInstance() ?? fallback;
  const routes = instance && runtimeRoutes.get(instance);
  if (!routes) {
    const declared = allInstances().map((peer) => JSON.stringify(peer.prefix || "/"));
    throw new Error(
      `[furin] A Furin page route was reached outside every declared prefix (${declared.join(", ")}). furin({ prefix }) must be the full physical path: mount Furin on an Elysia instance without a prefix and repeat the parent prefix in furin({ prefix }).`
    );
  }
  return routes.renderer();
}

/**
 * Dispatches a native Furin route to the runtime owning the request. Native
 * route handlers share one Elysia decorator across mounts, so the runtime
 * comes from the request scope its wrap opened.
 */
export function dispatchNativeRoute(
  context: FurinNativeRouteContext,
  route: FurinRouteKey
): unknown {
  return ownerRenderer(undefined).native(context, route);
}

/**
 * Answers a request no page route handled, for the runtime owning it (or
 * `instance`, whose hook caught it, when no runtime owns the path).
 */
export function renderNotFound(
  instance: FurinInstance,
  context: FurinNativeRouteContext
): Promise<unknown> {
  return ownerRenderer(instance).notFound(context);
}
