// biome-ignore-all lint/performance/noAwaitInLoops: HMR polling and invalidation are intentionally sequential
import { existsSync, statSync } from "node:fs";
import type { Context } from "elysia";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { collectRouteChainFromRoute } from "../../shared/utils/index.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  type DevLoaderCacheEntry,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  isDevLoaderCacheValid,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "../cache/dev-loader.ts";
import { pathWithRequestSearch } from "../cache/route-cache.ts";
import { type CompileContext, getCompileContext } from "../internal.ts";
import { resolvePath } from "../render/assemble.ts";
import { type LoaderResult, runLoaders } from "../render/loaders.ts";
import { renderSSR } from "../render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage, isDefinedRouteTerminal } from "./defined-route.ts";
import { collectRouteTags, getSourceModuleCandidates, isModuleNotFoundError } from "./discovery.ts";
import { collectIntermediateLayoutDirs, resolveMode } from "./patterns.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

type RouteModuleImport = (specifier: string) => Promise<Record<string, unknown>>;

interface DevRouteModuleCacheEntry {
  module: Promise<Record<string, unknown>>;
  stamp: string;
}

const routeModuleImport: RouteModuleImport = (specifier) =>
  import(specifier) as Promise<Record<string, unknown>>;
const runtimeDevRouteModuleCache = new Map<string, DevRouteModuleCacheEntry>();
const devRouteModuleCaches = new WeakMap<
  RouteModuleImport,
  Map<string, DevRouteModuleCacheEntry>
>();

function routeModuleSourceStamp(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.mtimeNs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

/**
 * Reuses one virtual ESM module per source version. A timestamp generated on
 * every request leaks module-registry entries because Bun cannot release old
 * module identities; the source stamp preserves HMR freshness without
 * request-proportional growth. Promise caching also deduplicates concurrent
 * requests for the same edited version.
 */
export async function importStampedRouteModule(
  path: string,
  resolveImport: RouteModuleImport
): Promise<Record<string, unknown>> {
  let cache = runtimeDevRouteModuleCache;
  if (resolveImport !== routeModuleImport) {
    const resolverCache = devRouteModuleCaches.get(resolveImport);
    if (resolverCache) {
      cache = resolverCache;
    } else {
      cache = new Map();
      devRouteModuleCaches.set(resolveImport, cache);
    }
  }
  const stamp = routeModuleSourceStamp(path);
  const cached = cache.get(path);
  if (cached?.stamp === stamp) {
    return cached.module;
  }

  const entry: DevRouteModuleCacheEntry = {
    module: resolveImport(`${path}?furin-server&t=${Bun.hash(stamp).toString()}`),
    stamp,
  };
  cache.set(path, entry);
  try {
    return await entry.module;
  } catch (error) {
    if (cache.get(path) === entry) {
      cache.delete(path);
    }
    throw error;
  }
}

export function invalidateStampedRouteModules(): void {
  runtimeDevRouteModuleCache.clear();
}

function isResolvedRouteModuleCandidate(
  layoutPath: string,
  imported: Record<string, unknown>,
  ctx: CompileContext | null
): boolean {
  if (existsSync(layoutPath) || ctx?.modules[layoutPath]) {
    return true;
  }

  return Object.keys(imported).length > 0;
}

export async function importFreshRouteModuleCandidate(
  layoutPath: string,
  resolveImport: RouteModuleImport,
  ctx: CompileContext | null
): Promise<Record<string, unknown> | undefined> {
  if (
    resolveImport === routeModuleImport &&
    !(existsSync(layoutPath) || ctx?.modules[layoutPath])
  ) {
    return;
  }
  try {
    const imported = await importStampedRouteModule(layoutPath, resolveImport);
    if (!isResolvedRouteModuleCandidate(layoutPath, imported, ctx)) {
      return;
    }

    return imported;
  } catch (err) {
    // Distinguish "this layout file does not exist" (legitimate skip) from
    // "this layout file's transitive imports failed" (real bug to surface).
    // If the layoutPath itself is on disk or registered in the compile ctx,
    // a ModuleNotFoundError must come from a sub-import — re-throw it so
    // the developer sees the actual broken import instead of a silently
    // ignored layout chain.
    const layoutFileIsKnown = existsSync(layoutPath) || Boolean(ctx?.modules[layoutPath]);
    if (!layoutFileIsKnown && isModuleNotFoundError(err)) {
      return;
    }
    throw err;
  }
}

async function importFreshLayoutRouteModule(
  layoutDir: string,
  resolveImport: RouteModuleImport,
  ctx: CompileContext | null
): Promise<Record<string, unknown> | undefined> {
  for (const layoutPath of getSourceModuleCandidates(layoutDir, "_route")) {
    const freshMod = await importFreshRouteModuleCandidate(layoutPath, resolveImport, ctx);
    if (freshMod) {
      return freshMod;
    }
  }
}

function patchRouteEntryFromFreshModule(
  entry: RuntimeRoute | undefined,
  freshMod: Record<string, unknown>
): void {
  const freshRoute = freshMod.route;
  if (!(entry && freshRoute)) {
    return;
  }

  if (isDefinedRouteTerminal(freshRoute) && typeof freshRoute.layout === "function") {
    const adapted = adaptDefinedLayout(freshRoute, entry.parent);
    entry.layout = adapted.layout;
    entry.loader = adapted.loader;
    entry.mode = adapted.mode;
    entry.params = adapted.params;
    entry.query = adapted.query;
    entry.requestLoader = adapted.requestLoader;
    entry.revalidate = adapted.revalidate;
    entry.tags = adapted.tags;
  }
}

/**
 * Re-imports edited intermediate layout _route.tsx files with a versioned
 * module identity, then patches the layout/loader references on the existing
 * route-chain objects.
 *
 * The optional `importFn` parameter exists only for unit testing. In production
 * it defaults to the real `import()`.
 */
export async function refreshLayoutChain(
  chain: RuntimeRoute[],
  pagePath: string,
  rootPath: string,
  importFn: ((specifier: string) => Promise<Record<string, unknown>>) | undefined
): Promise<void> {
  const resolveImport = importFn ?? routeModuleImport;
  const ctx = getCompileContext();
  const layoutDirs = collectIntermediateLayoutDirs(pagePath, rootPath);

  // Track chainIdx independently rather than deriving it from layoutPaths
  // index. Directories without a _route module produce import errors that are
  // silently skipped, but those directories have no corresponding chain entry —
  // so we must only advance chainIdx for directories whose _route module actually
  // exists. A positional assumption (i = chainIdx - 1) drifts whenever
  // isModuleNotFoundError is swallowed for a gap directory.
  //
  // Imports are parallelised for speed; patching stays sequential so the
  // chainIdx-to-layoutDir positional mapping remains deterministic.
  const freshMods = await Promise.all(
    layoutDirs.map((layoutDir) => importFreshLayoutRouteModule(layoutDir, resolveImport, ctx))
  );
  let chainIdx = 1; // chain[0] is the root
  for (const freshMod of freshMods) {
    if (chainIdx >= chain.length) {
      break;
    }
    if (!freshMod) {
      // No _route module in this directory — no chain entry to match, so
      // do NOT advance chainIdx. The next deeper layoutDir may correspond
      // to the current chainIdx.
      continue;
    }

    patchRouteEntryFromFreshModule(chain[chainIdx], freshMod);
    // An _route module exists at this depth — advance chainIdx regardless of
    // whether the export is currently a valid route (the chain entry was
    // populated by the initial import and should be revisited on the next
    // successful HMR cycle).
    chainIdx += 1;
  }
}

/**
 * Rebuilds a `ResolvedRoute` from freshly-imported `page` and `chain` so that
 * `mode` reflects the CURRENT contents of the page module — not the value
 * captured at scan time.
 *
 * In dev, `handleDevRequest` resolves the current versioned page module on
 * every request. Without this
 * function the spread `{ ...route, page, chain }` would carry over the stale
 * `route.mode` resolved at startup, so toggling `revalidate` or removing a
 * loader in source would not retake effect until a server restart.
 *
 * Only `mode` is recomputed: it is the only field DERIVED from page+chain.
 * Structural fields (`pattern`, `path`, `segmentBoundaries`, `error`,
 * `notFound`) are scan-time invariants in dev and are preserved as-is.
 */
export function rebuildDevRoute(
  base: ResolvedRoute,
  page: RuntimePage,
  chain: RuntimeRoute[]
): ResolvedRoute {
  return {
    ...base,
    mode: resolveMode(page, chain),
    page,
    routeChain: chain,
    tags: collectRouteTags(chain, page),
  };
}

/** @internal Handles a request in dev mode using the current source-version modules. */
export async function handleDevRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes?: SearchRouteMetadata[]
): Promise<unknown> {
  // Load the page via ?furin-server virtual namespace so it stays out of
  // --hot's file watcher, then hand off to renderSSR which runs loaders,
  // renders React to HTML, and injects __FURIN_DATA__.
  try {
    let currentRoot = root;
    const rootMod = await importStampedRouteModule(root.path, routeModuleImport);
    const rootExport = rootMod.route;
    if (isDefinedRouteTerminal(rootExport) && typeof rootExport.layout === "function") {
      // Preserve the RootLayout-level convention fields (error, notFound,
      // errorPath, notFoundPath) populated by `scanRootLayout` from
      // `pages/error.tsx` and `pages/not-found.tsx`.  Replacing the whole
      // RootLayout with just `{ path, route }` would silently drop these
      // fallbacks — `route.error ?? root.error` would resolve to `undefined`
      // in dev after the first request, making custom 404/500 screens
      // disappear after a HMR refresh.
      currentRoot = {
        ...currentRoot,
        route: adaptDefinedLayout(rootExport, undefined, root.path),
      };
    }

    const pageMod = await importStampedRouteModule(route.path, routeModuleImport);
    let page: RuntimePage | undefined;
    let chain: RuntimeRoute[] | undefined;
    if (isDefinedRouteTerminal(pageMod.route) && typeof pageMod.route.page === "function") {
      const currentChain = route.routeChain;
      await refreshLayoutChain(currentChain, route.path, root.path, undefined);
      const parent = currentChain.at(-2) ?? currentRoot.route;
      const adaptedPage = adaptDefinedPage(pageMod.route, parent);
      page = adaptedPage;
      chain = collectRouteChainFromRoute(adaptedPage._route);
    }
    if (page && chain) {
      // Patch chain[0] (the root) with the freshly-imported root's loader
      // and layout.  `refreshLayoutChain` deliberately starts at chainIdx=1
      // because the root is already loaded separately above; without this
      // patch, chain[0] points to whatever object `_route.parent` captured
      // at _route's first evaluation — a STALE reference if Bun --hot
      // re-evaluated root.tsx without propagating the re-evaluation to
      // _route.tsx (the standard ESM behaviour).  Mirroring the pattern
      // used by patchRouteEntryFromFreshModule.
      if (chain[0] && currentRoot.route) {
        chain[0].layout = currentRoot.route.layout;
        chain[0].loader = currentRoot.route.loader;
      }

      const refreshedRoute = rebuildDevRoute(route, page, chain);

      // Live ISR — the loader chain is short-circuited by the dev cache when
      // a fresh entry exists.  HTML re-assembles every time so the dev shell
      // chunk URL is always current.
      if (refreshedRoute.mode === "isr") {
        return renderDevISRWithLoaderCache(refreshedRoute, ctx, currentRoot, searchRoutes);
      }

      // Live SSG — same trick as Live ISR, but the cache entry is forever-fresh
      // (revalidate: Infinity) so the loader runs ONCE per cache key until a
      // source file in its dependency chain changes.  This matches production
      // SSG semantics ("loader runs once") in dev, instead of re-running the
      // loader on every refresh — which would make expensive loaders (DB
      // queries, MDX parsing, sitemap reads) painful in dev.
      if (refreshedRoute.mode === "ssg") {
        return renderDevSSGWithLoaderCache(refreshedRoute, ctx, currentRoot, searchRoutes);
      }

      return renderSSR(refreshedRoute, ctx, currentRoot, undefined, searchRoutes);
    }
  } catch (err) {
    console.error(`[furin] Dev page load error for ${route.path}:`, err);
  }
  // Fallback: page couldn't load — return a clear error response rather than
  // delegating to renderSSR with an undefined page.
  return new Response(
    `<!doctype html><html><body><h1>Page load error</h1><p>Could not load ${route.path}. Check the server console for details.</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 500 }
  );
}

/**
 * @internal Dev "Live ISR" — caches loader output, not assembled HTML.  On a
 * fresh cache hit the loader chain is skipped; the React render still runs so
 * the response embeds the latest dev shell (chunk URL, HMR runtime, …).  On
 * miss, runs loaders normally and stores the merged data record.
 */
export async function renderDevISRWithLoaderCache(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response> {
  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});
  const cacheKey = `${root.path}:${pathWithRequestSearch(resolvedPath, ctx.request.url)}`;
  const cached = getDevISRLoaderCache(cacheKey);

  if (cached && isDevLoaderCacheValid(cached)) {
    const precomputed: LoaderResult = {
      deferredPromises: undefined,
      headers: cached.headers,
      syncData: cached.loaderData,
      type: "data",
    };
    return renderSSR(route, ctx, root, precomputed, searchRoutes);
  }

  const result = await runLoaders(route, ctx);
  if (result.type === "data") {
    const revalidate = route.page._route.revalidate ?? 60;
    const entry: DevLoaderCacheEntry = {
      dependencies: computeRouteDependencies(route.path, root.path),
      generatedAt: Date.now(),
      headers: result.headers,
      loaderData: result.syncData,
      mode: "isr",
      revalidate,
    };
    setDevISRLoaderCache(cacheKey, entry);
    autoInvalidateRegistry.registerLoaderTags(
      pathWithRequestSearch(resolvedPath, ctx.request.url),
      route.tags
    );
  }
  return renderSSR(route, ctx, root, result, searchRoutes);
}

/**
 * @internal Dev "Live SSG" — same shape as `renderDevISRWithLoaderCache`, but
 * the cached entry is tagged forever-fresh (`revalidate: Infinity`) so it
 * survives indefinitely until source-aware invalidation drops it.  This makes
 * dev SSG behave like production SSG: the loader runs ONCE per cache key,
 * not on every refresh.
 */
export async function renderDevSSGWithLoaderCache(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response> {
  const cacheKey = `${root.path}:${resolvePath(route.pattern, ctx.params ?? {})}`;
  const cached = getDevSSGLoaderCache(cacheKey);

  if (cached && isDevLoaderCacheValid(cached)) {
    const precomputed: LoaderResult = {
      deferredPromises: undefined,
      headers: cached.headers,
      syncData: cached.loaderData,
      type: "data",
    };
    return renderSSR(route, ctx, root, precomputed, searchRoutes);
  }

  const result = await runLoaders(route, ctx);
  if (result.type === "data") {
    const entry: DevLoaderCacheEntry = {
      dependencies: computeRouteDependencies(route.path, root.path),
      generatedAt: Date.now(),
      headers: result.headers,
      loaderData: result.syncData,
      mode: "ssg",
      // SSG entries are forever-fresh — only source-aware invalidation drops them.
      revalidate: Number.POSITIVE_INFINITY,
    };
    setDevSSGLoaderCache(cacheKey, entry);
    autoInvalidateRegistry.registerLoaderTags(
      resolvePath(route.pattern, ctx.params ?? {}),
      route.tags
    );
  }
  return renderSSR(route, ctx, root, result, searchRoutes);
}

/**
 * @internal Lists every source file whose contents can affect the render
 * output for a given page: the page itself, every intermediate `_route.*`
 * between the page and the pages root, and `root.tsx`.
 *
 * Only paths that EXIST on disk are returned.  `isDevLoaderCacheValid` treats
 * a `statSync` throw as "invalid" (conservative on missing files), so listing
 * non-authored extension candidates here would force a permanent cache MISS
 * for every nested route — silently disabling the dev ISR/SSG cache for any
 * page in a subdirectory.  Renames and deletions of TRACKED deps are still
 * detected: the path that previously existed will then `statSync`-throw on
 * the next read and yield the same conservative miss.
 */
export function computeRouteDependencies(pagePath: string, rootPath: string): string[] {
  const deps = [pagePath, rootPath];
  for (const dir of collectIntermediateLayoutDirs(pagePath, rootPath)) {
    for (const candidate of getSourceModuleCandidates(dir, "_route")) {
      if (existsSync(candidate)) {
        deps.push(candidate);
      }
    }
  }
  return deps;
}
