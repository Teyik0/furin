import { log } from "evlog";
import type { HeadOptions } from "../../client.ts";
import { parseDeferredNdjson } from "../../shared/deferred-ndjson.ts";
import { isWithinPrefix } from "../../shared/prefix.ts";
import { findRouteFailure } from "../../shared/route-matches.ts";
import type { QuerySeed } from "../../shared/sync-query.ts";
import { isAbortError } from "./abort.ts";
import { isStaleDeployResponse } from "./history.ts";
import { normalizeHref, toLogical } from "./link-utils.ts";
import { buildDataEndpoint, classifySpaResponse, parsePageResponse } from "./spa-response.ts";
import { trackDeferredTransport } from "./transport.ts";
import type {
  ClientRoute,
  ClientSegmentBoundary,
  LoadedClientRoute,
  RouterState,
} from "./types.ts";

/** Why a navigation must leave the SPA and let the browser load the URL. */
type HardNavigateReason =
  | "malformed-stream"
  | "missing-route-module"
  | "network-error"
  | "redirect-outside-app"
  | "server-error"
  | "stale-deploy"
  | "unexpected-response";

/**
 * Outcome of fetching one page. Renderable outcomes carry the router state and
 * whether their deferred stream can still be reused from a cache.
 */
export type PageResult =
  | {
      kind: "page" | "error" | "notFound";
      /** `false` once the deferred stream was cancelled before it settled. */
      reusable: () => boolean;
      state: RouterState;
    }
  | { kind: "redirect"; href: string }
  | { kind: "hardNavigate"; reason: HardNavigateReason }
  | { kind: "aborted" };

export interface PageFetchContext {
  basePath: string;
  /** Captures the query store hydration for the snapshot about to be fetched. */
  captureHydration: () => RouterState["hydrateQueries"];
  /** Match reused by HMR refreshes (no module load) and by root not-found pages. */
  currentMatch: () => LoadedClientRoute | null;
  /** Root-owned not-found boundary used when no client route matches. */
  rootBoundaries: ClientSegmentBoundary[] | undefined;
  routes: ClientRoute[];
  staticMode: boolean;
}

const ALWAYS_REUSABLE = () => true;

/**
 * Resolves the page when no client-side route matched the URL. The server's
 * `renderRootNotFound` produced the 404 HTML; fetching the physical URL detects
 * the `__furinStatus: 404` signal so the 404 UI renders inline instead of
 * through a full-page reload.
 */
async function fetchNoMatchPage(
  context: PageFetchContext,
  physicalHref: string,
  signal: AbortSignal | undefined
): Promise<PageResult> {
  const res = await fetch(physicalHref, { signal });
  if (isStaleDeployResponse(res)) {
    return { kind: "hardNavigate", reason: "stale-deploy" };
  }
  const { data, finalHref, title } = await parsePageResponse(res, context.basePath);
  const kind = classifySpaResponse(res.status, data);
  if (kind.kind !== "not-found") {
    return { kind: "hardNavigate", reason: "unexpected-response" };
  }
  return {
    kind: "notFound",
    reusable: ALWAYS_REUSABLE,
    state: {
      data: data ?? {},
      finalHref,
      match: context.currentMatch(),
      notFound: kind.error,
      notFoundBoundaries: context.rootBoundaries,
      title,
    },
  };
}

function resolveRedirect(context: PageFetchContext, redirect: string): PageResult {
  const { basePath, routes } = context;
  const target = new URL(redirect, window.location.origin);
  const isLogicalPath = redirect.startsWith("/") && !redirect.startsWith("//");
  const withinMount = isLogicalPath || isWithinPrefix(target.pathname, basePath);
  const targetPath = isLogicalPath ? target.pathname : toLogical(target.pathname, basePath);
  if (
    target.origin !== window.location.origin ||
    !withinMount ||
    !routes.some((route) => route.regex.test(targetPath))
  ) {
    return { kind: "hardNavigate", reason: "redirect-outside-app" };
  }
  return { kind: "redirect", href: targetPath + target.search + target.hash };
}

/**
 * Fetches a page's loader data (NDJSON endpoint) and route module in parallel
 * and classifies the response. Never throws: failures become `hardNavigate`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SPA response shapes (redirect, stale-deploy, deferred, sentinels) are classified in one place
export async function fetchPageState(
  context: PageFetchContext,
  rawLogicalHref: string,
  signal: AbortSignal | undefined,
  hmrRefresh: boolean
): Promise<PageResult> {
  const { basePath, routes, staticMode } = context;
  const hydrateQueries = context.captureHydration();
  // Normalize trailing slashes so "/docs/routing/" matches the route
  // pattern "/docs/routing" — static hosts (GitHub Pages, Netlify) often
  // redirect to or serve URLs with a trailing slash.
  const logicalHref = normalizeHref(rawLogicalHref);
  // Physical href: what the browser/server actually receives.
  // For basePath deployments: fetch("/furin/docs/routing") not fetch("/docs/routing").
  const physicalHref = basePath + logicalHref;
  try {
    const url = new URL(physicalHref, window.location.origin);
    // Route matching always uses the LOGICAL pathname (basePath stripped).
    const logicalPathname = toLogical(url.pathname, basePath);
    const match = routes.find((r) => r.regex.test(logicalPathname));
    if (!match) {
      return await fetchNoMatchPage(context, physicalHref, signal);
    }

    // ── NDJSON data endpoint + JS chunk load (parallel) ──────────────────
    const dataEndpoint = buildDataEndpoint(basePath, logicalHref, staticMode);
    // Production builds define NODE_ENV, which compiles the HMR branches out.
    const loadedModule =
      process.env.NODE_ENV !== "production" && hmrRefresh
        ? Promise.resolve(undefined)
        : match.load();
    const [res, loadedMod] = await Promise.all([
      fetch(dataEndpoint, {
        headers:
          process.env.NODE_ENV !== "production" && hmrRefresh
            ? { "x-furin-hmr-refresh": "1" }
            : undefined,
        redirect: "manual",
        signal,
      }),
      loadedModule,
    ]);

    // Stale-deploy detection: force a full page reload to pick up the new bundle.
    if (isStaleDeployResponse(res)) {
      return { kind: "hardNavigate", reason: "stale-deploy" };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (
      !(
        staticMode ||
        contentType.includes("application/x-ndjson") ||
        contentType.includes("application/x-furin-route")
      )
    ) {
      return { kind: "hardNavigate", reason: "unexpected-response" };
    }

    const body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    let parsed: {
      syncData: Record<string, unknown>;
      deferredPromises: Record<string, Promise<unknown>>;
    };
    try {
      parsed = await parseDeferredNdjson(body, signal);
    } catch (parseErr) {
      if (isAbortError(parseErr)) {
        return { kind: "aborted" };
      }
      log.warn({
        action: "navigate_server_error",
        error: String(parseErr),
        href: physicalHref,
        status: res.status,
      });
      return { kind: "hardNavigate", reason: "malformed-stream" };
    }
    const { syncData, deferredPromises } = parsed;
    const reusable = trackDeferredTransport(deferredPromises, signal);

    // Special fields injected by the server into syncData:
    //   __furinMatches  — per-segment matches; a failed one signals error / 404
    //   __furinRedirect — server-side redirect target (logical path)
    //   __furinTitle    — document title resolved server-side from head()
    const { __furinHead, __furinRedirect, __furinTitle, __furinQueries, ...cleanSyncData } =
      syncData as {
        __furinRedirect?: string;
        __furinHead?: HeadOptions;
        __furinTitle?: string;
        __furinQueries?: QuerySeed[];
        [key: string]: unknown;
      };
    const failure = findRouteFailure(syncData);

    if (typeof __furinRedirect === "string") {
      return resolveRedirect(context, __furinRedirect);
    }

    // Merge sync data + deferred Promises.
    const data = { ...cleanSyncData, ...deferredPromises };

    const title = typeof __furinTitle === "string" ? __furinTitle : "";

    const loadedMatch: LoadedClientRoute | null = loadedMod
      ? {
          ...match,
          component: loadedMod.default.component,
          pageRoute: loadedMod.default._route,
          segmentBoundaries: loadedMod.segmentBoundaries ?? match.segmentBoundaries,
        }
      : context.currentMatch();
    if (!loadedMatch) {
      return { kind: "hardNavigate", reason: "missing-route-module" };
    }

    // Loader threw a non-redirect Response (or an Error).
    if (failure?.status === "error") {
      return {
        kind: "error",
        reusable,
        state: { data, error: failure.error, head: __furinHead, match: loadedMatch, title },
      };
    }

    // Non-2xx without a failed match and not 404 → opaque server error.
    if (!res.ok && res.status !== 404) {
      log.warn({ action: "navigate_server_error", href: physicalHref, status: res.status });
      return { kind: "hardNavigate", reason: "server-error" };
    }

    if (failure?.status === "notFound") {
      return {
        kind: "notFound",
        reusable,
        state: { data, head: __furinHead, match: loadedMatch, notFound: failure.error, title },
      };
    }

    return {
      kind: "page",
      reusable,
      state: {
        data,
        head: __furinHead,
        match: loadedMatch,
        querySeeds: __furinQueries,
        hydrateQueries,
        title,
      },
    };
  } catch (err: unknown) {
    if (isAbortError(err)) {
      return { kind: "aborted" };
    }
    log.error({ action: "navigate_failed", error: String(err), href: physicalHref });
    return { kind: "hardNavigate", reason: "network-error" };
  }
}
