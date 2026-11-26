import { type Context, createContext, use, useCallback, useContext, useMemo } from "react";
import {
  applyLinkParams,
  navigationHrefPolicy,
  type RuntimeRouteTarget,
  resolveRouteTarget,
  resolveTargetSearch,
} from "./link-utils.ts";
import type {
  NavigationOptions,
  Prefetch,
  Router,
  RouterContextValue,
  RouterNavigate,
  RouterStore,
  StableRouter,
  TargetNavigationOptions,
} from "./types.ts";

// Duplicate module copies (separate entrypoints, client references) must share
// one context, or a Link rendered by another copy never sees the provider.
const ROUTER_CONTEXT = Symbol.for("furin.router.context.v1");
const ROUTER_STORE_CONTEXT = Symbol.for("furin.router.store.v1");
const contextGlobal = globalThis as typeof globalThis & {
  [ROUTER_CONTEXT]?: Context<RouterContextValue | null>;
  [ROUTER_STORE_CONTEXT]?: Context<RouterStore | null>;
};
/** Full router value; changes on every navigation, re-rendering every reader. */
export const RouterContext = (contextGlobal[ROUTER_CONTEXT] ??=
  createContext<RouterContextValue | null>(null));
/** Stable counterpart of `RouterContext`, provided by `RouterProvider`. */
export const RouterStoreContext = (contextGlobal[ROUTER_STORE_CONTEXT] ??=
  createContext<RouterStore | null>(null));

export const CLIENT_FALLBACK_ROUTER: RouterContextValue = {
  basePath: "",
  // Use the same "/" as SSR_FALLBACK_ROUTER so SSR and client render the
  // same active-state when no RouterProvider is present, avoiding hydration mismatches.
  currentHref: "/",
  defaultPreload: "intent",
  defaultPreloadDelay: 50,
  defaultPreloadStaleTime: 30_000,
  invalidatePrefetch: (_path, _type) => {
    /* noop fallback */
  },
  isNavigating: false,
  navigate: (href, _opts) => {
    if (navigationHrefPolicy(href, window.location.origin) === "blocked") {
      return Promise.reject(new Error("[furin] Unsafe navigation URL."));
    }
    window.location.href = href;
    return Promise.resolve();
  },
  prefetch: (_href, _opts) => {
    /* noop fallback */
  },
  refresh: (_opts) => {
    window.location.reload();
    return Promise.resolve();
  },
  search: {},
  searchRoutes: [],
};

/**
 * Returns the current router context.
 * Provides a graceful fallback (full-page navigation) when used outside RouterProvider.
 */
export function useRouterContext(): RouterContextValue {
  const ctx = useContext(RouterContext);
  return ctx ?? CLIENT_FALLBACK_ROUTER;
}

const subscribeNever = (_listener: () => void) => () => undefined;

/**
 * Returns the stable router handle. Outside `RouterProvider` (a bare
 * `RouterContext.Provider`, or no provider at all) it wraps the plain context
 * value, which is replaced rather than mutated, so it never notifies.
 */
export function useRouterStore(): RouterStore {
  const store = use(RouterStoreContext);
  if (store) {
    return store;
  }
  const value = use(RouterContext) ?? CLIENT_FALLBACK_ROUTER;
  return { getCurrentHref: () => value.currentHref, router: value, subscribe: subscribeNever };
}

function targetSearch(target: RuntimeRouteTarget, routes: StableRouter["searchRoutes"]) {
  return resolveTargetSearch(
    applyLinkParams(target.to, target.params as Record<string, string | number> | undefined),
    target.search,
    routes
  );
}

export function useTypedNavigation(context: StableRouter): Pick<Router, "navigate" | "prefetch"> {
  const { navigate: navigateHref, prefetch: prefetchHref, searchRoutes } = context;
  const navigate: RouterNavigate = useCallback(
    (next: string | (RuntimeRouteTarget & TargetNavigationOptions), opts?: NavigationOptions) => {
      const href = typeof next === "string" ? next : resolveRouteTarget(next, searchRoutes);
      const policy = navigationHrefPolicy(
        href,
        typeof window === "undefined" ? undefined : window.location.origin
      );
      if (policy === "blocked") {
        return Promise.reject(new Error("[furin] Unsafe navigation URL."));
      }
      if (policy === "external" && typeof window !== "undefined") {
        window.location.assign(href);
        return Promise.resolve();
      }
      if (typeof next === "string") {
        return navigateHref(href, opts);
      }
      return navigateHref(href, {
        replace: next.replace,
        resetScroll: next.resetScroll,
        search: targetSearch(next, searchRoutes),
        shallow: next.shallow,
      });
    },
    [navigateHref, searchRoutes]
  );
  const prefetch: Prefetch = useCallback(
    (
      next: string | (RuntimeRouteTarget & { staleTime?: number }),
      opts?: { staleTime?: number }
    ) => {
      const href = typeof next === "string" ? next : resolveRouteTarget(next, searchRoutes);
      const policy = navigationHrefPolicy(
        href,
        typeof window === "undefined" ? undefined : window.location.origin
      );
      if (policy !== "internal") {
        return;
      }
      prefetchHref(
        href,
        typeof next === "string"
          ? opts
          : { search: targetSearch(next, searchRoutes), staleTime: next.staleTime }
      );
    },
    [prefetchHref, searchRoutes]
  );
  return { navigate, prefetch };
}

export function useRouter(): Router {
  const context = useRouterContext();
  const { navigate, prefetch } = useTypedNavigation(context);
  return useMemo(() => ({ ...context, navigate, prefetch }), [context, navigate, prefetch]);
}
