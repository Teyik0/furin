import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { furin } from "../../src/furin.ts";
import { materializedRouteModuleSource } from "../../src/plugin/route-registry.ts";
import type { PageCacheAdapter } from "../../src/server/cache/page-cache.ts";
import { allInstances, type FurinInstance } from "../../src/server/instance.ts";
import {
  __setCompileContext,
  type CompileContext,
  type CompiledModule,
} from "../../src/server/internal.ts";
import { scanPages } from "../../src/server/router/discovery.ts";
import type { ErrorComponent } from "../../src/shared/error.ts";
import type { NotFoundComponent } from "../../src/shared/not-found.ts";

const TEMPLATE =
  '<!doctype html><html><head><!--furin-head--></head><body><div id="root"><!--ssr-outlet--></div><script type="module" src="/_client/entry.js"></script></body></html>';
const TMP_ROOT = resolve(import.meta.dir, "../../.tmp-tests");
/** No asset directory exists for these virtual apps. */
const PLATFORM_ASSETS: NonNullable<CompileContext["adapter"]> = {
  capabilities: { assets: "platform", publicCache: "framework", websocket: true },
  name: "test",
};

type SegmentBoundaryMetadata = NonNullable<
  CompileContext["routeMetadata"]
>[string]["segmentBoundaries"][number];

/** A route terminal from `defineRoute("/")` / `defineRootRoute()`. */
interface RouteTerminal {
  elysia: AnyElysia;
}

export interface ProductionPage {
  /**
   * Intermediate layout above the page, mounted as `<segment>/_route.tsx`,
   * with optional `<segment>/error.tsx` / `<segment>/not-found.tsx` beside it.
   * The page's URL is still `pattern`.
   */
  layout?: {
    error?: ErrorComponent;
    notFound?: NotFoundComponent;
    route: RouteTerminal;
    segment: string;
  };
  pattern: string;
  /** Private field names the build would infer from the chain's request loaders. */
  requestKeys?: string[];
  route: RouteTerminal;
}

export interface ProductionAppOptions {
  buildId: string;
  pageCache?: PageCacheAdapter;
  pages: readonly ProductionPage[];
  prefix?: string;
  root: RouteTerminal;
  rootError?: ErrorComponent;
  rootNotFound?: NotFoundComponent;
  ssgCache?: CompileContext["ssgCache"];
}

interface MountedApp {
  app: AnyElysia;
  instance: FurinInstance;
}

function pageMode(route: RouteTerminal): "isr" | "ssg" | "ssr" {
  return (route as RouteTerminal & { mode: "isr" | "ssg" | "ssr" }).mode;
}

async function mount(
  context: CompileContext,
  pagesDir: string,
  pageCache: PageCacheAdapter | undefined
): Promise<MountedApp> {
  __setCompileContext(context);
  const app = new Elysia().use(await furin({ pageCache, pagesDir, prefix: context.prefix }));
  const instance = allInstances().find((candidate) => candidate.pagesDir === pagesDir);
  if (!instance) {
    throw new Error(`[test] furin() did not register a runtime for ${pagesDir}`);
  }
  return { app, instance };
}

/**
 * Mounts route terminals through a real production `furin()`, the way a build
 * composes them: virtual page modules in a compile context, each page's own
 * `route.elysia` as its native route.
 */
export function mountProductionApp(options: ProductionAppOptions): Promise<MountedApp> {
  const pagesDir = `/furin-virtual/${crypto.randomUUID()}`;
  const rootPath = `${pagesDir}/root.tsx`;
  const modules: { [path: string]: CompiledModule } = { [rootPath]: { route: options.root } };
  const rootConventions: NonNullable<CompileContext["rootConventions"]> = {};
  if (options.rootError) {
    rootConventions.errorPath = `${pagesDir}/error.tsx`;
    modules[rootConventions.errorPath] = { default: options.rootError };
  }
  if (options.rootNotFound) {
    rootConventions.notFoundPath = `${pagesDir}/not-found.tsx`;
    modules[rootConventions.notFoundPath] = { default: options.rootNotFound };
  }
  const routes: CompileContext["routes"] = [];
  const routeMetadata: NonNullable<CompileContext["routeMetadata"]> = {};
  const nativeRoutes = new Elysia();
  for (const [index, page] of options.pages.entries()) {
    const directory = page.layout ? `${pagesDir}/${page.layout.segment}` : pagesDir;
    const segmentBoundaries: SegmentBoundaryMetadata[] = [];
    if (page.layout) {
      modules[`${directory}/_route.tsx`] = { route: page.layout.route };
      const boundary: SegmentBoundaryMetadata = { depth: 1, path: directory };
      if (page.layout.error) {
        boundary.errorPath = `${directory}/error.tsx`;
        modules[boundary.errorPath] = { default: page.layout.error };
      }
      if (page.layout.notFound) {
        boundary.notFoundPath = `${directory}/not-found.tsx`;
        modules[boundary.notFoundPath] = { default: page.layout.notFound };
      }
      if (boundary.errorPath || boundary.notFoundPath) {
        segmentBoundaries.push(boundary);
      }
    }
    const path = `${directory}/page-${index}.tsx`;
    modules[path] = { route: page.route };
    routes.push({ mode: pageMode(page.route), path, pattern: page.pattern });
    routeMetadata[path] = { requestKeys: page.requestKeys, segmentBoundaries };
    nativeRoutes.use(new Elysia({ prefix: page.pattern }).use(page.route.elysia));
  }
  return mount(
    {
      buildId: options.buildId,
      modules,
      nativeRoutes,
      prefix: options.prefix,
      rootConventions,
      rootPath,
      routeMetadata,
      adapter: PLATFORM_ASSETS,
      routes,
      ssgCache: options.ssgCache,
      templateHtml: TEMPLATE,
    },
    pagesDir,
    options.pageCache
  );
}

/**
 * Mounts a pages directory through a real production `furin()`: the compile
 * context a build would emit, with the build's own Elysia route composition.
 */
export async function mountProductionPages(pagesDir: string, buildId: string): Promise<MountedApp> {
  const { root, routes } = await scanPages(pagesDir);
  const paths = new Set([root.path, root.errorPath, root.notFoundPath]);
  const routeMetadata: NonNullable<CompileContext["routeMetadata"]> = {};
  for (const route of routes) {
    paths.add(route.path);
    for (const entry of route.routeChain) {
      paths.add(entry.sourcePath);
    }
    for (const boundary of route.segmentBoundaries) {
      paths.add(boundary.errorPath);
      paths.add(boundary.notFoundPath);
    }
    routeMetadata[route.path] = {
      requestKeys: route.requestKeys,
      requestKeysByLoader: route.requestKeysByLoader,
      segmentBoundaries: route.segmentBoundaries.map(
        ({ depth, errorPath, notFoundPath, path }) => ({
          depth,
          errorPath,
          notFoundPath,
          path,
        })
      ),
    };
  }
  const modules: { [path: string]: CompiledModule } = {};
  await Promise.all(
    [...paths].map(async (path) => {
      if (path !== undefined) {
        modules[path] = await import(path);
      }
    })
  );
  mkdirSync(TMP_ROOT, { recursive: true });
  const routesModule = join(TMP_ROOT, `native-routes-${crypto.randomUUID()}.ts`);
  writeFileSync(routesModule, await materializedRouteModuleSource({ pagesDir, prefix: "" }));
  const { furinApp } = (await import(routesModule)) as { furinApp: AnyElysia };
  return mount(
    {
      buildId,
      modules,
      nativeRoutes: furinApp,
      rootConventions: { errorPath: root.errorPath, notFoundPath: root.notFoundPath },
      rootPath: root.path,
      routeMetadata,
      adapter: PLATFORM_ASSETS,
      routes: routes.map(({ mode, path, pattern }) => ({ mode, path, pattern })),
      templateHtml: TEMPLATE,
    },
    root.path.slice(0, root.path.lastIndexOf("/")),
    undefined
  );
}
