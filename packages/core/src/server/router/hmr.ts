// biome-ignore-all lint/performance/noAwaitInLoops: HMR polling and invalidation are intentionally sequential
import { existsSync } from "node:fs";
import type { Context } from "elysia";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
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
import { canonicalCacheRequest } from "../cache/route-cache.ts";
import { getLogger } from "../context-logger.ts";
import { devDiagnosticStore, publishDevDiagnostic } from "../dev/diagnostics.ts";
import { devGraph } from "../dev/graph.ts";
import { renderDevDiagnosticResponse } from "../dev/plugin.ts";
import { DevTransformFailure } from "../dev/transform-failure.ts";
import { currentInstance } from "../instance.ts";
import { type CompileContext, type CompiledModule, getCompileContext } from "../internal.ts";
import { resolvePath } from "../render/assemble.ts";
import {
  hasMixedLoaderModes,
  hasRequestLoader,
  type LoaderResult,
  runLoaders,
  runMixedLoaders,
  runPublicLoaders,
  withRequestLoaderData,
} from "../render/loaders.ts";
import { adaptDefinedLayout, adaptDefinedPage, isDefinedRouteTerminal } from "./defined-route.ts";
import {
  annotateScannedRequestKeys,
  collectRouteTags,
  getSourceModuleCandidates,
  isModuleNotFoundError,
} from "./discovery.ts";
import type { CurrentRoute, PagePorts } from "./dispatch.ts";
import { collectIntermediateLayoutDirs, resolveMode, resolveRouteRevalidate } from "./patterns.ts";
import { createRouteDataErrorResponse } from "./plugin.ts";
import { invalidateRouteModuleSourceVersions, routeModuleSourceVersion } from "./source-version.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

type RouteModuleImport = (specifier: string) => Promise<CompiledModule>;
const requestKeyCache = new Map<
  string,
  { keys: string[]; keysByLoader: string[][]; version: string }
>();

const routeModuleImport: RouteModuleImport = (specifier) =>
  import(specifier) as Promise<CompiledModule>;

class DevPhaseFailure extends Error {
  readonly error: unknown;
  readonly phase: "loader" | "render";

  constructor(error: unknown, phase: "loader" | "render", options: ErrorOptions) {
    super(`Development ${phase} phase failed`, options);
    this.error = error;
    this.phase = phase;
  }
}

async function runDevLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  let result: LoaderResult;
  try {
    if (hasMixedLoaderModes(route)) {
      result = await runMixedLoaders(route, ctx);
    } else if (route.mode === "ssr") {
      result = await runLoaders(route, ctx);
    } else {
      result = await runPublicLoaders(route, ctx);
    }
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the custom error forwards this value through ErrorOptions.cause.
    throw new DevPhaseFailure(error, "loader", { cause: error });
  }
  if (result.type === "error") {
    if (result.error instanceof Response) {
      throw new DevPhaseFailure(
        new Error(result.message, {
          cause: `${result.error.status} ${result.error.statusText}`,
        }),
        "loader",
        { cause: result.error }
      );
    }
    throw new DevPhaseFailure(result.error, "loader", { cause: result.error });
  }
  return result;
}

/** The page with its render module, loaded once its loaders returned data. */
async function loadDevRenderRoute(route: ResolvedRoute): Promise<ResolvedRoute> {
  const loadRender = Reflect.get(route.page.component, Symbol.for("furin.dev.render"));
  if (typeof loadRender !== "function") {
    return route;
  }
  const rendered = (await loadRender()) as { default: RuntimePage["component"] };
  return { ...route, page: { ...route.page, component: rendered.default } };
}

function devFailure(error: unknown): {
  error: unknown;
  phase: "import" | "loader" | "render" | "transform";
} {
  if (error instanceof DevPhaseFailure) {
    return { error: error.error, phase: error.phase };
  }
  if (error instanceof DevTransformFailure) {
    return { error: error.error, phase: "transform" };
  }
  return { error, phase: "import" };
}

function reportDevRouteFailure(error: unknown, route: ResolvedRoute): void {
  const failure = devFailure(error);
  publishDevDiagnostic(failure.error, {
    entryPath: route.path,
    phase: failure.phase,
    route: route.pattern,
  });
}

/** Answers a failed page document with the diagnostic overlay. */
function devFailureResponse(
  route: ResolvedRoute,
  error: unknown,
  failure: ReturnType<typeof devFailure>
): Response {
  console.error(`[furin] Dev page load error for ${route.path}:`, error);
  const event = publishDevDiagnostic(failure.error, {
    entryPath: route.path,
    phase: failure.phase,
    route: route.pattern,
  });
  return renderDevDiagnosticResponse(event, currentInstance().prefix);
}

/**
 * Reuses one virtual ESM module per source version. A timestamp generated on
 * every request leaks module-registry entries because Bun cannot release old
 * module identities; the source stamp preserves HMR freshness without
 * request-proportional growth. Promise caching also deduplicates concurrent
 * requests for the same edited version.
 */
export function importStampedRouteModule(
  path: string,
  resolveImport: RouteModuleImport
): Promise<CompiledModule> {
  const stamp = routeModuleSourceVersion(path);
  return devGraph(undefined).importModule(path, stamp, resolveImport);
}

export function invalidateStampedRouteModules(): void {
  invalidateRouteModuleSourceVersions();
}

function isResolvedRouteModuleCandidate(
  layoutPath: string,
  imported: CompiledModule,
  ctx: CompileContext | null
): boolean {
  if (existsSync(layoutPath) || ctx?.modules[layoutPath]) {
    return true;
  }

  return Object.keys(imported).length > 0;
}

async function importFreshRouteModuleCandidate(
  layoutPath: string,
  resolveImport: RouteModuleImport,
  ctx: CompileContext | null
): Promise<CompiledModule | undefined> {
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
): Promise<CompiledModule | undefined> {
  for (const layoutPath of getSourceModuleCandidates(layoutDir, "_route")) {
    const freshMod = await importFreshRouteModuleCandidate(layoutPath, resolveImport, ctx);
    if (freshMod) {
      return freshMod;
    }
  }
}

function patchRouteEntryFromFreshModule(
  entry: RuntimeRoute | undefined,
  freshMod: CompiledModule
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
    entry.staticParams = adapted.staticParams;
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
  importFn: ((specifier: string) => Promise<CompiledModule>) | undefined
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
 * In dev, `resolveCurrentDevRoute` resolves the current versioned page module on
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

/** Resolve the current source-version modules for both HTML and data requests. */
export async function resolveCurrentDevRoute(
  route: ResolvedRoute,
  root: RootLayout
): Promise<{ route: ResolvedRoute; root: RootLayout }> {
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
      chain[0].requestLoader = currentRoot.route.requestLoader;
      chain[0].staticParams = currentRoot.route.staticParams;
    }

    const refreshed = rebuildDevRoute(route, page, chain);
    if (chain.some((entry) => entry.requestLoader)) {
      const version = chain
        .map((entry) => {
          const path = entry.sourcePath ?? route.path;
          return `${path}:${routeModuleSourceVersion(path)}`;
        })
        .join("|");
      const cached = requestKeyCache.get(route.path);
      if (cached?.version === version) {
        refreshed.requestKeys = cached.keys;
        refreshed.requestKeysByLoader = cached.keysByLoader;
      } else {
        await annotateScannedRequestKeys([refreshed]);
        requestKeyCache.set(route.path, {
          keys: refreshed.requestKeys ?? [],
          keysByLoader: refreshed.requestKeysByLoader ?? [],
          version,
        });
      }
    }
    return { root: currentRoot, route: refreshed };
  }
  const invalidExport = new Error(
    `${route.path} must provide a valid Furin page export: \`export const route = defineRoute().config({ layout, mode }).page(...)\``
  );
  Reflect.set(invalidExport, "furinPosition", {
    column: 1,
    file: route.path,
    line: 1,
  });
  throw new DevTransformFailure(invalidExport, { cause: invalidExport });
}

const devLoaderCaches = {
  isr: {
    get: getDevISRLoaderCache,
    set: setDevISRLoaderCache,
    source: "render:dev-isr-loader",
  },
  ssg: {
    get: getDevSSGLoaderCache,
    set: setDevSSGLoaderCache,
    source: "render:dev-ssg-loader",
  },
} as const;

/**
 * @internal Dev "Live ISR/SSG" — caches loader output, not assembled HTML.  On
 * a fresh cache hit the loader chain is skipped; the React render still runs
 * so the response embeds the latest dev shell (chunk URL, HMR runtime, …).  On
 * miss, runs loaders normally and stores the merged data record.
 *
 * ISR entries are keyed by path + declared query and expire after
 * `revalidate`.  SSG entries are keyed by path and tagged forever-fresh
 * (`revalidate: Infinity`) so they survive until source-aware invalidation
 * drops them — the loader runs ONCE per cache key, like production SSG, not on
 * every refresh.
 */
async function loadCachedDevLoaderData(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  mode: "isr" | "ssg"
): Promise<LoaderResult> {
  const cache = devLoaderCaches[mode];
  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});
  // ISR loader output is keyed, and computed, on the declared query only.
  const { cacheKey: cachePath, ctx: loaderCtx } =
    mode === "isr"
      ? canonicalCacheRequest(route, resolvedPath, ctx)
      : { cacheKey: resolvedPath, ctx };
  const cacheKey = `${root.path}:${cachePath}`;
  const cached = cache.get(cacheKey);

  if (cached && isDevLoaderCacheValid(cached)) {
    const precomputed: LoaderResult = {
      deferredPromises: undefined,
      headers: cached.headers,
      syncData: cached.loaderData,
      type: "data",
    };
    return hasRequestLoader(route) ? withRequestLoaderData(route, ctx, precomputed) : precomputed;
  }

  const result = await runDevLoaders(route, loaderCtx);
  if (result.type === "data") {
    const entry: DevLoaderCacheEntry = {
      dependencies: computeRouteDependencies(route.path, root.path),
      generatedAt: Date.now(),
      headers: result.headers,
      loaderData: result.syncData,
      mode,
      revalidate:
        mode === "isr" ? (resolveRouteRevalidate(route.page) ?? 60) : Number.POSITIVE_INFINITY,
    };
    cache.set(cacheKey, entry);
    autoInvalidateRegistry.registerLoaderTags(cachePath, route.tags, cache.source);
  }
  return result.type === "data" && hasRequestLoader(route)
    ? withRequestLoaderData(route, ctx, result)
    : result;
}

/**
 * Development's page ports. The route table is a live snapshot whose shell
 * has no schemas, so edited schemas take effect; modules are imported at
 * their current source version, and failures answer with the diagnostic
 * overlay. Documents always render live, because their HTML embeds the Bun
 * HMR client of the current client build; only loader output is cached.
 */
export const developmentPagePorts: PagePorts = {
  cache: {
    loaders: ({ root, route }, ctx) =>
      !hasMixedLoaderModes(route) && (route.mode === "isr" || route.mode === "ssg")
        ? loadCachedDevLoaderData(route, ctx, root, route.mode)
        : runDevLoaders(route, ctx),
    pages: false,
  },
  modules: {
    data: async (route, root, serve) => {
      let current: CurrentRoute;
      try {
        current = await resolveCurrentDevRoute(route, root);
      } catch (error) {
        getLogger().error(error instanceof Error ? error : new Error(String(error)));
        reportDevRouteFailure(error, route);
        return createRouteDataErrorResponse(
          error,
          "Something went wrong",
          500,
          undefined,
          undefined,
          undefined
        );
      }
      return serve(current);
    },
    document: async (route, root, serve) => {
      let current: CurrentRoute;
      try {
        current = await resolveCurrentDevRoute(route, root);
      } catch (error) {
        return devFailureResponse(route, error, devFailure(error));
      }
      try {
        const response = await serve(current);
        devDiagnosticStore().markReady(route.pattern);
        return response;
      } catch (error) {
        return devFailureResponse(
          route,
          error,
          error instanceof DevPhaseFailure
            ? { error: error.error, phase: error.phase }
            : { error, phase: "render" }
        );
      }
    },
    render: loadDevRenderRoute,
  },
  routes: {
    // The mounted Elysia route can outlive its source file.
    has: (route) => existsSync(route.path),
    validatesParams: false,
  },
};

/**
 * @internal Lists every source file whose contents can affect the render
 * output for a given page: the page itself, every intermediate `_route.*`
 * between the page and the pages root, `root.tsx`, and their local imports.
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
  const graph = devGraph(undefined);
  return [...new Set(deps.flatMap((path) => graph.sourceDependencies(path)))].filter(existsSync);
}
