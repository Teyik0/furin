import { createContext, useCallback, useContext, useMemo } from "react";
import { navigationHrefPolicy, type RuntimeRouteTarget, resolveRouteTarget } from "./link-utils.ts";
import type {
  NavigationOptions,
  Prefetch,
  Router,
  RouterContextValue,
  RouterNavigate,
} from "./types.ts";

export const RouterContext = createContext<RouterContextValue | null>(null);

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

export function useRouter(): Router {
  const context = useRouterContext();
  const navigate: RouterNavigate = useCallback(
    (next: string | (RuntimeRouteTarget & NavigationOptions), opts?: NavigationOptions) => {
      const href = typeof next === "string" ? next : resolveRouteTarget(next, context.searchRoutes);
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
        return context.navigate(href, opts);
      }
      const options =
        next.replace === undefined && next.resetScroll === undefined
          ? undefined
          : { replace: next.replace, resetScroll: next.resetScroll };
      return context.navigate(href, options);
    },
    [context.navigate, context.searchRoutes]
  );
  const prefetch: Prefetch = useCallback(
    (
      next: string | (RuntimeRouteTarget & { staleTime?: number }),
      opts?: { staleTime?: number }
    ) => {
      const href = typeof next === "string" ? next : resolveRouteTarget(next, context.searchRoutes);
      const policy = navigationHrefPolicy(
        href,
        typeof window === "undefined" ? undefined : window.location.origin
      );
      if (policy !== "internal") {
        return;
      }
      context.prefetch(href, typeof next === "string" ? opts : { staleTime: next.staleTime });
    },
    [context.prefetch, context.searchRoutes]
  );
  return useMemo(() => ({ ...context, navigate, prefetch }), [context, navigate, prefetch]);
}
