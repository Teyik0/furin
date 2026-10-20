// biome-ignore-all lint/performance/noAwaitInLoops: prerendering runs routes sequentially for deterministic output
import type { SsgCacheEntry } from "./cache/index.ts";
import { allInstances, type FurinInstance, withInstance } from "./instance.ts";
import { hasRequestLoader } from "./render/request-loaders.ts";
import { prerenderSSG } from "./render/ssg.ts";
import { expandStaticPaths, hasStaticParams } from "./render/static-params.ts";
import { buildRouteMatcher, resolveDocumentMode } from "./router/patterns.ts";
import { createSearchRouteMetadata } from "./router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "./router/types.ts";

// Build-time prerendering runs inside the production bundle, so pages render
// with exactly the code, plugins and configuration that will serve them.

const PRERENDER_ORIGIN = "http://localhost";

export interface SsgSnapshot {
  [path: string]: SsgCacheEntry;
}

/** A URL whose public document is known at build time. */
interface PrerenderPath {
  path: string;
  pattern: string;
}

/** What one mounted app knows and renders at build time. */
export interface AppPrerender {
  paths: PrerenderPath[];
  prefix: string;
  /** SSG documents Furin serves from memory; empty when the platform caches pages. */
  ssg: SsgSnapshot;
}

interface PrerenderSource {
  root: RootLayout;
  routes: ResolvedRoute[];
}

const sources = new WeakMap<FurinInstance, PrerenderSource>();

/** Makes a production runtime's routes available to the build's prerender pass. */
export function registerPrerenderSource(instance: FurinInstance, source: PrerenderSource): void {
  sources.set(instance, source);
}

function hasRequestDependentInput(route: ResolvedRoute, root: RootLayout): boolean {
  return [root.route, ...route.routeChain].some((routeConfig) => routeConfig.query !== undefined);
}

/**
 * Every SSG/ISR URL known at build time: fixed routes plus the values returned
 * by staticParams(). Routes with a query schema stay on-demand.
 */
async function listPrerenderPaths(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<PrerenderPath[]> {
  const paths: PrerenderPath[] = [];
  const matchRoute = buildRouteMatcher(routes);
  for (const route of routes) {
    if (resolveDocumentMode(route) === "ssr" || hasRequestDependentInput(route, root)) {
      continue;
    }
    for (const { path } of (await expandStaticPaths(route, matchRoute, origin)) ?? []) {
      paths.push({ path, pattern: route.pattern });
    }
  }
  return paths;
}

/** Renders the staticParams() documents of SSG routes without request loaders. */
export async function renderSsgSnapshot(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<SsgSnapshot> {
  const snapshot: SsgSnapshot = {};
  const searchRoutes = createSearchRouteMetadata(routes);
  const matchRoute = buildRouteMatcher(routes);

  for (const route of routes) {
    if (
      resolveDocumentMode(route) !== "ssg" ||
      !hasStaticParams(route) ||
      hasRequestLoader(route)
    ) {
      continue;
    }
    const paths = await expandStaticPaths(route, matchRoute, origin);
    for (const { params, path } of paths ?? []) {
      const result = await prerenderSSG(route, params, root, origin, undefined, searchRoutes);
      if (!(result instanceof Response)) {
        snapshot[path] = result;
      }
    }
  }
  return snapshot;
}

/**
 * Collects the build-time prerender output of every production runtime in
 * this process. `render` is false when the platform caches public pages.
 */
export async function collectPrerenders(render: boolean): Promise<AppPrerender[]> {
  const prerenders: AppPrerender[] = [];
  for (const instance of allInstances()) {
    const source = sources.get(instance);
    if (source === undefined) {
      continue;
    }
    const { root, routes } = source;
    prerenders.push(
      await withInstance(instance, async () => ({
        paths: await listPrerenderPaths(routes, root, PRERENDER_ORIGIN),
        prefix: instance.prefix,
        ssg: render ? await renderSsgSnapshot(routes, root, PRERENDER_ORIGIN) : {},
      }))
    );
  }
  return prerenders;
}
