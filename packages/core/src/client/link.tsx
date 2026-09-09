import type React from "react";
import { createElement, useCallback, useEffect, useRef } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../shared/search-params.ts";
import { CLIENT_FALLBACK_ROUTER, RouterContext, useRouter } from "./router/context.ts";
import {
  applyLinkParams,
  buildHref,
  navigationHrefPolicy,
  normalizeHref,
} from "./router/link-utils.ts";
import type { LinkProps, RouterContextValue, RouteTo } from "./router/types.ts";

// biome-ignore lint/performance/noBarrelFile: re-exporting router symbols preserves backward compatibility for @teyik0/furin/link consumers
export * from "./router/index.ts";

// ── Link ───────────────────────────────────────────────────────────────────────

interface LinkView {
  extraProps: React.AnchorHTMLAttributes<HTMLAnchorElement>;
  href: string;
  isActive: boolean;
  logicalHref: string;
  resolvedChildren: React.ReactNode;
}

/**
 * Shared href/active-state/props computation used by both LinkInteractive (CSR)
 * and renderLinkElement (SSR). Centralising this keeps the two render paths in sync.
 */
function computeLinkView<To extends RouteTo>(
  {
    to,
    params,
    search,
    hash,
    children,
    activeProps,
    inactiveProps,
  }: Pick<
    LinkProps<To>,
    "to" | "params" | "search" | "hash" | "children" | "activeProps" | "inactiveProps"
  >,
  router: RouterContextValue
): LinkView {
  const resolvedTo = applyLinkParams(
    to as string,
    params as Record<string, string | number> | null | undefined
  );
  const searchDefaults = findSearchDefaultsForRouteTarget(resolvedTo, router.searchRoutes);
  const logicalHref = buildHref(
    resolvedTo,
    search as SearchParamsInput | null | undefined,
    hash,
    searchDefaults
  );
  const logicalHrefWithoutHash = buildHref(
    resolvedTo,
    search as SearchParamsInput | null | undefined,
    undefined,
    searchDefaults
  );
  const isAbsolute =
    logicalHref.startsWith("http://") ||
    logicalHref.startsWith("https://") ||
    logicalHref.startsWith("//");
  const candidateHref = isAbsolute ? logicalHref : router.basePath + logicalHref;
  const href = navigationHrefPolicy(candidateHref, undefined) === "blocked" ? "#" : candidateHref;
  const isActive = !isAbsolute && router.currentHref === normalizeHref(logicalHrefWithoutHash);
  const resolvedChildren = typeof children === "function" ? children({ isActive }) : children;
  const extraProps: React.AnchorHTMLAttributes<HTMLAnchorElement> = {
    ...(inactiveProps && !isActive ? inactiveProps() : {}),
    ...(activeProps ? activeProps({ isActive }) : {}),
  };
  return { extraProps, href, isActive, logicalHref, resolvedChildren };
}

function isSameOriginUrl(url: string): boolean {
  return navigationHrefPolicy(url, window.location.origin) === "internal";
}

/**
 * Full interactive Link — only rendered on the client where hooks are safe.
 * Never rendered during SSR so it's immune to duplicate-React-instance issues
 * that can arise when page modules are loaded via the furin-dev-page virtual
 * namespace (Bun HMR).
 */
function LinkInteractive<To extends RouteTo>({
  to,
  params,
  search,
  hash,
  preload,
  preloadDelay,
  preloadStaleTime,
  replace,
  disabled,
  resetScroll,
  activeProps,
  inactiveProps,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  children,
  // @ts-expect-error: defensive strip of accidental href prop passed via spread
  href: _href,
  ...anchorProps
}: LinkProps<To>): React.ReactElement {
  const router = useRouter();
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // logicalHref: route-relative path (no basePath), used for navigation + active state.
  // physicalHref (href): what the browser sees — basePath + logicalHref.
  const { logicalHref, href, isActive, resolvedChildren, extraProps } = computeLinkView(
    { activeProps, children, hash, inactiveProps, params, search, to },
    router
  );
  const effectivePreload = preload ?? router.defaultPreload;
  const effectiveDelay = preloadDelay ?? router.defaultPreloadDelay;
  const effectiveStaleTime = preloadStaleTime ?? router.defaultPreloadStaleTime;

  const { prefetch } = router;
  const triggerPrefetch = useCallback(() => {
    // prefetch() expects the logical href (no basePath prefix).
    prefetch(logicalHref, { staleTime: effectiveStaleTime });
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [prefetch, logicalHref, effectiveStaleTime]);

  // "render": preload immediately on mount
  useEffect(() => {
    if (effectivePreload === "render") {
      triggerPrefetch();
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [effectivePreload, triggerPrefetch]);

  // "viewport": preload when link enters viewport
  useEffect(() => {
    if (effectivePreload !== "viewport" || !anchorRef.current) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          triggerPrefetch();
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(anchorRef.current);
    return () => observer.disconnect();
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [effectivePreload, triggerPrefetch]);

  // Clear any pending intent prefetch timer on unmount to avoid leaking
  // setTimeout callbacks between test cases (or across re-renders).
  useEffect(
    () => () => {
      if (intentTimerRef.current !== null) {
        clearTimeout(intentTimerRef.current);
        intentTimerRef.current = null;
      }
    },
    []
  );

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) {
      return;
    }
    if (disabled) {
      e.preventDefault();
      return;
    }
    // Let browser handle modifier+click (new tab, etc.)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    // Let browser handle non-self targets (e.g. target="_blank")
    if (anchorProps.target && anchorProps.target !== "_self") {
      return;
    }
    if (navigationHrefPolicy(logicalHref, window.location.origin) === "blocked") {
      e.preventDefault();
      return;
    }
    // Let browser handle external links
    if (!isSameOriginUrl(href)) {
      return;
    }
    e.preventDefault();
    // When there is no RouterProvider, fall back to a full-page navigation so
    // the link is still functional (e.g. in storybooks or third-party pages).
    if (typeof window !== "undefined" && router.navigate === CLIENT_FALLBACK_ROUTER.navigate) {
      window.location.href = href;
      return;
    }
    // navigate() expects the logical href (no basePath prefix).
    router.navigate(logicalHref, { replace, resetScroll: resetScroll ?? true });
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onMouseEnter?.(e);
    if (!disabled && effectivePreload === "intent" && isSameOriginUrl(href)) {
      intentTimerRef.current = setTimeout(triggerPrefetch, effectiveDelay);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onMouseLeave?.(e);
    if (intentTimerRef.current !== null) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLAnchorElement>) => {
    onFocus?.(e);
    if (!disabled && effectivePreload === "intent" && isSameOriginUrl(href)) {
      triggerPrefetch();
    }
  };

  return createElement(
    "a",
    {
      "data-furin-link": true,
      href,
      onClick: handleClick,
      onFocus: handleFocus,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      ref: anchorRef,
      ...(isActive ? { "data-status": "active" } : {}),
      ...anchorProps,
      ...extraProps,
      ...(disabled ? { "aria-disabled": true } : {}),
    },
    resolvedChildren
  );
}

// ── SSR fallback router ────────────────────────────────────────────────────────

/**
 * Static fallback used by Link during SSR when there is no RouterProvider.
 * Must not reference `window` — this object is created at module parse time.
 */
/** @internal Exported for unit testing only. */
export const SSR_FALLBACK_ROUTER: RouterContextValue = {
  basePath: "",
  currentHref: "/",
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
  search: {},
  searchRoutes: [],
};

/**
 * Pure render helper — no hooks, safe to call from any context including SSR.
 * Computes href, active state, and applies activeProps / inactiveProps before
 * returning the final `<a>` element.
 */
function renderLinkElement<To extends RouteTo>(
  props: LinkProps<To>,
  router: RouterContextValue
): React.ReactElement {
  const { href, isActive, resolvedChildren, extraProps } = computeLinkView(props, router);

  // Destructure to strip Link-specific and client-only props before spreading onto <a>.
  const {
    to: _to,
    params: _params,
    search: _search,
    hash: _hash,
    children: _children,
    activeProps: _ap,
    inactiveProps: _ip,
    disabled,
    preload: _p,
    preloadDelay: _pd,
    preloadStaleTime: _ps,
    replace: _r,
    resetScroll: _rs,
    onClick: _oc,
    onMouseEnter: _ome,
    onMouseLeave: _oml,
    onFocus: _of,
    // @ts-expect-error: defensive strip of accidental href prop passed via spread
    href: _href,
    ...anchorProps
  } = props;

  return createElement(
    "a",
    {
      "data-furin-link": true,
      href,
      ...(isActive ? { "data-status": "active" } : {}),
      ...anchorProps,
      ...extraProps,
      ...(disabled ? { "aria-disabled": true } : {}),
    },
    resolvedChildren
  );
}

/**
 * SSR-aware Link component.
 *
 * - **Server (SSR):** uses `RouterContext.Consumer` (a render-prop, not a hook)
 *   to read basePath / currentHref from any enclosing RouterProvider, then
 *   falls back to `SSR_FALLBACK_ROUTER` when no provider is present.
 *   `Context.Consumer` bypasses `ReactCurrentDispatcher` entirely, so it is
 *   safe even when two React instances coexist in the module graph (Bun HMR).
 * - **Client:** delegates to `LinkInteractive` which adds preloading, SPA
 *   navigation, active-state tracking and all other interactive features.
 */
export function Link<To extends RouteTo>(props: LinkProps<To>): React.ReactElement {
  if (typeof window === "undefined") {
    // Use Context.Consumer instead of useContext — the Consumer is processed
    // by react-dom/server directly (no dispatcher lookup), so it works even
    // when link.tsx is loaded under a second React instance via the
    // furin-dev-page virtual namespace after a Bun HMR reload.
    return createElement(RouterContext.Consumer, {
      // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — RouterContext.Consumer requires children as a function; cannot be passed as createElement 3rd arg due to TypeScript overloads
      children: (routerCtx: RouterContextValue | null) =>
        renderLinkElement(props, routerCtx ?? SSR_FALLBACK_ROUTER),
    });
  }

  // ── Client rendering ──────────────────────────────────────────────────────
  return createElement(
    LinkInteractive as React.ComponentType<LinkProps<RouteTo>>,
    props as LinkProps<RouteTo>
  );
}

// ── Deferred hydration helpers ─────────────────────────────────────────────────
// Re-exported here so generated `_hydrate.tsx` files can import from
// `@teyik0/furin/link` (already a client-only bundle entry) without requiring
// apps to add "seroval" as a direct dependency.
export { fromCrossJSON } from "seroval";
export { parseDeferredNdjson } from "../shared/deferred-ndjson.ts";
