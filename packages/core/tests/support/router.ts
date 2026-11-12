import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RuntimeData } from "../../src/client/internal/runtime-types.ts";
import {
  type ClientRoute,
  type LoadedClientRoute,
  type RouterContextValue,
  RouterProvider,
} from "../../src/client/link.tsx";

export function makeRouterContext(
  overrides: Partial<RouterContextValue> | undefined
): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    invalidatePrefetch: () => {
      /* noop */
    },
    isNavigating: false,
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
    search: {},
    searchRoutes: [],
    ...(overrides ?? {}),
  };
}

export async function dispatchReactEvent(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}

export async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export async function loadInitialMatch(route: ClientRoute): Promise<LoadedClientRoute> {
  const mod = await route.load();
  return {
    ...route,
    component: mod.default.component,
    pageRoute: mod.default._route,
  };
}

export interface RenderedRouter {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

export interface RenderRouterOptions {
  basePath: string;
  initialData: RuntimeData;
  initialMatch: LoadedClientRoute | null;
  routes: ClientRoute[];
  syncPath: string | undefined;
  /** Wraps the RouterProvider element, e.g. in a context provider. */
  wrap: ((router: ReactElement) => ReactElement) | undefined;
}

export async function renderRouter(options: RenderRouterOptions): Promise<RenderedRouter> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const router = createElement(RouterProvider, {
    autoRefresh: true,
    basePath: options.basePath,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    initialData: options.initialData,
    initialDigest: undefined,
    initialMatch: options.initialMatch,
    prefetchCacheSize: 50,
    root: null,
    routes: options.routes,
    syncPath: options.syncPath,
  });
  await act(async () => {
    root.render(options.wrap ? options.wrap(router) : router);
    await Promise.resolve();
  });

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    container,
    root,
  };
}

/** Points the window at `initialPath` and renders the router with the route matching it. */
export async function renderRouterAt(
  routes: ClientRoute[],
  initialPath: string | undefined,
  wrap: RenderRouterOptions["wrap"]
): Promise<RenderedRouter> {
  const path = initialPath ?? "/";
  window.location.href = `http://localhost:3000${path}`;
  window.history.replaceState(null, "", path);

  const rawMatch = routes.find((r) => r.regex.test(path));
  return await renderRouter({
    basePath: "",
    initialData: {},
    initialMatch: rawMatch ? await loadInitialMatch(rawMatch) : null,
    routes,
    syncPath: undefined,
    wrap,
  });
}
