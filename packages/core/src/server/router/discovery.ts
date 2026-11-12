// biome-ignore-all lint/performance/noAwaitInLoops: route discovery walks filesystem entries sequentially for deterministic ordering
import { existsSync } from "node:fs";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import {
  type ManifestBoundary,
  type ManifestRoute,
  type RouteInstanceSpec,
  type RouteManifest,
  type RouteStyle,
  scanRouteManifest,
} from "../../plugin/route-manifest.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import { collectRouteChainFromRoute, validateRouteChain } from "../../shared/utils/index.ts";
import { isDevelopment } from "../instance.ts";
import { type CompileContext, type CompiledModule, getCompileContext } from "../internal.ts";
import { adaptDefinedLayout, adaptDefinedPage, isDefinedRouteTerminal } from "./defined-route.ts";
import { resolveMode } from "./patterns.ts";
import { routeModuleSourceVersion } from "./source-version.ts";
import type { ResolvedLayout, ResolvedRoute, RootLayout, SegmentBoundary } from "./types.ts";

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

export async function annotateScannedRequestKeys(routes: ResolvedRoute[]): Promise<void> {
  // Build and dev have source files; production routes receive serialized keys
  // from CompileContext and never load the TypeScript compiler.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const moduleUrl = new URL(`../../build/request-keys.${extension}`, import.meta.url).href;
  const compiler = (await import(moduleUrl)) as typeof import("../../build/request-keys.ts");
  await compiler.annotateRequestLoaderKeys(routes);
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
  const rootExport = ctx.modules[ctx.rootPath]?.route;
  if (!isDefinedRouteTerminal(rootExport) || typeof rootExport.layout !== "function") {
    throw new Error(
      `[furin] ${ctx.rootPath}: defineRootRoute().layout() not found in CompileContext.`
    );
  }
  const rootRoute = adaptDefinedLayout(rootExport, undefined, ctx.rootPath);

  function resolveModuleComponent<T>(modPath: string | undefined): T | undefined {
    if (!modPath) {
      return;
    }
    return ctx.modules[modPath]?.default as T | undefined;
  }

  const root: RootLayout = {
    error: rootRoute.errorComponent ?? resolveModuleComponent(ctx.rootConventions?.errorPath),
    notFound:
      rootRoute.notFoundComponent ?? resolveModuleComponent(ctx.rootConventions?.notFoundPath),
    path: ctx.rootPath,
    route: rootRoute,
  };

  const routes: ResolvedRoute[] = [];
  for (const { pattern, path, mode } of ctx.routes) {
    const meta = ctx.routeMetadata?.[path];
    const layouts = meta?.layouts ?? [];
    const page = resolveCompiledRuntimePage(ctx.modules[path] ?? {}, layouts, root, ctx);
    if (!page) {
      throw new Error(`[furin] ${path}: invalid page module in CompileContext.`);
    }
    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
    validateRouteChain(routeChain, root.route, path);
    const boundaries = (meta?.segmentBoundaries ?? []).map(
      (boundary): SegmentBoundary => ({
        ...boundary,
        error: boundary.fromRoute
          ? routeBoundaryComponent<ErrorComponent>(ctx, boundary.errorPath, "errorComponent")
          : resolveModuleComponent(boundary.errorPath),
        notFound: boundary.fromRoute
          ? routeBoundaryComponent<NotFoundComponent>(
              ctx,
              boundary.notFoundPath,
              "notFoundComponent"
            )
          : resolveModuleComponent(boundary.notFoundPath),
      })
    );

    routes.push({
      layouts,
      mode,
      page,
      path,
      pattern,
      requestKeys: meta?.requestKeys,
      requestKeysByLoader: meta?.requestKeysByLoader,
      routeChain,
      segmentBoundaries: boundaries,
      tags: collectRouteTags(routeChain, page),
    });
  }

  return { root, routes };
}

/** A TanStack-style boundary component, read from the route module's `.error()` / `.notFound()`. */
function routeBoundaryComponent<T>(
  ctx: CompileContext,
  modulePath: string | undefined,
  field: "errorComponent" | "notFoundComponent"
): T | undefined {
  const route = modulePath ? ctx.modules[modulePath]?.route : undefined;
  return isDefinedRouteTerminal(route) ? (route[field] as T | undefined) : undefined;
}

function resolveCompiledRuntimePage(
  module: { route?: unknown },
  layouts: readonly ResolvedLayout[],
  root: RootLayout,
  context: CompileContext
): RuntimePage | undefined {
  if (!isDefinedRouteTerminal(module.route) || typeof module.route.page !== "function") {
    return;
  }
  let parent = root.route;
  for (const { path } of layouts) {
    const layout = context.modules[path]?.route;
    if (!isDefinedRouteTerminal(layout) || typeof layout.layout !== "function") {
      throw invalidNestedLayoutError(path);
    }
    parent = adaptDefinedLayout(layout, parent, path);
  }
  return adaptDefinedPage(module.route, parent);
}

export function invalidNestedLayoutError(layoutPath: string): Error {
  return new Error(
    `[furin] ${layoutPath}: a layout file must export \`route = defineRoute(id).config({ mode }).layout(({ children }) => ...)\`, with the file's id. For example, in board/route.tsx:
  export const route = defineRoute("/board")
    .config({ mode: "ssr" })
    .layout(({ children }) => <section>{children}</section>);`
  );
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

/** Layouts wrapping a manifest route, shallow → deep, the root excluded. */
export function manifestLayouts(manifest: RouteManifest, route: ManifestRoute): ResolvedLayout[] {
  const byPath = new Map(manifest.routes.map((entry) => [entry.sourcePath, entry]));
  const layouts: ResolvedLayout[] = [];
  for (let parent = route.parentPath; parent !== undefined; ) {
    const layout = byPath.get(parent);
    if (!layout) {
      break;
    }
    layouts.unshift({ path: layout.sourcePath, pattern: layout.pattern });
    parent = layout.parentPath;
  }
  return layouts;
}

export async function scanPages(instance: RouteInstanceSpec): Promise<{
  root: RootLayout;
  routes: ResolvedRoute[];
}> {
  // Normalise once at the entry point: the manifest and every lookup below
  // operate purely on POSIX-separated paths.
  const pagesDir = toPosixPath(instance.pagesDir);
  const manifest = scanRouteManifest({ ...instance, pagesDir });
  const root = await scanRootLayout(manifest, pagesDir, instance.style);
  const routes = await scanPageFiles(manifest, pagesDir, instance.style, root);
  if (routes.some((route) => route.routeChain.some((entry) => entry.requestLoader))) {
    await annotateScannedRequestKeys(routes);
  }
  return { root, routes };
}

const ROOT_EXAMPLE = `  export const route = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head><HeadContent /></head>
        <body>{children}<Scripts /></body>
      </html>
    ));`;

const CONVENTION_EXAMPLES = {
  error: `  export default function ErrorPage({ error, reset }: ErrorProps) {
    return <button onClick={reset}>{error.message}</button>;
  }`,
  "not-found": `  export default function NotFound() {
    return <h1>Page not found</h1>;
  }`,
} as const;

const ROOT_FILE_NAMES: { [Style in RouteStyle]: string } = {
  nextjs: "layout.tsx",
  tanstack: "__root.tsx",
};

export async function scanRootLayout(
  manifest: RouteManifest,
  pagesDir: string,
  style: RouteStyle
): Promise<RootLayout> {
  const { rootPath } = manifest;
  const rootFile = ROOT_FILE_NAMES[style];
  const ctx = getCompileContext();
  if (!(existsSync(rootPath) || ctx?.modules[rootPath])) {
    throw new Error(
      `[furin] ${rootFile}: not found in ${pagesDir}. Every pages directory needs a root layout:\n${ROOT_EXAMPLE}`
    );
  }

  // Dev loads root through the same versioned identity as the renderer and
  // the pages' rewritten imports, so its top level runs once per edit.
  const mod = (ctx?.modules[rootPath] ??
    (await import(
      isDevelopment()
        ? `${rootPath}?furin-server&t=${routeModuleSourceVersion(rootPath)}`
        : rootPath
    ))) as CompiledModule;
  const rootExport = mod.route;
  if (!isDefinedRouteTerminal(rootExport)) {
    throw new Error(
      `[furin] ${rootPath}: ${rootFile} must export \`route = defineRootRoute().config({ mode }).layout(...)\`:\n${ROOT_EXAMPLE}`
    );
  }

  if (!rootExport.layout) {
    throw new Error(
      `[furin] ${rootPath}: ${rootFile}: defineRootRoute() must end with .layout(({ children }) => ...):\n${ROOT_EXAMPLE}`
    );
  }
  const rootRoute = adaptDefinedLayout(rootExport, undefined, rootPath);
  if (style === "tanstack") {
    return {
      error: rootRoute.errorComponent,
      notFound: rootRoute.notFoundComponent,
      path: rootPath,
      route: rootRoute,
    };
  }

  const rootBoundary = manifest.boundaries.find((boundary) => boundary.directory === pagesDir);
  const [notFoundEntry, errorEntry] = await Promise.all([
    loadConventionComponent<NotFoundComponent>(rootBoundary?.notFoundPath, "not-found"),
    loadConventionComponent<ErrorComponent>(rootBoundary?.errorPath, "error"),
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

type ConventionName = "error" | "not-found";

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
  filePath: string | undefined,
  name: ConventionName
): Promise<ConventionLookup<T> | undefined> {
  if (filePath === undefined) {
    return;
  }
  const ctx = getCompileContext();
  const moduleSpecifier =
    isDevelopment() && existsSync(filePath)
      ? `${filePath}?furin-server&t=${routeModuleSourceVersion(filePath)}`
      : filePath;
  const mod = (ctx?.modules[filePath] ?? (await import(moduleSpecifier))) as {
    default?: T;
  };
  if (mod.default) {
    return { component: mod.default, path: filePath };
  }
  const exportNames = Object.keys(mod).join(", ") || "none";
  throw new Error(
    `[furin] ${filePath}: ${name}.tsx must default-export a React component (found exports: ${exportNames}). For example:\n${CONVENTION_EXAMPLES[name]}`
  );
}

async function scanPageFiles(
  manifest: RouteManifest,
  pagesDir: string,
  style: RouteStyle,
  root: RootLayout
): Promise<ResolvedRoute[]> {
  const routes: ResolvedRoute[] = [];
  const boundaryCache = new Map<string, Promise<SegmentBoundary>>();

  for (const manifestRoute of manifest.routes) {
    if (manifestRoute.kind !== "page") {
      continue;
    }
    const { pattern } = manifestRoute;
    const absolutePath = manifestRoute.sourcePath;
    const relativePath = routeRelativePath(pagesDir, absolutePath);
    const layouts = manifestLayouts(manifest, manifestRoute);

    const directoryBoundaries =
      style === "nextjs"
        ? await collectSegmentBoundaries(absolutePath, manifest.boundaries, boundaryCache)
        : [];

    if (isDevelopment()) {
      const devRoute = await buildDevRoute(absolutePath, relativePath, pattern, root, layouts);
      devRoute.segmentBoundaries =
        style === "nextjs"
          ? alignSegmentBoundaryDepths(directoryBoundaries, devRoute.routeChain)
          : routeDefinedBoundaries(root, devRoute.routeChain, devRoute.page, absolutePath);
      routes.push(devRoute);
      continue;
    }

    const ctx = getCompileContext();
    const pageMod = (ctx?.modules[absolutePath] ?? (await import(absolutePath))) as {
      route?: unknown;
    };
    const page = await resolveRuntimePage(pageMod, layouts, root.route);
    if (!page) {
      throw new Error(`[furin] ${relativePath}: no valid defineRoute(id).page() export found`);
    }

    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);

    validateRouteChain(routeChain, root.route, relativePath);

    routes.push({
      layouts,
      mode: resolveMode(page, routeChain),
      page,
      path: absolutePath,
      pattern,
      routeChain,
      segmentBoundaries:
        style === "nextjs"
          ? alignSegmentBoundaryDepths(directoryBoundaries, routeChain)
          : routeDefinedBoundaries(root, routeChain, page, absolutePath),
      tags: collectRouteTags(routeChain, page),
    });
  }

  return routes;
}

/**
 * TanStack-style boundaries come from `.error()` / `.notFound()` on the
 * routes themselves. A route's boundary sits in its parent's outlet, so it
 * also catches the route's own failure: depth = its chain index - 1. The
 * root's sits inside the root layout (depth 0). `path` is the route file, so
 * only the root's boundary is the root directory's.
 */
export function routeDefinedBoundaries(
  root: RootLayout,
  routeChain: readonly RuntimeRoute[],
  page: RuntimePage,
  pagePath: string
): SegmentBoundary[] {
  const entries: { depth: number; path: string | undefined; route: RuntimeRoute | RuntimePage }[] =
    [
      { depth: 0, path: root.path, route: routeChain[0] ?? root.route },
      // The chain ends with the page's own entry: layouts sit between it and the root.
      ...routeChain
        .slice(1, -1)
        .map((route, index) => ({ depth: index, path: route.sourcePath, route })),
      { depth: Math.max(routeChain.length - 2, 0), path: pagePath, route: page },
    ];
  const pagesDir = root.path.slice(0, root.path.lastIndexOf("/"));
  return entries.flatMap(({ depth, path, route }): SegmentBoundary[] => {
    const { errorComponent, notFoundComponent } = route;
    if (path === undefined || !(errorComponent || notFoundComponent)) {
      return [];
    }
    return [
      {
        depth,
        error: errorComponent,
        errorPath: errorComponent ? path : undefined,
        fromRoute: true,
        notFound: notFoundComponent,
        notFoundPath: notFoundComponent ? path : undefined,
        path: path === root.path ? pagesDir : path,
      },
    ];
  });
}

async function resolveRuntimePage(
  module: { route?: unknown },
  layouts: readonly ResolvedLayout[],
  rootRoute: RuntimeRoute
): Promise<RuntimePage | undefined> {
  if (!isDefinedRouteTerminal(module.route) || typeof module.route.page !== "function") {
    return;
  }
  const parent = await resolveDefinedLayoutParent(layouts, rootRoute);
  return adaptDefinedPage(module.route, parent);
}

async function resolveDefinedLayoutParent(
  layouts: readonly ResolvedLayout[],
  rootRoute: RuntimeRoute
): Promise<RuntimeRoute> {
  let parent = rootRoute;
  for (const { path } of layouts) {
    const layoutModule = (await import(
      isDevelopment() ? `${path}?furin-server&t=${routeModuleSourceVersion(path)}` : path
    )) as { route?: unknown };
    const layout = layoutModule.route;
    if (!isDefinedRouteTerminal(layout) || typeof layout.layout !== "function") {
      throw invalidNestedLayoutError(path);
    }
    parent = adaptDefinedLayout(layout, parent, path);
  }
  return parent;
}

function alignSegmentBoundaryDepths(
  boundaries: SegmentBoundary[],
  routeChain: RuntimeRoute[]
): SegmentBoundary[] {
  return boundaries.map((boundary) => {
    let depth = 0;
    for (const [index, entry] of routeChain.entries()) {
      if (!entry.sourcePath) {
        continue;
      }
      const directory = entry.sourcePath.slice(0, entry.sourcePath.lastIndexOf("/"));
      if (boundary.path === directory || boundary.path.startsWith(`${directory}/`)) {
        depth = index;
      }
    }
    return { ...boundary, depth };
  });
}

/**
 * The Next.js-style `error` / `not-found` boundaries of the directories from
 * the pages root down to the page's own directory, shallow → deep. Each
 * entry holds only the files declared IN that directory, never inherited.
 * The cache shares the imported modules between sibling pages.
 */
async function collectSegmentBoundaries(
  pageAbsolutePath: string,
  boundaries: readonly ManifestBoundary[],
  cache: Map<string, Promise<SegmentBoundary>>
): Promise<SegmentBoundary[]> {
  const pageDir = pageAbsolutePath.slice(0, pageAbsolutePath.lastIndexOf("/"));
  const enclosing = boundaries.filter(
    ({ directory }) => pageDir === directory || pageDir.startsWith(`${directory}/`)
  );
  return await Promise.all(
    enclosing.map((boundary) => {
      const cached = cache.get(boundary.directory);
      if (cached) {
        return cached;
      }
      const loaded = Promise.all([
        loadConventionComponent<ErrorComponent>(boundary.errorPath, "error"),
        loadConventionComponent<NotFoundComponent>(boundary.notFoundPath, "not-found"),
      ]).then(
        ([errorEntry, notFoundEntry]): SegmentBoundary => ({
          depth: 0,
          error: errorEntry?.component,
          errorPath: errorEntry?.path,
          notFound: notFoundEntry?.component,
          notFoundPath: notFoundEntry?.path,
          path: boundary.directory,
        })
      );
      cache.set(boundary.directory, loaded);
      return loaded;
    })
  );
}

async function buildDevRoute(
  absolutePath: string,
  relativePath: string,
  pattern: string,
  root: RootLayout,
  layouts: ResolvedLayout[]
): Promise<ResolvedRoute> {
  // Import via the virtual namespace (registerDevPagePlugin must be called first)
  // so page files stay out of --hot's module graph. We still extract the route
  // chain at startup for type generation, guards, and mode resolution — matching
  // prod behavior exactly.
  let page: RuntimePage | undefined;
  let routeChain: RuntimeRoute[] = [];

  try {
    const pageMod = (await import(
      `${absolutePath}?furin-server&t=${routeModuleSourceVersion(absolutePath)}`
    )) as {
      route?: unknown;
    };
    const resolvedPage = await resolveRuntimePage(pageMod, layouts, root.route);
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
    layouts,
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
