import { log } from "evlog";
import type React from "react";
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type DeferredQueryValue, projectDeferredQueryData } from "../../shared/query-bindings.ts";
import type { SearchParamsInput } from "../../shared/search-params.ts";
import { type QuerySeed, queryTag } from "../../shared/sync-query.ts";
import { collectRouteChainFromRoute } from "../../shared/utils/index.ts";
import { subscribeBrowserEvent } from "../browser-events.ts";
import { DocumentProvider, useDocumentState } from "../document.tsx";
import { wrapLoaderLayouts } from "../loader-layouts.tsx";
import { QueryStoreContext } from "../query.tsx";
import { QueryStore } from "../query-store.ts";
import { buildPageElement, buildRouterTree } from "./boundary-tree.tsx";
import { observeWindowFetch } from "./fetch-observers.ts";
import { SCROLL_STORAGE_KEY } from "./history.ts";
import { registerHmrRefresh } from "./hmr-refresh.ts";
import {
  applyRevalidateEntries,
  applyRevalidateHeader,
  decodeHashFragment,
  isSameOriginFetchResult,
  normalizeHref,
  shouldAutoRefreshPath,
  shouldInterceptClick,
  toLogical,
} from "./link-utils.ts";
import {
  NavigationController,
  type NavigationControllerConfig,
  type NavigationSnapshot,
} from "./navigation-controller.ts";
import { createOptimisticRuntime, registerOptimisticRuntime, SYNC_REQUEST } from "./optimistic.ts";
import { fetchPageState } from "./page-fetch.ts";
import { createSearchStore, SearchStoreContext } from "./search-store.ts";
import {
  buildErrorPageElement,
  buildNotFoundPageElement,
  detectStaticMode,
} from "./spa-response.ts";
import {
  createInvalidationRefresh,
  createSyncCatchUp,
  type SyncChangePagePayload,
} from "./sync-catch-up.ts";
import type {
  ClientRoute,
  ClientSegmentBoundary,
  RouterProviderProps,
  RouterState,
} from "./types.ts";

const EMPTY_SEARCH: SearchParamsInput = {};

interface HmrTransactionState {
  dataInvalidated: boolean;
}

/**
 * Root-owned boundary for the "no client route matched" 404 path. When an
 * unknown URL is navigated to, the server's `renderRootNotFound` handles it —
 * the root `not-found.tsx` (depth 0) is the correct component to render inline
 * instead of doing a full-page reload.
 */
function findRootBoundaries(routes: ClientRoute[]): ClientSegmentBoundary[] | undefined {
  for (const route of routes) {
    const depth0 = route.segmentBoundaries?.find((b) => b.depth === 0 && b.isRoot !== false);
    if (depth0) {
      return [depth0];
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the router coordinates success, legacy fallbacks and scoped loader fallbacks in one render.
export function RouterProvider({
  routes,
  root,
  initialMatch,
  initialData,
  initialDigest,
  initialError,
  initialNotFound,
  autoRefresh,
  basePath,
  defaultPreload,
  defaultPreloadDelay,
  defaultPreloadStaleTime,
  prefetchCacheSize,
  syncPath,
}: RouterProviderProps): React.ReactElement {
  const initialDocumentState = useDocumentState();
  const [queries] = useState(() => {
    const store = new QueryStore(
      typeof window === "undefined" ? undefined : window.location.origin
    );
    store.hydrate(
      (initialData.__furinQueries as QuerySeed[] | undefined) ?? [],
      typeof window === "undefined" ? undefined : window.location.origin
    );
    return store;
  });
  // Initial snapshot. When `initialMatch` is `null`, `initialNotFound` MUST be
  // set — the provider boots into the inline not-found UI.
  const [initialSnapshot] = useState<NavigationSnapshot>(() => ({
    // The LOGICAL path (basePath stripped) so Link active-state detection works
    // with route patterns that never include the basePath prefix.
    href:
      typeof window === "undefined"
        ? "/"
        : normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search,
    isNavigating: false,
    resetVersion: 0,
    state: {
      data: Object.fromEntries(
        Object.entries(initialData).filter(([key]) => key !== "__furinQueries")
      ),
      querySeeds: initialData.__furinQueries as QuerySeed[] | undefined,
      hydrateQueries: queries.captureHydration(),
      error: initialError
        ? {
            ...initialError,
            message: initialError.message || "Something went wrong",
          }
        : undefined,
      head: initialDocumentState?.head,
      match: initialMatch,
      notFound: initialNotFound,
    },
  }));
  const optimisticSnapshot = useRef({
    href: initialSnapshot.href,
    loaded: initialSnapshot.state.match !== null,
    pattern: initialSnapshot.state.match?.pattern,
  });
  const syncResponse = useRef<
    ((response: Response | undefined, optimistic: boolean) => void) | undefined
  >(undefined);
  const [optimisticRuntime] = useState(() =>
    createOptimisticRuntime({
      basePath,
      queries,
      snapshot: () => optimisticSnapshot.current,
      onResponse: (response, optimistic) => syncResponse.current?.(response, optimistic),
    })
  );
  /**
   * Cached at boot from `<meta name="furin-mode">`. Drives the SPA-nav data
   * fetch URL: runtime `/_furin/data` for SSR/ISR/dev, per-route
   * `__furin_data.ndjson` for static exports.
   */
  const [staticMode] = useState(detectStaticMode);
  const rootBoundaries = useMemo(() => findRootBoundaries(routes), [routes]);
  const navigationConfig = useMemo<NavigationControllerConfig>(
    () => ({
      basePath,
      defaultStaleTime: defaultPreloadStaleTime,
      fetchPage: ({ currentMatch, hmrRefresh, href, signal }) =>
        fetchPageState(
          {
            basePath,
            captureHydration: () => queries.captureHydration(),
            currentMatch,
            rootBoundaries,
            routes,
            staticMode,
          },
          href,
          signal,
          hmrRefresh
        ),
      maxCacheSize: prefetchCacheSize,
    }),
    [
      basePath,
      defaultPreloadStaleTime,
      prefetchCacheSize,
      queries,
      rootBoundaries,
      routes,
      staticMode,
    ]
  );
  const [controller] = useState(
    () =>
      new NavigationController({
        config: navigationConfig,
        initial: initialSnapshot,
        optimistic: optimisticRuntime,
      })
  );
  useLayoutEffect(() => {
    controller.configure(navigationConfig);
  }, [controller, navigationConfig]);
  const navigation = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const { href: currentHref, isNavigating, resetVersion: boundaryResetVersion, state } = navigation;
  const { navigate, refresh, invalidatePath: invalidatePrefetch } = controller;
  const prefetch = useCallback(
    (href: string, opts: { staleTime?: number } | undefined) => {
      controller.prefetch(href, opts?.staleTime);
    },
    [controller]
  );

  useLayoutEffect(() => {
    state.hydrateQueries?.(
      state.querySeeds ?? [],
      typeof window === "undefined" ? undefined : window.location.origin
    );
  }, [state.hydrateQueries, state.querySeeds]);
  const resolvedQueries = useRef(new WeakMap<Promise<unknown>, DeferredQueryValue>());
  const [deferredRevision, setDeferredRevision] = useState(0);
  useEffect(() => {
    const hydrated = new Set(state.querySeeds?.map((seed) => seed.url));
    let disposed = false;
    for (const promise of Object.values(state.data)) {
      if (!(promise instanceof Promise)) {
        continue;
      }
      promise.then(
        (value: unknown) => {
          if (disposed) {
            return;
          }
          resolvedQueries.current.set(promise, { value });
          const seeds = (state.querySeeds ?? []).filter((seed) => !hydrated.has(seed.url));
          state.hydrateQueries?.(seeds, window.location.origin);
          for (const seed of seeds) {
            hydrated.add(seed.url);
          }
          setDeferredRevision((revision) => revision + 1);
        },
        () => undefined
      );
    }
    return () => {
      disposed = true;
    };
  }, [state.data, state.querySeeds, state.hydrateQueries]);
  useLayoutEffect(() => {
    optimisticSnapshot.current = {
      href: currentHref,
      loaded: state.match !== null && !(state.error || state.notFound),
      pattern: state.match?.pattern,
    };
  }, [currentHref, state.match, state.error, state.notFound]);
  useSyncExternalStore(optimisticRuntime.subscribe, optimisticRuntime.revision, () => 0);
  const queryRevision = useSyncExternalStore(queries.subscribeAll, queries.revision, () => 0);
  useEffect(() => registerOptimisticRuntime(optimisticRuntime), [optimisticRuntime]);
  /** Monotonic counter that supersedes only HMR transactions, not user navigation. */
  const hmrVersion = useRef(0);
  const hmrState = useRef<HmrTransactionState>({ dataInvalidated: false });
  const resolvedSearch = (state.data.query as SearchParamsInput | undefined) ?? EMPTY_SEARCH;

  const [searchStore] = useState(() =>
    createSearchStore({
      currentHref,
      currentPattern: state.match?.pattern,
      navigate,
      search: resolvedSearch,
      searchRoutes: routes,
    })
  );
  const searchSnapshot = useMemo(
    () => ({
      currentHref,
      currentPattern: state.match?.pattern,
      navigate,
      search: resolvedSearch,
      searchRoutes: routes,
    }),
    [currentHref, state.match?.pattern, navigate, resolvedSearch, routes]
  );

  useLayoutEffect(() => {
    searchStore.setSnapshot(searchSnapshot);
    searchStore.flush();
  }, [searchStore, searchSnapshot]);

  const invalidationRefresh = useMemo(
    () =>
      createInvalidationRefresh({
        onError: (error) => {
          log.warn({ action: "sync_refresh_failed", error: String(error) });
        },
        refresh: async () => {
          await controller.waitForUserNavigation();
          await controller.refresh(undefined);
        },
      }),
    [controller]
  );

  useLayoutEffect(() => {
    syncResponse.current = (response, optimistic) => {
      const invalidated: Array<{ path: string; type: "page" | "layout" }> = [];
      if (
        response &&
        (response.url === "" || new URL(response.url).origin === window.location.origin)
      ) {
        applyRevalidateHeader(response.headers, (path, type) => {
          const resolvedType = type ?? "page";
          invalidatePrefetch(path, resolvedType);
          invalidated.push({ path, type: resolvedType });
        });
      }
      if (
        optimistic ||
        (autoRefresh && shouldAutoRefreshPath(optimisticSnapshot.current.href, invalidated))
      ) {
        invalidationRefresh.run();
      }
    };
    return () => {
      syncResponse.current = undefined;
    };
  }, [autoRefresh, invalidatePrefetch, invalidationRefresh]);

  // Expose a transactional refresh to the HMR handler in _hydrate.tsx. The
  // callback swaps the hot component only after fresh data is ready and just
  // before the controller publishes the complete router snapshot.
  // Production builds define NODE_ENV, so the whole registration is compiled out.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      return registerHmrRefresh(async (beforeCommit, dataChanged) => {
        hmrVersion.current += 1;
        const myHmrVersion = hmrVersion.current;
        const shouldRefreshData = hmrState.current.dataInvalidated || dataChanged !== false;
        if (!shouldRefreshData) {
          beforeCommit?.();
          controller.rerender();
          return;
        }
        hmrState.current.dataInvalidated = true;
        await controller.waitForUserNavigation();
        if (hmrVersion.current !== myHmrVersion) {
          return;
        }
        let didCommit = false;
        await controller.refresh({
          beforeCommit: () => {
            didCommit = true;
            beforeCommit?.();
          },
          hmrRefresh: true,
          shouldCommit: () => hmrVersion.current === myHmrVersion,
        });
        if (didCommit && hmrVersion.current === myHmrVersion) {
          hmrState.current.dataInvalidated = false;
        }
      });
    }
  }, [controller]);

  // Disable native scroll restoration and assign a key to the initial history entry.
  useEffect(() => {
    controller.adoptHistoryEntry();
  }, [controller]);

  // Render-synchronous scroll restoration, after every committed snapshot.
  useLayoutEffect(() => {
    const instruction = controller.takeScrollInstruction();
    if (!instruction) {
      return;
    }

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
  }, [controller, navigation]);

  // Handle browser back/forward
  useEffect(() => {
    window.addEventListener("popstate", controller.popState);
    return () => window.removeEventListener("popstate", controller.popState);
  }, [controller]);

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
      navigate(logicalHref, undefined);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [navigate, basePath, routes]);

  // Intercept all window.fetch calls to auto-process X-Furin-Revalidate headers.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    return observeWindowFetch((args, response) => {
      if (args[1] && SYNC_REQUEST in args[1]) {
        return;
      }
      if (!isSameOriginFetchResult(args[0], response.url, window.location.origin)) {
        return;
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
    });
  }, [invalidatePrefetch, invalidationRefresh, autoRefresh, basePath]);

  // Listen for sync cursor notifications and recover changes over HTTP.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!syncPath || typeof window === "undefined") {
      return;
    }

    const changesUrl = syncPath.startsWith("/")
      ? `${basePath}${syncPath}`
      : `${basePath}/${syncPath}`;
    let unsubscribe: (() => void) | undefined;
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
        const url = new URL(`${changesUrl}/changes`, window.location.origin);
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
      onReset: () => queries.invalidateAll(),
      onQueries: (identities) => {
        queries.invalidate(identities);
        const tags = new Set(identities.map(queryTag));
        const affected = (snapshot: RouterState) =>
          snapshot.querySeeds?.some((seed) => tags.has(queryTag(seed.identity))) === true;
        controller.invalidateQueries(affected);
        if (autoRefresh && affected(controller.getSnapshot().state)) {
          invalidationRefresh.run();
        }
      },
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
    const onSync = (event: { data: { cursor: string } }) => {
      if (typeof event.data.cursor !== "string") {
        log.warn({ action: "sync_invalid_event", event: "browser-events.sync" });
        return;
      }
      catchUp.seed(event.data.cursor);
      recover();
    };
    const connect = () => {
      if (disposed || unsubscribe) {
        return;
      }
      unsubscribe = subscribeBrowserEvent("sync", onSync);
      if (!unsubscribe) {
        log.warn({ action: "sync_transport_unavailable" });
      }
    };

    connect();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    syncPath,
    basePath,
    invalidatePrefetch,
    invalidationRefresh,
    autoRefresh,
    queries,
    controller,
  ]);

  const queryData = useMemo(
    () =>
      projectDeferredQueryData(
        state.data,
        state.querySeeds ?? [],
        (seed) => {
          if (seed.local && typeof window !== "undefined") {
            const original = new URL(seed.url);
            return queries.snapshot(
              new URL(original.pathname + original.search, window.location.origin).href
            ).data;
          }
          return queries.snapshot(seed.url).data;
        },
        resolvedQueries.current
      ),
    [queries, state.data, state.querySeeds, queryRevision, deferredRevision]
  );
  const renderedData = optimisticRuntime.project(queryData, currentHref);
  let pageElement: React.ReactNode;
  const hasLoaderLayouts = renderedData.__furinLayouts !== undefined;
  if (state.notFound || !state.match || (state.error && hasLoaderLayouts)) {
    const boundaries = state.notFoundBoundaries ?? state.match?.segmentBoundaries ?? rootBoundaries;
    const fallback = state.error
      ? buildErrorPageElement(boundaries, state.error, () => {
          refresh(undefined).catch((error: unknown) =>
            log.error({ action: "boundary_reset_failed", error: String(error) })
          );
        })
      : buildNotFoundPageElement(boundaries, state.notFound ?? {});
    if (hasLoaderLayouts) {
      let chain = root ? [root] : [];
      if (state.match) {
        chain = collectRouteChainFromRoute(state.match.pageRoute);
      }
      pageElement = wrapLoaderLayouts(fallback, chain, renderedData);
    } else {
      pageElement = root?.layout
        ? createElement(root.layout as React.ElementType, renderedData, fallback)
        : fallback;
    }
  } else {
    pageElement = buildPageElement(
      state.match,
      root,
      renderedData,
      {
        onReset: () => {
          refresh(undefined).catch((err: unknown) => {
            log.error({ action: "boundary_reset_failed", error: String(err) });
          });
        },
        resetKey: `${currentHref}:${boundaryResetVersion}`,
      },
      state.error
    );
  }

  const routerContext = useMemo(
    () => ({
      basePath,
      currentHref,
      currentPattern: state.match?.pattern,
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
    }),
    [
      basePath,
      currentHref,
      state.match?.pattern,
      defaultPreload,
      defaultPreloadDelay,
      defaultPreloadStaleTime,
      invalidatePrefetch,
      isNavigating,
      navigate,
      prefetch,
      refresh,
      resolvedSearch,
      routes,
    ]
  );
  const routerTree = (
    <SearchStoreContext.Provider value={searchStore}>
      {buildRouterTree(routerContext, pageElement, {
        digest: initialDigest,
        document: initialDocumentState !== null,
        onReset: () => {
          refresh(undefined).catch((err: unknown) => {
            log.error({ action: "boundary_reset_failed", error: String(err) });
          });
        },
        resetKey: `${currentHref}:${boundaryResetVersion}`,
      })}
    </SearchStoreContext.Provider>
  );
  if (initialDocumentState === null) {
    return <QueryStoreContext.Provider value={queries}>{routerTree}</QueryStoreContext.Provider>;
  }
  return (
    <DocumentProvider
      value={{
        ...initialDocumentState,
        head: state.head,
      }}
    >
      <QueryStoreContext.Provider value={queries}>{routerTree}</QueryStoreContext.Provider>
    </DocumentProvider>
  );
}
