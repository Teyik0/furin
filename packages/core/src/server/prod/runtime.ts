import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { resolveClientDirFromArgv } from "../assets/client-dir.ts";
import { createProductionAssetsPlugin } from "../assets/production.ts";
import { setSSGCache } from "../cache/ssg.ts";
import { type FurinInstance, withInstance } from "../instance.ts";
import type { CompileContext, EmbeddedAppData } from "../internal.ts";
import type { ModeOptions, ModeRuntime } from "../mode.ts";
import { warmSSGCache } from "../render/ssg.ts";
import {
  setProductionPreloadManifest,
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "../render/template.ts";
import { loadProdRoutes } from "../router/discovery.ts";
import { bindRuntimeRoutes, createRouteRenderer, type PagePorts } from "../router/dispatch.ts";
import { buildRouteMatcher } from "../router/patterns.ts";
import { createSearchRouteMetadata } from "../router/schemas.ts";
import type { ResolvedRoute } from "../router/types.ts";
import type { FurinSyncOption } from "../sync/config.ts";

/**
 * Production's page ports: the built route manifest, whose native routes
 * Elysia validates, its bundled modules, and the page cache.
 */
const productionPagePorts: PagePorts = {
  cache: {
    loaders: () => Promise.resolve(undefined),
    pages: true,
  },
  modules: {
    data: (route, root, serve) => serve({ root, route }),
    document: (route, root, serve) => serve({ root, route }),
    render: (route) => Promise.resolve(route),
  },
  routes: {
    has: () => true,
    validatesParams: true,
  },
};

async function createProductionBrowserEventsPlugin(
  sync: FurinSyncOption | undefined,
  deploymentTarget: "vercel" | undefined
): Promise<AnyElysia> {
  if (!sync) {
    return new Elysia();
  }
  const browserEvents = await import("../browser-events/plugin.ts");
  // Vercel invokes app.handle(Request), so Elysia's Bun.Server WebSocket upgrade is unavailable.
  return deploymentTarget === "vercel"
    ? browserEvents.createSseBrowserEventsPlugin({ sync })
    : browserEvents.createBrowserEventsPlugin({ sync });
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  clientDir: string,
  instance: FurinInstance
): Promise<void> {
  if (embedded) {
    const templatePath = join(embedded.clientDir, "index.html");
    if (!existsSync(templatePath)) {
      throw new Error("[furin] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(templatePath).text();
    setProductionTemplateContent(html, instance);
    return;
  }

  const templatePath = join(clientDir, "index.html");
  if (!existsSync(templatePath)) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  setProductionTemplatePath(templatePath, instance);
}

async function setupCompiledTemplate(
  ctx: CompileContext,
  embedded: EmbeddedAppData | undefined,
  clientDir: string,
  instance: FurinInstance
): Promise<void> {
  if (ctx.preloadManifest) {
    setProductionPreloadManifest(ctx.preloadManifest, instance);
  }
  if (ctx.templateHtml === undefined) {
    await setupProdTemplate(embedded, clientDir, instance);
    return;
  }
  setProductionTemplateContent(ctx.templateHtml, instance);
}

function hydrateSSGCacheFromCompileContext(ctx: CompileContext): void {
  if (!ctx.ssgCache) {
    return;
  }
  for (const [path, entry] of Object.entries(ctx.ssgCache)) {
    setSSGCache(path, entry);
  }
}

/** Serves a runtime from its compiled routes, template and client assets. */
export async function createProdRuntime(
  instance: FurinInstance,
  ctx: CompileContext | null,
  explicitClientDir: string | undefined,
  options: ModeOptions
): Promise<ModeRuntime> {
  if (!ctx) {
    throw new Error("[furin] No pre-built assets found. Run `bunx furin build` first.");
  }
  const { root, routes } = loadProdRoutes(ctx);
  const searchRoutes = createSearchRouteMetadata(routes);
  const prodBuildId = ctx.buildId ?? "";
  if (!ctx.nativeRoutes) {
    throw new Error("[furin] Production build is missing the composed Elysia route app.");
  }
  const matchPage = buildRouteMatcher(routes);
  // Each page's native handler is bound to its route terminal.
  const routesByPage = new Map<object, ResolvedRoute>(
    routes.map((route) => [(ctx.modules[route.path] as { route: object }).route, route])
  );
  const renderer = createRouteRenderer(
    instance,
    routes,
    root,
    prodBuildId,
    searchRoutes,
    (key) => (typeof key === "string" ? undefined : routesByPage.get(key)),
    productionPagePorts
  );
  bindRuntimeRoutes(instance, {
    matches: (path) => matchPage(path) !== null,
    refresh: undefined,
    renderer: () => renderer,
  });
  instance.buildId = prodBuildId;
  // Init-time writes target THIS instance explicitly — with several mounted
  // apps there is no ambient request scope to resolve it from.
  withInstance(instance, () => {
    hydrateSSGCacheFromCompileContext(ctx);
  });

  const { embedded } = ctx;
  const clientDir =
    embedded?.clientDir ??
    explicitClientDir ??
    ctx.clientDir ??
    resolveClientDirFromArgv(instance.prefix);
  await setupCompiledTemplate(ctx, embedded, clientDir, instance);
  const assets = await createProductionAssetsPlugin(ctx, embedded, clientDir);
  const browserEvents = await createProductionBrowserEventsPlugin(
    options.sync,
    ctx.deploymentTarget
  );

  return {
    nativeRoutes: ctx.nativeRoutes,
    plugins: (app) =>
      app
        .use(options.requestHooks)
        .onStart(async ({ server }) => {
          if (ctx.ssgCache) {
            return;
          }
          const origin = server?.url?.origin ?? "http://localhost:3000";
          // Synthetic (non-request) renders — bind them to this instance so the
          // render pipeline resolves its template/caches, not a sibling's.
          await withInstance(instance, () => warmSSGCache(routes, root, origin, searchRoutes));
        })
        .use(assets)
        .use(browserEvents),
  };
}
