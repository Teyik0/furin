// biome-ignore-all lint/performance/noAwaitInLoops: route discovery walks filesystem entries sequentially for deterministic ordering
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import {
  collectRouteChainFromRoute,
  mapWithConcurrency,
  validateRouteChain,
} from "../../shared/utils/index.ts";
import { type CompileContext, getCompileContext } from "../internal.ts";
import { IS_DEV } from "../runtime-env.ts";
import { adaptDefinedLayout, adaptDefinedPage, isDefinedRouteTerminal } from "./defined-route.ts";
import { filePathToPattern, resolveMode } from "./patterns.ts";
import type { ResolvedRoute, RootLayout, SegmentBoundary } from "./types.ts";

export function isModuleNotFoundError(err: unknown): boolean {
  if (!err || (typeof err !== "object" && typeof err !== "string")) {
    return false;
  }
  const msg =
    typeof err === "string"
      ? err.toLowerCase()
      : String((err as { message?: unknown }).message ?? "").toLowerCase();
  const code = typeof err === "string" ? undefined : (err as { code?: string }).code;
  return (
    code === "ENOENT" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    msg.includes("cannot find module") ||
    msg.includes("module not found") ||
    msg.includes("no such file or directory")
  );
}

/** @internal Exported for unit testing. */
export function collectRouteTags(
  routeChain: RuntimeRoute[],
  page: Pick<RuntimePage, "tags"> | undefined
): string[] | undefined {
  const tags = new Set<string>();
  for (const route of routeChain) {
    for (const tag of route.tags ?? []) {
      tags.add(tag);
    }
  }
  for (const tag of page?.tags ?? []) {
    tags.add(tag);
  }
  return tags.size > 0 ? [...tags] : undefined;
}

export function loadProdRoutes(ctx: CompileContext): {
  root: RootLayout;
  routes: ResolvedRoute[];
} {
  const rootMod = ctx.modules[ctx.rootPath] as Record<string, unknown>;
  const rootExport = rootMod.route;
  if (!isDefinedRouteTerminal(rootExport) || typeof rootExport.layout !== "function") {
    throw new Error("[furin] root.tsx: defineRoute().layout() not found in CompileContext.");
  }
  const rootRoute = adaptDefinedLayout(rootExport, undefined, ctx.rootPath);

  function resolveModuleComponent<T>(modPath: string | undefined): T | undefined {
    if (!modPath) {
      return;
    }
    const mod = ctx.modules[modPath] as { default?: T } | undefined;
    return mod?.default;
  }

  const root: RootLayout = {
    error: resolveModuleComponent(ctx.rootConventions?.errorPath),
    notFound: resolveModuleComponent(ctx.rootConventions?.notFoundPath),
    path: ctx.rootPath,
    route: rootRoute,
  };

  const routes: ResolvedRoute[] = [];
  for (const { pattern, path, mode } of ctx.routes) {
    const pageMod = ctx.modules[path] as { route?: unknown };
    const page = resolveCompiledRuntimePage(pageMod, path, root, ctx);
    if (!page) {
      throw new Error(`[furin] ${path}: invalid page module in CompileContext.`);
    }
    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
    validateRouteChain(routeChain, root.route, path);
    const meta = ctx.routeMetadata?.[path];
    const boundaries = (meta?.segmentBoundaries ?? []).map((b) => ({
      ...b,
      error: resolveModuleComponent(b.errorPath),
      notFound: resolveModuleComponent(b.notFoundPath),
    })) as SegmentBoundary[];

    const error = boundaries.findLast((b) => b.error)?.error;
    const notFound = boundaries.findLast((b) => b.notFound)?.notFound;

    // Note: In production we store only the nearest segment-level convention
    // (error / notFound) and do NOT fall back to root.error / root.notFound here.
    // The dev-mode resolveNearestConvention() does include the root fallback,
    // and the render layer applies the runtime fallback (route.error ?? root.error)
    // when building the React element tree. This asymmetry is intentional:
    // loadProdRoutes records the static wiring so buildElement can place React
    // boundaries at the correct nesting depth, while the runtime fallback ensures
    // every route always has a safety-net component even if no boundary was
    // declared at any segment level.

    routes.push({
      error,
      mode,
      notFound,
      page,
      path,
      pattern,
      routeChain,
      segmentBoundaries: boundaries,
      tags: collectRouteTags(routeChain, page),
    });
  }

  return { root, routes };
}

function resolveCompiledRuntimePage(
  module: { route?: unknown },
  path: string,
  root: RootLayout,
  context: CompileContext
): RuntimePage | undefined {
  if (!isDefinedRouteTerminal(module.route) || typeof module.route.page !== "function") {
    return;
  }
  const pagesDir = root.path.slice(0, root.path.lastIndexOf("/"));
  const parent = resolveCompiledLayoutParent(path, pagesDir, root.route, context);
  return adaptDefinedPage(module.route, parent);
}

function resolveCompiledLayoutParent(
  pagePath: string,
  pagesDir: string,
  rootRoute: RuntimeRoute,
  context: CompileContext
): RuntimeRoute {
  const pageDirectory = pagePath.slice(0, pagePath.lastIndexOf("/"));
  if (pageDirectory.length <= pagesDir.length) {
    return rootRoute;
  }
  const segments = pageDirectory.slice(pagesDir.length + 1).split("/");
  let directory = pagesDir;
  let parent = rootRoute;

  for (const segment of segments) {
    directory = `${directory}/${segment}`;
    for (const candidate of getSourceModuleCandidates(directory, "_route")) {
      const layoutModule = context.modules[candidate] as { route?: unknown } | undefined;
      if (!layoutModule) {
        continue;
      }
      const layout = layoutModule.route;
      if (isDefinedRouteTerminal(layout) && typeof layout.layout === "function") {
        parent = adaptDefinedLayout(layout, parent, candidate);
      }
      break;
    }
  }

  return parent;
}

/**
 * Normalises OS-native path separators to POSIX "/" so the slash-based path
 * arithmetic in the scan (relative slicing, `lastIndexOf("/")`,
 * `${pagesDir}/...`) works on Windows, where `node:path` join/resolve emit
 * backslashes. `existsSync` and dynamic `import()` both accept forward slashes
 * on Windows, so the normalised form is safe for filesystem and module access.
 */
function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function routeRelativePath(pagesDir: string, absolutePath: string): string {
  const dir = toPosixPath(pagesDir).replace(/\/+$/g, "");
  const path = toPosixPath(absolutePath);
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

export async function scanPages(pagesDir: string): Promise<{
  root: RootLayout;
  routes: ResolvedRoute[];
}> {
  // Normalise once at the entry point; scanRootLayout and scanPageFiles (plus
  // every absolute path collectPageFilePaths yields) then operate purely on
  // POSIX-separated paths.
  const dir = toPosixPath(pagesDir);
  const root = await scanRootLayout(dir);
  const routes = await scanPageFiles(dir, root);
  return { root, routes };
}

export async function scanRootLayout(pagesDir: string): Promise<RootLayout> {
  const rootPath = `${pagesDir}/root.tsx`;
  const ctx = getCompileContext();
  if (!(existsSync(rootPath) || ctx?.modules[rootPath])) {
    throw new Error("[furin] root.tsx: not found.");
  }

  const mod = (ctx?.modules[rootPath] ?? (await import(rootPath))) as Record<string, unknown>;
  const rootExport = mod.route;
  if (!isDefinedRouteTerminal(rootExport)) {
    throw new Error("[furin] root.tsx: defineRoute() export not found.");
  }

  if (!rootExport.layout) {
    throw new Error("[furin] root.tsx: defineRoute() has no layout.");
  }
  const rootRoute = adaptDefinedLayout(rootExport, undefined, rootPath);

  const [notFoundEntry, errorEntry] = await Promise.all([
    loadConventionComponent<NotFoundComponent>(pagesDir, "not-found"),
    loadConventionComponent<ErrorComponent>(pagesDir, "error"),
  ]);
  return {
    error: errorEntry?.component,
    errorPath: errorEntry?.path,
    notFound: notFoundEntry?.component,
    notFoundPath: notFoundEntry?.path,
    path: rootPath,
    route: rootRoute,
  };
}

const CONVENTION_FILE_NAMES = ["not-found", "error"] as const;
const SOURCE_MODULE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;
const DYNAMIC_ROUTE_SEGMENT_RE = /(^|\/):[^/]+/g;

function routePatternKey(pattern: string): string {
  return pattern.replace(DYNAMIC_ROUTE_SEGMENT_RE, "$1:param");
}

function isConventionFileName(name: string): boolean {
  return (CONVENTION_FILE_NAMES as readonly string[]).includes(name);
}

export function getSourceModuleCandidates(dir: string, name: string): string[] {
  return SOURCE_MODULE_EXTENSIONS.map((ext) => `${dir}/${name}${ext}`);
}

/**
 * Result of a convention-file lookup. The `path` is the absolute module path
 * — callers that only care about the component discard it, but the hydrate
 * emission pipeline needs it to generate static `import` statements.
 */
interface ConventionLookup<T> {
  component: T;
  path: string;
}

async function loadConventionComponent<T>(
  dir: string,
  name: string
): Promise<ConventionLookup<T> | undefined> {
  const ctx = getCompileContext();
  for (const filePath of getSourceModuleCandidates(dir, name)) {
    if (existsSync(filePath) || ctx?.modules[filePath]) {
      const moduleSpecifier =
        IS_DEV && existsSync(filePath)
          ? `${filePath}?furin-server&t=${Math.trunc(statSync(filePath).mtimeMs * 1000)}`
          : filePath;
      const mod = (ctx?.modules[filePath] ?? (await import(moduleSpecifier))) as {
        default?: T;
      };
      if (mod.default) {
        return { component: mod.default, path: filePath };
      }
    }
  }
}

async function scanPageFiles(pagesDir: string, root: RootLayout): Promise<ResolvedRoute[]> {
  const routes: ResolvedRoute[] = [];
  const seenPatterns = new Map<string, string>();
  const notFoundCache = new Map<string, ConventionLookup<NotFoundComponent> | undefined>();
  const errorCache = new Map<string, ConventionLookup<ErrorComponent> | undefined>();

  for (const absolutePath of await collectPageFilePaths(pagesDir)) {
    if (
      !(SOURCE_MODULE_EXTENSIONS as readonly string[]).some((ext) => absolutePath.endsWith(ext))
    ) {
      continue;
    }

    const relativePath = routeRelativePath(pagesDir, absolutePath);
    const fileName = parse(relativePath).name;

    // Skip root.tsx, convention files (not-found, error), and files starting with _
    if (fileName.startsWith("_") || fileName === "root" || isConventionFileName(fileName)) {
      continue;
    }

    const pattern = filePathToPattern(relativePath);
    const patternKey = routePatternKey(pattern);
    const previousPath = seenPatterns.get(patternKey);
    if (previousPath !== undefined) {
      throw new Error(
        `[furin] Duplicate route pattern "${patternKey}" from "${previousPath}" and "${relativePath}".`
      );
    }
    seenPatterns.set(patternKey, relativePath);

    const [notFound, errorComponent, segmentBoundaries] = await Promise.all([
      resolveNearestConvention<NotFoundComponent>(
        absolutePath,
        pagesDir,
        "not-found",
        notFoundCache,
        root.notFound
      ),
      resolveNearestConvention<ErrorComponent>(
        absolutePath,
        pagesDir,
        "error",
        errorCache,
        root.error
      ),
      collectSegmentBoundaries(absolutePath, pagesDir, notFoundCache, errorCache),
    ]);

    if (IS_DEV) {
      const devRoute = await buildDevRoute(absolutePath, relativePath, pattern, root, pagesDir);
      devRoute.notFound = notFound;
      devRoute.error = errorComponent;
      devRoute.segmentBoundaries = segmentBoundaries;
      routes.push(devRoute);
      continue;
    }

    const ctx = getCompileContext();
    const pageMod = (ctx?.modules[absolutePath] ?? (await import(absolutePath))) as {
      route?: unknown;
    };
    const page = await resolveRuntimePage(pageMod, absolutePath, pagesDir, root.route);
    if (!page) {
      throw new Error(`[furin] ${relativePath}: no valid defineRoute().page() export found`);
    }

    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);

    validateRouteChain(routeChain, root.route, relativePath);

    routes.push({
      error: errorComponent,
      mode: resolveMode(page, routeChain),
      notFound,
      page,
      path: absolutePath,
      pattern,
      routeChain,
      segmentBoundaries,
      tags: collectRouteTags(routeChain, page),
    });
  }

  return routes;
}

async function resolveRuntimePage(
  module: { route?: unknown },
  absolutePath: string,
  pagesDir: string,
  rootRoute: RuntimeRoute
): Promise<RuntimePage | undefined> {
  if (!isDefinedRouteTerminal(module.route) || typeof module.route.page !== "function") {
    return;
  }
  const parent = await resolveDefinedLayoutParent(absolutePath, pagesDir, rootRoute);
  return adaptDefinedPage(module.route, parent);
}

async function resolveDefinedLayoutParent(
  pagePath: string,
  pagesDir: string,
  rootRoute: RuntimeRoute
): Promise<RuntimeRoute> {
  const pageDirectory = pagePath.slice(0, pagePath.lastIndexOf("/"));
  if (pageDirectory.length <= pagesDir.length) {
    return rootRoute;
  }
  const relativeDirectory = pageDirectory.slice(pagesDir.length + 1);
  const segments = relativeDirectory.split("/");
  let directory = pagesDir;
  let parent = rootRoute;

  for (const segment of segments) {
    directory = `${directory}/${segment}`;
    for (const candidate of getSourceModuleCandidates(directory, "_route")) {
      if (!existsSync(candidate)) {
        continue;
      }
      const layoutModule = (await import(candidate)) as { route?: unknown };
      const layout = layoutModule.route;
      if (isDefinedRouteTerminal(layout) && typeof layout.layout === "function") {
        parent = adaptDefinedLayout(layout, parent, candidate);
      }
      break;
    }
  }

  return parent;
}

/**
 * Walks every directory from `pagesDir` down to the directory containing
 * `pageAbsolutePath` and records the OWN (not inherited) error.tsx /
 * not-found.tsx declared there. Directories without any convention file are
 * omitted so consumers can treat each entry as "a place where the user
 * authored a boundary on purpose".
 *
 * Uses the shared per-directory caches so sibling pages don't re-import the
 * same convention modules.
 */
async function collectSegmentBoundaries(
  pageAbsolutePath: string,
  pagesDir: string,
  notFoundCache: Map<string, ConventionLookup<NotFoundComponent> | undefined>,
  errorCache: Map<string, ConventionLookup<ErrorComponent> | undefined>
): Promise<SegmentBoundary[]> {
  const pageDir = pageAbsolutePath.slice(0, pageAbsolutePath.lastIndexOf("/"));

  // Accumulate directories from shallow → deep starting at pagesDir.
  const dirs: string[] = [pagesDir];
  if (pageDir.length > pagesDir.length) {
    const relativeTail = pageDir.slice(pagesDir.length + 1); // skip leading "/"
    const parts = relativeTail.split("/");
    let acc = pagesDir;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      dirs.push(acc);
    }
  }

  const boundaries: SegmentBoundary[] = [];
  for (let depth = 0; depth < dirs.length; depth += 1) {
    const dir = dirs[depth] as string;

    const [errorEntry, notFoundEntry] = await Promise.all([
      errorCache.has(dir)
        ? Promise.resolve(errorCache.get(dir))
        : loadConventionComponent<ErrorComponent>(dir, "error").then((r) => {
            errorCache.set(dir, r);
            return r;
          }),
      notFoundCache.has(dir)
        ? Promise.resolve(notFoundCache.get(dir))
        : loadConventionComponent<NotFoundComponent>(dir, "not-found").then((r) => {
            notFoundCache.set(dir, r);
            return r;
          }),
    ]);
    if (errorEntry || notFoundEntry) {
      boundaries.push({
        depth,
        error: errorEntry?.component,
        errorPath: errorEntry?.path,
        notFound: notFoundEntry?.component,
        notFoundPath: notFoundEntry?.path,
        path: dir,
      });
    }
  }

  return boundaries;
}

async function resolveNearestConvention<T>(
  pageAbsolutePath: string,
  pagesDir: string,
  conventionName: string,
  cache: Map<string, ConventionLookup<T> | undefined>,
  rootFallback: T | undefined
): Promise<T | undefined> {
  // Walk from the page's directory up to pagesDir looking for the convention file.
  // Cached per directory so repeated scans for sibling pages don't re-import.
  let dir = pageAbsolutePath.slice(0, pageAbsolutePath.lastIndexOf("/"));
  while (dir.length >= pagesDir.length) {
    if (!cache.has(dir)) {
      cache.set(dir, await loadConventionComponent<T>(dir, conventionName));
    }
    const found = cache.get(dir);
    if (found) {
      return found.component;
    }
    if (dir === pagesDir) {
      break;
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return rootFallback;
}

async function buildDevRoute(
  absolutePath: string,
  relativePath: string,
  pattern: string,
  root: RootLayout,
  pagesDir: string
): Promise<ResolvedRoute> {
  // Import via the virtual namespace (registerDevPagePlugin must be called first)
  // so page files stay out of --hot's module graph. We still extract the route
  // chain at startup for type generation, guards, and mode resolution — matching
  // prod behavior exactly.
  let page: RuntimePage | undefined;
  let routeChain: RuntimeRoute[] = [];

  try {
    const pageMod = (await import(`${absolutePath}?furin-server&t=${Date.now()}`)) as {
      route?: unknown;
    };
    const resolvedPage = await resolveRuntimePage(pageMod, absolutePath, pagesDir, root.route);
    if (resolvedPage) {
      page = resolvedPage;
      routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
      validateRouteChain(routeChain, root.route, relativePath);
    }
  } catch {
    // The dev renderer retries the named terminal on the first request.
  }

  // Dev stub: never rendered; the dev renderer re-imports from disk.
  const devStubPage: RuntimePage = {
    __type: "FURIN_PAGE",
    _route: { __type: "FURIN_ROUTE" },
    component: () => null,
  };

  return {
    mode: page ? resolveMode(page, routeChain) : "ssr",
    // Still lazily re-imported on each request for fresh code.
    page: page ?? devStubPage,
    path: absolutePath,
    pattern,
    routeChain,
    // scanPageFiles() overwrites this with the real chain before the route
    // is pushed — present here to satisfy the ResolvedRoute required shape.
    segmentBoundaries: [],
    tags: collectRouteTags(routeChain, page),
  };
}

/**
 * Per-level cap on parallel directory traversals. Bounds peak in-flight
 * `readdir` calls to roughly `DIR_SCAN_CONCURRENCY * tree-depth`, which keeps
 * a wide flat pagesDir from opening thousands of FDs at once.
 */
const DIR_SCAN_CONCURRENCY = 8;

async function collectPageFilePaths(dir: string): Promise<string[]> {
  const files: string[] = [];

  // Sort by name so route order is reproducible across platforms / restarts.
  // readdir is hash-based on Linux ext4, alphabetical on macOS APFS — without
  // this sort, two pages that compile to the same URL pattern would resolve
  // non-deterministically depending on host. Sorting also makes the eventual
  // "duplicate route pattern" error reproducible (always the same winner).
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  // Walk subdirectories with bounded parallelism, then merge results in the
  // original alphabetical entry order so the depth-first interleaving is
  // preserved (file, then its sub-tree, then next file…).
  const resolved = await mapWithConcurrency(entries, DIR_SCAN_CONCURRENCY, async (entry) => {
    const absolutePath = toPosixPath(join(dir, entry.name));
    if (entry.isDirectory()) {
      return await collectPageFilePaths(absolutePath);
    }
    if (entry.isFile()) {
      return [absolutePath];
    }
    return [];
  });
  for (const chunk of resolved) {
    files.push(...chunk);
  }

  return files;
}
