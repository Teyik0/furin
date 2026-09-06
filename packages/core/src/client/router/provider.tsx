import { log } from "evlog";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HeadOptions } from "../../client.ts";
import { parseDeferredNdjson } from "../../shared/deferred-ndjson.ts";
import type { SearchParamsInput } from "../../shared/search-params.ts";
import { DocumentProvider, useDocumentState } from "../document.tsx";
import { isAbortError } from "./abort.ts";
import { buildPageElement, buildRouterTree } from "./boundary-tree.tsx";
import {
  generateHistoryKey,
  getHistoryKey,
  isStaleDeployResponse,
  SCROLL_STORAGE_KEY,
  saveScrollPosition,
} from "./history.ts";
import {
  applyRevalidateEntries,
  applyRevalidateHeader,
  decodeHashFragment,
  isSameOriginFetchResult,
  normalizeHref,
  shouldAutoRefreshPath,
  shouldInterceptClick,
  shouldRefetch,
  stripHashFromHref,
  toLogical,
} from "./link-utils.ts";
import { createSearchStore, SearchStoreContext } from "./search-store.ts";
import {
  buildDataEndpoint,
  buildNotFoundPageElement,
  classifySpaResponse,
  detectStaticMode,
  parsePageResponse,
} from "./spa-response.ts";
import {
  createInvalidationRefresh,
  createSyncCatchUp,
  type SyncChangePagePayload,
} from "./sync-catch-up.ts";
import type {
  CacheEntry,
  ClientSegmentBoundary,
  LoadedClientRoute,
  RouterProviderProps,
  RouterState,
} from "./types.ts";

const EMPTY_SEARCH: SearchParamsInput = {};

function getHistoryStateObject(): object {
  const value = history.state;
  return value !== null && typeof value === "object" ? value : {};
}

export function setPrefetchCacheEntry(
  cache: Map<string, CacheEntry>,
  href: string,
  entry: CacheEntry,
  maxSize: number
): void {
  if (cache.has(href)) {
    cache.delete(href);
  }
  cache.set(href, entry);
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") {
      cache.delete(oldest);
    }
  }
}

export function RouterProvider({
  routes,
  root,
  initialMatch,
  initialData,
  initialDigest,
  initialNotFound,
  autoRefresh,
  basePath,
  defaultPreload,
  defaultPreloadDelay,
  defaultPreloadStaleTime,
  prefetchCacheSize,
  syncStream,
}: RouterProviderProps): React.ReactElement {
  const initialDocumentState = useDocumentState();
  // Initial state. When `initialMatch` is `null`, `initialNotFound` MUST be set —
  // the provider boots into the inline not-found UI.
  const [state, setState] = useState<RouterState>(() => ({
    data: initialData,
    match: initialMatch,
    notFound: initialNotFound,
  }));
  const [isNavigating, setIsNavigating] = useState(false);
  // currentHref stores the LOGICAL path (basePath stripped) so Link active-state
  // detection works with route patterns that never include the basePath prefix.
  const [currentHref, setCurrentHref] = useState<string>(() => {
    if (typeof window === "undefined") {
      return "/";
    }
    return normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search;
  });
  const prefetchCache = useRef(new Map<string, CacheEntry>());
  /** Monotonic counter to discard stale navigations (race condition guard). */
  const navVersion = useRef(0);
  /**
   * AbortController for the current navigation. Cancelled when a newer
   * navigation starts so any in-flight `parseDeferredNdjson` releases its
   * pending deferred promises (resolvers reject with `AbortError`) and frees
   * the underlying stream reader.
   */
  const navAbortRef = useRef<AbortController | null>(null);
  /**
   * Deferred scroll instruction consumed by the layout effect tied to `currentHref`.
   * This replaces the fragile double-requestAnimationFrame pattern with a render-
   * synchronous scroll that fires immediately after React commits the new route.
   */
  const pendingScrollRef = useRef<
    { type: "restore"; key: string } | { type: "reset"; href: string } | null
  >(null);
  /**
   * Tracks the last successfully rendered match for use in the no-route 404 path.
   * `null` on the initial render when the URL didn't match any route and the
   * provider booted directly into the not-found state; flips to a real match as
   * soon as the user navigates away via `navigate()` or the back button.
   */
  const currentMatchRef = useRef<LoadedClientRoute | null>(initialMatch);
  /**
   * Cached at boot from `<meta name="furin-mode">`. Drives the SPA-nav data
   * fetch URL: runtime `/_furin/data` for SSR/ISR/dev, per-route
   * `__furin_data.ndjson` for static exports.
   */
  const [staticMode] = useState(detectStaticMode);
  const resolvedSearch = (state.data.query as SearchParamsInput | undefined) ?? EMPTY_SEARCH;

  /**
   * Depth-0 boundary (pagesDir root level) for the "no client route matched" 404
   * path. When an unknown URL is navigated to, the server's `renderRootNotFound`
   * handles it — the root `not-found.tsx` (depth 0) is the correct component to
   * render inline instead of doing a full-page reload.
   */
  const rootBoundaries = useMemo<ClientSegmentBoundary[] | undefined>(() => {
    for (const route of routes) {
      const depth0 = route.segmentBoundaries?.find((b) => b.depth === 0);
      if (depth0) {
        return [depth0];
      }
    }
  }, [routes]);

  /**
   * Resolves the RouterState when no client-side route matched the URL. The
   * server's `renderRootNotFound` produced the 404 HTML; we fetch the physical
   * URL to detect the `__furinStatus: 404` signal and render the 404 UI inline
   * (rather than triggering a jarring full-page reload).
   */
  const resolveNoMatchState = useCallback(
    async (physicalHref: string, signal: AbortSignal | undefined): Promise<RouterState | null> => {
      const res = await fetch(physicalHref, { signal });
      if (isStaleDeployResponse(res)) {
        window.location.href = physicalHref;
        return null;
      }
      const { data, finalHref, title } = await parsePageResponse(res, basePath);
      const kind = classifySpaResponse(res.status, data);
      if (kind.kind !== "not-found") {
        return null;
      }
      const { __furinStatus: _s, __furinNotFound: _n, ...cleanData } = data ?? {};
      return {
        data: cleanData,
        finalHref,
        match: currentMatchRef.current,
        notFound: kind.error,
        notFoundBoundaries: rootBoundaries,
        title,
      };
    },
    [basePath, rootBoundaries]
  );

  const fetchPageState = useCallback(
    async (
      rawLogicalHref: string,
      signal: AbortSignal | undefined
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SPA navigation orchestrator — response shapes (redirect, stale-deploy, deferred) + abort-signal wiring require this depth
    ): Promise<RouterState | null> => {
      // Normalize trailing slashes so "/docs/routing/" matches the route
      // pattern "/docs/routing" — static hosts (GitHub Pages, Netlify) often
      // redirect to or serve URLs with a trailing slash.
      const logicalHref = normalizeHref(rawLogicalHref);
      try {
        // Physical href: what the browser/server actually receives.
        // For basePath deployments: fetch("/furin/docs/routing") not fetch("/docs/routing").
        const physicalHref = basePath + logicalHref;
        const url = new URL(physicalHref, window.location.origin);
        // Route matching always uses the LOGICAL pathname (basePath stripped).
        const logicalPathname = toLogical(url.pathname, basePath);
        const match = routes.find((r) => r.regex.test(logicalPathname));
        if (!match) {
          return await resolveNoMatchState(physicalHref, signal);
        }

        // ── NDJSON data endpoint + JS chunk load (parallel) ──────────────────
        const dataEndpoint = buildDataEndpoint(basePath, logicalHref, staticMode);
        const [res, loadedMod] = await Promise.all([fetch(dataEndpoint, { signal }), match.load()]);

        // Stale-deploy detection: force a full page reload to pick up the new bundle.
        if (isStaleDeployResponse(res)) {
          window.location.href = physicalHref;
          return null;
        }

        const body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        let parsed: {
          syncData: Record<string, unknown>;
          deferredPromises: Record<string, Promise<unknown>>;
        };
        try {
          parsed = await parseDeferredNdjson(body, signal);
        } catch (parseErr) {
          log.warn({
            action: "navigate_server_error",
            error: String(parseErr),
            href: physicalHref,
            status: res.status,
          });
          return null;
        }
        const { syncData, deferredPromises } = parsed;

        // Special fields injected by the server into syncData:
        //   __furinStatus   — 404 signal
        //   __furinNotFound — not-found payload
        //   __furinRedirect — server-side redirect target (logical path)
        //   __furinError    — error sentinel (digest, message, status)
        //   __furinTitle    — document title resolved server-side from head()
        const {
          __furinHead,
          __furinStatus,
          __furinNotFound,
          __furinRedirect,
          __furinError,
          __furinTitle,
          ...cleanSyncData
        } = syncData as {
          __furinStatus?: number;
          __furinNotFound?: { data?: unknown; message?: string };
          __furinRedirect?: string;
          __furinError?: { digest: string; message: string; status: number };
          __furinHead?: HeadOptions;
          __furinTitle?: string;
          [key: string]: unknown;
        };

        const finalHref: string | undefined =
          typeof __furinRedirect === "string" ? __furinRedirect : undefined;

        // Merge sync data + deferred Promises.
        const data = { ...cleanSyncData, ...deferredPromises };

        const title = typeof __furinTitle === "string" ? __furinTitle : "";

        const loadedMatch: LoadedClientRoute = {
          ...match,
          component: loadedMod.default.component,
          pageRoute: loadedMod.default._route,
          segmentBoundaries: loadedMod.segmentBoundaries ?? match.segmentBoundaries,
        };

        // Loader threw a non-redirect Response (or an Error).
        if (__furinError) {
          return {
            data: {},
            error: __furinError,
            finalHref,
            head: __furinHead,
            match: loadedMatch,
            title,
          };
        }

        // Non-2xx without sentinel and not 404 → opaque server error.
        if (!res.ok && res.status !== 404) {
          log.warn({ action: "navigate_server_error", href: physicalHref, status: res.status });
          return null;
        }

        if (__furinStatus === 404) {
          const notFound =
            __furinNotFound !== null && typeof __furinNotFound === "object"
              ? (__furinNotFound as { data?: unknown; message?: string })
              : {};
          return {
            data,
            finalHref,
            head: __furinHead,
            match: loadedMatch,
            notFound,
            title,
          };
        }

        // Server-side redirect: do not mount the pre-redirect route.
        if (finalHref) {
          return { data, finalHref, match: null, title };
        }

        return { data, finalHref, head: __furinHead, match: loadedMatch, title };
      } catch (err: unknown) {
        if (!isAbortError(err)) {
          log.error({
            action: "navigate_failed",
            error: String(err),
            href: basePath + logicalHref,
          });
        }
        return null;
      }
    },
    [routes, basePath, resolveNoMatchState]
  );

  const invalidatePrefetch = useCallback((path: string, type: "page" | "layout") => {
    const normalizedPath = stripHashFromHref(path);

    if (type === "page") {
      for (const key of [...prefetchCache.current.keys()]) {
        if (stripHashFromHref(key) === normalizedPath) {
          prefetchCache.current.delete(key);
        }
      }
      return;
    }

    // layout: prefix match — evict the path itself and all nested children
    const prefix =
      normalizedPath === "/" || normalizedPath.endsWith("/")
        ? normalizedPath
        : `${normalizedPath}/`;
    for (const key of [...prefetchCache.current.keys()]) {
      const normalizedKey = stripHashFromHref(key);
      if (normalizedKey === normalizedPath || normalizedKey.startsWith(prefix)) {
        prefetchCache.current.delete(key);
      }
    }
  }, []);

  const prefetch = useCallback(
    (href: string, opts: { staleTime?: number } | undefined) => {
      const staleTime = opts?.staleTime ?? defaultPreloadStaleTime;
      const existing = prefetchCache.current.get(href);
      if (existing && !shouldRefetch(existing)) {
        return;
      }
      setPrefetchCacheEntry(
        prefetchCache.current,
        href,
        {
          createdAt: Date.now(),
          promise: fetchPageState(href, undefined),
          staleTime,
        },
        prefetchCacheSize
      );
    },
    [fetchPageState, defaultPreloadStaleTime, prefetchCacheSize]
  );

  /** Loads the RouterState for a redirect target, respecting the nav version. */
  async function resolveRedirectState(
    redirectLogical: string,
    myVersion: number,
    signal: AbortSignal | undefined
  ): Promise<RouterState | null> {
    const cached = prefetchCache.current.get(redirectLogical);
    const redirectState =
      cached && !shouldRefetch(cached)
        ? await cached.promise
        : await fetchPageState(redirectLogical, signal);
    if (navVersion.current !== myVersion) {
      return null;
    }
    return redirectState;
  }

  const navigate = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SPA navigation orchestrator — redirect follow, history management, and scroll handling require this depth
    async function navigateTo(
      rawLogicalHref: string,
      opts: { replace?: boolean; resetScroll?: boolean } | undefined
    ) {
      const logicalHref = normalizeHref(rawLogicalHref);
      navVersion.current += 1;
      const myVersion = navVersion.current;
      navAbortRef.current?.abort();
      const navAbort = new AbortController();
      navAbortRef.current = navAbort;
      const navSignal = navAbort.signal;
      setIsNavigating(true);
      try {
        const cached = prefetchCache.current.get(logicalHref);
        let newState =
          cached && !shouldRefetch(cached)
            ? await cached.promise
            : await fetchPageState(logicalHref, navSignal);
        if (navVersion.current !== myVersion) {
          return;
        }
        if (newState && (!cached || shouldRefetch(cached))) {
          setPrefetchCacheEntry(
            prefetchCache.current,
            logicalHref,
            {
              createdAt: Date.now(),
              promise: Promise.resolve(newState),
              staleTime: defaultPreloadStaleTime,
            },
            prefetchCacheSize
          );
        }
        if (!newState) {
          log.warn({
            action: "navigate_fallback",
            href: logicalHref,
            reason: "prefetch_returned_null",
          });
          window.location.href = basePath + logicalHref;
          return;
        }

        // Server-side redirect: replace current history entry and load target
        let redirectLogical: string | undefined;
        if (newState.finalHref && !newState.match && !newState.notFound) {
          redirectLogical = normalizeHref(newState.finalHref);
          const redirectPhysical = basePath + redirectLogical;
          window.history.replaceState(
            {
              ...getHistoryStateObject(),
              _furinKey: getHistoryKey(history.state) ?? generateHistoryKey(),
            },
            "",
            redirectPhysical
          );
          setCurrentHref(redirectLogical);
          const redirectState = await resolveRedirectState(redirectLogical, myVersion, navSignal);
          if (!redirectState) {
            if (navVersion.current === myVersion) {
              window.location.href = redirectPhysical;
            }
            return;
          }
          newState = redirectState;
        }

        currentMatchRef.current = newState.match;
        setState(newState);
        if (newState.title) {
          document.title = newState.title;
        }
        const effectiveLogical = newState.finalHref ?? redirectLogical ?? logicalHref;
        const physicalEffective = basePath + effectiveLogical;
        if (opts?.replace) {
          window.history.replaceState(
            {
              ...getHistoryStateObject(),
              _furinKey: getHistoryKey(history.state) ?? generateHistoryKey(),
            },
            "",
            physicalEffective
          );
        } else {
          const currentKey = getHistoryKey(history.state);
          if (currentKey) {
            saveScrollPosition(currentKey);
          }
          window.history.pushState({ _furinKey: generateHistoryKey() }, "", physicalEffective);
        }
        const effectiveUrl = new URL(physicalEffective, window.location.origin);
        const logicalPath = normalizeHref(toLogical(effectiveUrl.pathname, basePath));
        setCurrentHref(logicalPath + effectiveUrl.search);
        if (opts?.resetScroll ?? true) {
          pendingScrollRef.current = { href: physicalEffective, type: "reset" };
        }
      } finally {
        if (navVersion.current === myVersion) {
          setIsNavigating(false);
        }
      }
    },
    [basePath, fetchPageState, defaultPreloadStaleTime, prefetchCacheSize]
  );

  const [searchStore] = useState(() =>
    createSearchStore({
      currentHref,
      navigate,
      search: resolvedSearch,
      searchRoutes: routes,
    })
  );
  const searchSnapshot = useMemo(
    () => ({
      currentHref,
      navigate,
      search: resolvedSearch,
      searchRoutes: routes,
    }),
    [currentHref, navigate, resolvedSearch, routes]
  );

  useLayoutEffect(() => {
    searchStore.setSnapshot(searchSnapshot);
    searchStore.flush();
  }, [searchStore, searchSnapshot]);

  const refresh = useCallback(
    async (opts: { resetScroll?: boolean } | undefined) => {
      const logicalPath = toLogical(window.location.pathname, basePath);
      const logicalHref = logicalPath + window.location.search;
      invalidatePrefetch(logicalHref, "page");
      await navigate(logicalHref, { replace: true, resetScroll: opts?.resetScroll ?? false });
    },
    [navigate, invalidatePrefetch, basePath]
  );
  const invalidationRefresh = useMemo(
    () =>
      createInvalidationRefresh({
        onError: (error) => {
          log.warn({ action: "sync_refresh_failed", error: String(error) });
        },
        refresh: () => refresh(undefined),
      }),
    [refresh]
  );

  // Expose refresh() to the HMR handler in _hydrate.tsx so that after a hot
  // reload of a loader-bearing route the client re-fetches fresh data instead
  // of rendering with stale initialData from the initial SSR payload.
  useEffect(() => {
    if (typeof window !== "undefined") {
      // biome-ignore lint/suspicious/noExplicitAny: dev-only window hook
      (window as any).__FURIN_HMR_REFRESH__ = refresh;
      return () => {
        // biome-ignore lint/suspicious/noExplicitAny: dev-only window hook
        (window as any).__FURIN_HMR_REFRESH__ = undefined;
      };
    }
  }, [refresh]);

  const handlePopState = useCallback(() => {
    const destKey = getHistoryKey(history.state);
    const logicalPath = normalizeHref(toLogical(window.location.pathname, basePath));
    const logicalHref = logicalPath + window.location.search;
    navVersion.current += 1;
    const myVersion = navVersion.current;
    navAbortRef.current?.abort();
    const navAbort = new AbortController();
    navAbortRef.current = navAbort;
    const navSignal = navAbort.signal;
    setIsNavigating(true);

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: popstate handler — cache check, redirect follow, and scroll restoration require this depth
    (async () => {
      try {
        const cached = prefetchCache.current.get(logicalHref);
        let newState: RouterState | null;
        if (cached && !shouldRefetch(cached)) {
          newState = await cached.promise;
        } else {
          newState = await fetchPageState(logicalHref, navSignal);
        }
        if (navVersion.current !== myVersion) {
          return;
        }
        if (!newState) {
          log.warn({
            action: "popstate_fallback",
            href: logicalHref,
            reason: "fetchPageState_returned_null",
          });
          window.location.reload();
          return;
        }

        // Server-side redirect: replace history entry and load target
        let redirectLogical: string | undefined;
        if (newState.finalHref && !newState.match && !newState.notFound) {
          redirectLogical = normalizeHref(newState.finalHref);
          window.history.replaceState(history.state, "", basePath + redirectLogical);
          setCurrentHref(redirectLogical);
          const redirectState = await resolveRedirectState(redirectLogical, myVersion, navSignal);
          if (!redirectState) {
            if (navVersion.current === myVersion) {
              window.location.reload();
            }
            return;
          }
          newState = redirectState;
        }

        currentMatchRef.current = newState.match;
        setState(newState);
        if (newState.title) {
          document.title = newState.title;
        }
        const effectiveLogical = newState.finalHref ?? redirectLogical ?? logicalHref;
        if (newState.finalHref) {
          window.history.replaceState(history.state, "", basePath + effectiveLogical);
        }
        setCurrentHref(normalizeHref(effectiveLogical));
        if (destKey) {
          pendingScrollRef.current = { key: destKey, type: "restore" };
        } else {
          window.scrollTo({ behavior: "instant", top: 0 });
        }
      } finally {
        if (navVersion.current === myVersion) {
          setIsNavigating(false);
        }
      }
    })();
  }, [fetchPageState, basePath]);

  // Disable native scroll restoration and assign a key to the initial history entry.
  useEffect(() => {
    history.scrollRestoration = "manual";
    if (!getHistoryKey(history.state)) {
      history.replaceState({ ...getHistoryStateObject(), _furinKey: generateHistoryKey() }, "");
    }
  }, []);

  // Render-synchronous scroll restoration.
  useLayoutEffect(() => {
    const instruction = pendingScrollRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is null until navigation schedules scrolling
    if (!instruction) {
      return;
    }
    pendingScrollRef.current = null;

    if (instruction.type === "restore") {
      try {
        const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
        const positions: Record<string, number> = raw ? JSON.parse(raw) : {};
        const y = positions[instruction.key] ?? 0;
        window.scrollTo({ behavior: "instant", top: y });
      } catch {
        window.scrollTo({ behavior: "instant", top: 0 });
      }
      return;
    }

    const destUrl = new URL(instruction.href, window.location.origin);
    if (destUrl.hash) {
      const id = decodeHashFragment(destUrl.hash.slice(1));
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: "instant", block: "start" });
      }
    } else {
      window.scrollTo({ behavior: "instant", top: 0 });
    }
  }, [currentHref]);

  // Handle browser back/forward
  useEffect(() => {
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [handlePopState]);

  // Intercept clicks on native <a> tags so that internal links (including
  // those rendered by MDX, CMS content, or third-party components) participate
  // in SPA navigation instead of triggering full-page reloads.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) {
        return;
      }
      const anchor = (e.target as HTMLElement).closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      // Ignore Furin Link anchors — they handle their own navigation via
      // LinkInteractive.handleClick.
      if (anchor.closest("a[data-furin-link]")) {
        return;
      }
      const logicalHref = shouldInterceptClick(
        anchor,
        e,
        basePath,
        window.location.origin,
        window.location.pathname
      );
      if (logicalHref === null) {
        return;
      }
      // Don't capture a link that matches no local route: it may belong to a
      // sibling furin app mounted under a different basePath. Let the browser
      // navigate; the server routes it to the correct app.
      const logicalPathname = new URL(logicalHref, window.location.origin).pathname;
      const hasConcreteMatch = routes.some(
        (route) => !route.pattern.split("/").includes("*") && route.regex.test(logicalPathname)
      );
      if (!hasConcreteMatch) {
        return;
      }
      e.preventDefault();
      navigate(logicalHref, { resetScroll: !logicalHref.includes("#") });
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [navigate, basePath, routes]);

  // Intercept all window.fetch calls to auto-process X-Furin-Revalidate headers.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const originalFetch = window.fetch;
    const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const response = await originalFetch.apply(window, args);
      if (!isSameOriginFetchResult(args[0], response.url, window.location.origin)) {
        return response;
      }
      const invalidated: Array<{ path: string; type: "page" | "layout" }> = [];
      applyRevalidateHeader(response.headers, (path, type) => {
        const resolvedType = type ?? "page";
        invalidatePrefetch(path, resolvedType);
        invalidated.push({ path, type: resolvedType });
      });
      if (autoRefresh && invalidated.length > 0) {
        const currentLogicalPath =
          normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search;
        if (shouldAutoRefreshPath(currentLogicalPath, invalidated)) {
          // fire-and-forget: don't block the original fetch caller
          invalidationRefresh.run();
        }
      }
      return response;
    };
    // Copy static fetch methods so the patched value satisfies typeof fetch.
    Object.assign(wrapped, originalFetch);
    // biome-ignore lint/suspicious/noExplicitAny: Object.assign copies all static props but TS can't infer it
    window.fetch = wrapped as any;
    return () => {
      window.fetch = originalFetch;
    };
  }, [invalidatePrefetch, invalidationRefresh, autoRefresh, basePath]);

  // Listen for sync cursor notifications and recover changes over HTTP.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!syncStream || typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    const streamUrl = syncStream.startsWith("/")
      ? `${basePath}${syncStream}`
      : `${basePath}/${syncStream}`;
    let source: EventSource | undefined;
    let disposed = false;
    const applyInvalidations = (entries: readonly string[]) => {
      if (disposed) {
        return;
      }
      const invalidations: Array<{ path: string; type: "page" | "layout" }> = [];
      applyRevalidateEntries(entries, (path, type) => {
        const resolvedType = type ?? "page";
        invalidatePrefetch(path, resolvedType);
        invalidations.push({ path, type: resolvedType });
      });

      if (autoRefresh && invalidations.length > 0) {
        const currentLogicalPath =
          normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search;
        if (shouldAutoRefreshPath(currentLogicalPath, invalidations)) {
          invalidationRefresh.run();
        }
      }
    };
    const catchUp = createSyncCatchUp({
      fetchPage: async (after) => {
        const url = new URL(`${streamUrl}/changes`, window.location.origin);
        if (after !== undefined) {
          url.searchParams.set("after", after);
        }
        const response = await window.fetch(url);
        if (!response.ok) {
          throw new Error(`Sync catch-up failed with status ${response.status}`);
        }
        return (await response.json()) as SyncChangePagePayload;
      },
      onInvalidations: applyInvalidations,
    });
    const recover = () => {
      if (disposed) {
        return;
      }
      catchUp.catchUp().catch((error: unknown) => {
        if (!disposed) {
          log.warn({ action: "sync_catch_up_failed", error: String(error) });
        }
      });
    };
    const onOpen = () => recover();
    const onSync = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { cursor?: unknown };
        if (typeof payload.cursor !== "string") {
          throw new Error("Missing sync cursor");
        }
      } catch {
        log.warn({ action: "sync_invalid_event", event: "furin.sync" });
        return;
      }
      recover();
    };
    const connect = () => {
      if (disposed || source) {
        return;
      }
      source = new EventSource(streamUrl);
      source.addEventListener("open", onOpen);
      source.addEventListener("furin.sync", onSync);
    };

    catchUp
      .initialize()
      .then(() => {
        if (disposed) {
          return;
        }
        connect();
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        log.warn({ action: "sync_initialize_failed", error: String(error) });
        // Keep notifications alive; the next event recovers from cursor zero.
        connect();
      });
    return () => {
      disposed = true;
      source?.removeEventListener("open", onOpen);
      source?.removeEventListener("furin.sync", onSync);
      source?.close();
    };
  }, [syncStream, basePath, invalidatePrefetch, invalidationRefresh, autoRefresh]);

  let pageElement: React.ReactNode;
  if (state.notFound || !state.match) {
    pageElement = buildNotFoundPageElement(
      state.notFoundBoundaries ?? state.match?.segmentBoundaries ?? rootBoundaries,
      state.notFound ?? {}
    );
  } else {
    pageElement = buildPageElement(
      state.match,
      root,
      state.data,
      {
        onReset: () => {
          refresh(undefined).catch((err: unknown) => {
            log.error({ action: "boundary_reset_failed", error: String(err) });
          });
        },
        resetKey: currentHref,
      },
      state.error
    );
  }

  const routerTree = (
    <SearchStoreContext.Provider value={searchStore}>
      {buildRouterTree(
        {
          basePath,
          currentHref,
          defaultPreload,
          defaultPreloadDelay,
          defaultPreloadStaleTime,
          invalidatePrefetch,
          isNavigating,
          navigate,
          prefetch,
          refresh,
          search: resolvedSearch,
          searchRoutes: routes,
        },
        pageElement,
        {
          digest: initialDigest,
          document: initialDocumentState !== null,
          onReset: () => {
            refresh(undefined).catch((err: unknown) => {
              log.error({ action: "boundary_reset_failed", error: String(err) });
            });
          },
          resetKey: currentHref,
        }
      )}
    </SearchStoreContext.Provider>
  );
  if (initialDocumentState === null) {
    return routerTree;
  }
  return (
    <DocumentProvider
      value={{
        ...initialDocumentState,
        head: state.head ?? initialDocumentState.head,
      }}
    >
      {routerTree}
    </DocumentProvider>
  );
}
