import { existsSync } from "node:fs";
import { type AnyElysia, problem } from "elysia";
import type { FurinRouteDispatcher } from "../../define-route.ts";
import { physicalPath } from "../../shared/prefix.ts";
import { getLogger } from "../context-logger.ts";
import {
  adoptScopedRequest,
  allInstances,
  enterRequestScope,
  type FurinInstance,
  isWithinPrefix,
  normalizePrefix,
  scopedInstance,
} from "../instance.ts";
import { renderRootNotFound } from "../render/not-found.ts";
import { IS_DEV } from "../runtime-env.ts";
import { resolveCurrentDevRoute } from "./hmr.ts";
import { buildRouteMatcher } from "./patterns.ts";
import { renderResolvedRoute, renderRouteData, serializeGuardRedirect } from "./plugin.ts";
import { mergeRouteSchemas } from "./schema-merge.ts";
import {
  type createSearchRouteMetadata,
  parseDataEndpointPath,
  parseRouteParams,
  parseRouteQuery,
} from "./schemas.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

const TRAILING_SLASH_RE = /\/$/;

/** How a runtime answers page dispatch and SPA navigation requests. */
export interface RuntimeRoutes {
  /** Whether a logical path matches one of the runtime's pages. */
  matches: (path: string) => boolean;
  /** Development: reconciles the route topology before an HMR data refresh. */
  refresh: (() => Promise<void>) | undefined;
  render: FurinRouteDispatcher;
}

const runtimeRoutes = new WeakMap<FurinInstance, RuntimeRoutes>();
const navigationDataRequests = new WeakSet<Request>();

export function bindRuntimeRoutes(instance: FurinInstance, routes: RuntimeRoutes): void {
  runtimeRoutes.set(instance, routes);
}

export function hasRuntimeRoutes(instance: FurinInstance): boolean {
  return runtimeRoutes.has(instance);
}

/** Whether a request targets a registered page in the specified Furin mount. */
export function isFurinPageRequest(request: Request, prefix: string): boolean {
  if (request.method !== "GET") {
    return false;
  }
  const url = new URL(request.url);
  const { pathname } = url;
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
  if (path === "/_furin/data") {
    const dataPath = parseDataEndpointPath(url.searchParams.get("path") ?? "");
    return dataPath !== undefined && routes.matches(dataPath.pathname);
  }
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

function rewriteNavigationDataRequest(
  request: Request,
  instance: FurinInstance,
  routes: RuntimeRoutes
): Request | Response {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== `${instance.prefix}/_furin/data`) {
    return request;
  }
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return new Response("Missing required query param: path", { status: 400 });
  }
  const parsed = parseDataEndpointPath(rawPath);
  if (!parsed) {
    return new Response("Invalid path", { status: 400 });
  }
  if (!routes.matches(parsed.pathname)) {
    return new Response("Not Found", { status: 404 });
  }
  url.pathname = physicalPath(instance.prefix, parsed.pathname);
  url.search = parsed.url.search;
  const rewritten = new Request(url, request);
  navigationDataRequests.add(rewritten);
  return rewritten;
}

type RequestWrap = Parameters<AnyElysia["wrap"]>[0];

/**
 * The runtime's `.wrap()`: binds requests under its prefix to the runtime and
 * turns its `/_furin/data` navigation requests into page requests.
 */
export function createRequestScope(instance: FurinInstance): RequestWrap {
  return (fetch) =>
    (request, ...rest) =>
      enterRequestScope(instance, request, () => {
        const routes = runtimeRoutes.get(instance);
        if (!routes) {
          return fetch(request, ...rest);
        }
        const dispatch = () => {
          const rewritten = rewriteNavigationDataRequest(request, instance, routes);
          if (rewritten instanceof Response) {
            return rewritten;
          }
          if (rewritten === request) {
            return fetch(request, ...rest);
          }
          adoptScopedRequest(rewritten);
          return Promise.resolve(fetch(rewritten, ...rest)).then((resolved) =>
            resolved.status >= 300 && resolved.status < 400
              ? serializeGuardRedirect(resolved, request)
              : resolved
          );
        };
        const url = new URL(request.url);
        const dataPath =
          url.pathname === `${instance.prefix}/_furin/data`
            ? parseDataEndpointPath(url.searchParams.get("path") || "")
            : undefined;
        const refresh =
          request.method === "GET" &&
          dataPath !== undefined &&
          routes.matches(dataPath.pathname) &&
          request.headers.get("x-furin-hmr-refresh") === "1"
            ? routes.refresh
            : undefined;
        return refresh ? refresh().then(dispatch) : dispatch();
      });
}

function matchesNativeRoute(
  context: Parameters<FurinRouteDispatcher>[0],
  prefix: string,
  pattern: string
): context is Parameters<FurinRouteDispatcher>[0] & {
  params: { [key: string]: unknown };
} {
  return (
    context.params !== null &&
    typeof context.params === "object" &&
    typeof context.route === "string" &&
    context.route.replace(TRAILING_SLASH_RE, "") ===
      physicalPath(prefix, pattern).replace(TRAILING_SLASH_RE, "")
  );
}

function parseRendererParams(
  context: Parameters<FurinRouteDispatcher>[0],
  prefix: string,
  route: ResolvedRoute,
  matchedParams: { [key: string]: string }
) {
  const nativeParams = matchesNativeRoute(context, prefix, route.pattern)
    ? context.params
    : undefined;
  // Dev's schema-free route shell must validate against the current snapshot.
  // Production's native route has already validated and decoded its schema.
  return !IS_DEV && nativeParams
    ? Promise.resolve({ ok: true as const, params: nativeParams })
    : parseRouteParams(
        nativeParams ?? matchedParams,
        mergeRouteSchemas(route.routeChain, "params")
      );
}

export function createNativeRouteRenderer(
  instance: FurinInstance,
  routes: ResolvedRoute[],
  root: RootLayout,
  buildId: string,
  searchRoutes: ReturnType<typeof createSearchRouteMetadata>
): FurinRouteDispatcher {
  const matchNativeRoute = buildRouteMatcher(routes);
  const { prefix } = instance;
  return async (context) => {
    const { request } = context;
    const requestUrl = new URL(request.url);
    const { pathname } = requestUrl;
    const hasPrefix = pathname === prefix || pathname.startsWith(`${prefix}/`);
    const logicalPath = hasPrefix ? pathname.slice(prefix.length) : pathname;
    const matched = matchNativeRoute(logicalPath || "/");
    if (!matched || (IS_DEV && !existsSync(matched.route.path))) {
      // Dev topology swap: the mounted Elysia route can outlive its source
      // file (hot-remove). Render the root not-found page instead of failing.
      const listenerOrigin = (context.server as { url?: { origin: string } } | undefined)?.url
        ?.origin;
      return renderRootNotFound(root, request, listenerOrigin);
    }
    const parsedParams = await parseRendererParams(context, prefix, matched.route, matched.params);
    if (!parsedParams.ok) {
      return problem(422, { detail: "Invalid params", errors: parsedParams.errors });
    }
    const parsedQuery = await parseRouteQuery(
      requestUrl,
      mergeRouteSchemas(matched.route.routeChain, "query")
    );
    if (!parsedQuery.ok) {
      return problem(422, { detail: "Invalid query", errors: parsedQuery.errors });
    }
    context.params = parsedParams.params;
    context.query = parsedQuery.query;
    if (navigationDataRequests.has(request)) {
      getLogger().set({
        path: (logicalPath || "/") + requestUrl.search,
        routePattern: matched.route.pattern,
      });
      const current = IS_DEV
        ? await resolveCurrentDevRoute(matched.route, root)
        : { root, route: matched.route };
      return renderRouteData(
        current.route,
        context as unknown as Parameters<typeof renderRouteData>[1],
        current.root,
        searchRoutes,
        logicalPath + requestUrl.search
      );
    }
    return renderResolvedRoute(
      matched.route,
      context as unknown as Parameters<typeof renderResolvedRoute>[1],
      root,
      buildId,
      searchRoutes
    );
  };
}

/**
 * Dispatches a native Furin route to the runtime owning the request. Native
 * route handlers share one Elysia decorator across mounts, so the runtime
 * comes from the request scope its wrap opened.
 */
export function dispatchNativeRoute(context: Parameters<FurinRouteDispatcher>[0]): unknown {
  const instance = scopedInstance();
  const renderer = instance && runtimeRoutes.get(instance)?.render;
  if (!renderer) {
    const { pathname } = new URL(context.request.url);
    const declared = allInstances().map((peer) => JSON.stringify(peer.prefix || "/"));
    throw new Error(
      `[furin] ${JSON.stringify(pathname)} reached a Furin page route outside every declared prefix (${declared.join(", ")}). furin({ prefix }) must be the full physical path: mount Furin on an Elysia instance without a prefix and repeat the parent prefix in furin({ prefix }).`
    );
  }
  return renderer(context);
}
