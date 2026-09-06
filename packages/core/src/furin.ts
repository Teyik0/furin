import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
import { type AnyElysia, Elysia, file } from "elysia";
import { type DrainContext, initLogger, type LoggerConfig } from "evlog";
import { type EvlogElysiaOptions, evlog } from "evlog/elysia";
import { FURIN_RENDER_DECORATOR, type FurinRouteDispatcher } from "./define-route.ts";
import { consumePendingInvalidations } from "./server/cache/invalidation.ts";
import { setSSGCache } from "./server/cache/ssg.ts";
import {
  createInstrumentationPlugin,
  instrumentationLoggerExclusions,
  runWithRequestInstrumentation,
  shouldInstrumentRequest,
} from "./server/devtools/instrumentation.ts";
import {
  assertPrefixAvailable,
  createInstance,
  type FurinInstance,
  hasRequestScope,
  markTraffic,
  normalizePrefix,
  registerInstance,
  resolveInstanceByPath,
  runWithInstanceScope,
  withInstance,
} from "./server/instance.ts";
import type { CompileContext, EmbeddedAppData } from "./server/internal.ts";
import { getCompileContext } from "./server/internal.ts";
import { renderRootNotFound } from "./server/render/not-found.ts";
import { warmSSGCache } from "./server/render/ssg.ts";
import {
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "./server/render/template.ts";
import { loadProdRoutes } from "./server/router/discovery.ts";
import { invalidateStampedRouteModules } from "./server/router/hmr.ts";
import { buildRouteMatcher } from "./server/router/patterns.ts";
import { createDataEndpoint, renderResolvedRoute } from "./server/router/plugin.ts";
import { mergeRouteSchemas } from "./server/router/schema-merge.ts";
import {
  createSearchRouteMetadata,
  parseRouteParams,
  parseRouteQuery,
} from "./server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "./server/router/types.ts";
import { IS_DEV } from "./server/runtime-env.ts";
import { type FurinSyncOption, resolveSyncStreamPath } from "./server/sync/config.ts";
import { createSyncStreamPlugin } from "./server/sync/stream.ts";

// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmentable via furin-env.d.ts
export interface FurinCacheTags {}

export type CacheTag = keyof FurinCacheTags extends never ? string : keyof FurinCacheTags;

import { clientDirNameForPrefix } from "./shared/prefix.ts";

// biome-ignore lint/performance/noBarrelFile: furin.ts is the public package entry
export {
  type DefineRouteConfig,
  defineRootRoute,
  defineRoute,
  type RequestLoaderContext,
  type RouteLoaderData,
  type RouteParams,
} from "./define-route.ts";
export {
  type ClientIsomorphicFn,
  createIsomorphicFn,
  type IsomorphicFn,
  type IsomorphicFnBuilder,
  type ServerIsomorphicFn,
} from "./isomorphic.ts";
export { clientDirNameForPrefix } from "./shared/prefix.ts";

const MAX_BROWSER_INGEST_BYTES = 64 * 1024;
const MAX_BROWSER_INGEST_EVENTS = 100;
const DEV_ROUTE_TOPOLOGY_POLL_INTERVAL_MS = 100;

function resolveClientDirFromArgv(prefix: string): string {
  const dirName = clientDirNameForPrefix(prefix);
  return (
    resolveClientDirFromEnv(dirName) ??
    resolveClientDirFromModuleUrl(dirName) ??
    resolveClientDirFromProcessArgs(dirName) ??
    resolveFallbackClientDir(dirName)
  );
}

function resolveClientDirFromEnv(dirName: string): string | null {
  const envClientDir = process.env.FURIN_CLIENT_DIR;
  if (!envClientDir) {
    return null;
  }
  const base = envClientDir.startsWith("/") ? envClientDir : resolve(process.cwd(), envClientDir);
  // FURIN_CLIENT_DIR points at the ROOT instance's client dir; sibling
  // instances live next to it under their own dir name.
  return dirName === "client" ? base : join(dirname(base), dirName);
}

function resolveClientDirFromModuleUrl(dirName: string): string | null {
  try {
    const moduleUrl = new URL(import.meta.url);
    if (moduleUrl.protocol !== "file:") {
      return null;
    }
    const modulePath = fileURLToPath(moduleUrl);
    if (modulePath.includes("/$bunfs/")) {
      return null;
    }
    const moduleClientDir = join(dirname(modulePath), dirName);
    if (existsSync(join(moduleClientDir, "index.html"))) {
      return moduleClientDir;
    }
  } catch {
    // ignore, fallback to argv-based resolution
  }
  return null;
}

function resolveClientDirFromProcessArgs(dirName: string): string | null {
  const candidates = [
    process.argv[1],
    process.argv[0],
    (process as { argv0?: string }).argv0,
    process.execPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const resolved = resolveClientDirFromCandidate(candidate, dirName);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveClientDirFromCandidate(candidate: string, dirName: string): string | null {
  const name = basename(candidate);
  if (name === "bun" || name === "node") {
    return null;
  }
  if (candidate.includes("/$bunfs/") || candidate.startsWith("bunfs:")) {
    return null;
  }

  const absolute = candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
  if (existsSync(absolute)) {
    return join(dirname(absolute), dirName);
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate, dirName);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string, dirName: string): string | null {
  const pathEntries = process.env.PATH?.split(":") ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      return join(dirname(fullPath), dirName);
    }
  }
  return null;
}

function resolveFallbackClientDir(dirName: string): string {
  const defaultClientDir = resolve(process.cwd(), ".furin/build/bun", dirName);
  if (existsSync(join(defaultClientDir, "index.html"))) {
    return defaultClientDir;
  }

  return join(process.cwd(), dirName);
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  clientDir: string,
  instance: FurinInstance
): Promise<void> {
  if (embedded) {
    if (!embedded.template) {
      throw new Error("[furin] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(embedded.template).text();
    setProductionTemplateContent(html, instance);
    return;
  }

  const templatePath = join(clientDir, "index.html");
  if (!existsSync(templatePath)) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  setProductionTemplatePath(templatePath, instance);
}

/**
 * Shape of one browser-submitted log event. The named keys are the dangerous
 * ones stripped before `log.set` (prototype-pollution vectors, plus the
 * browser `environment` which must not overwrite the server's); everything
 * else is forwarded as-is.
 */
interface FurinBrowserEvent {
  __proto__?: unknown;
  constructor?: unknown;
  environment?: unknown;
  prototype?: unknown;
  [key: string]: unknown;
}

type BrowserIngestRead =
  | { body: unknown; kind: "ok" }
  | { kind: "invalid" }
  | { kind: "oversized" };

async function readBrowserIngest(request: Request): Promise<BrowserIngestRead> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BROWSER_INGEST_BYTES) {
      await request.body?.cancel();
      return { kind: "oversized" };
    }
  }
  if (request.body === null) {
    return { kind: "invalid" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: request body chunks must be read sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BROWSER_INGEST_BYTES) {
        await reader.cancel();
        return { kind: "oversized" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)), kind: "ok" };
  } catch {
    return { kind: "invalid" };
  }
}

/** Evlog wide-event plugin + browser log ingest endpoint for one instance. */
function createLoggerPlugin(
  prefix: string,
  syncStreamPath: string | undefined,
  logger: EvlogElysiaOptions | undefined,
  clientLogging: boolean
): Elysia {
  const { exclude: userExclude, ...evlogOptions } = logger ?? {};
  const app = new Elysia().use(
    evlog({
      ...evlogOptions,
      // Exclude patterns match the PHYSICAL request path — prefix them.
      exclude: [
        `${prefix}/_client/**`,
        `${prefix}/public/**`,
        `${prefix}/favicon.ico`,
        `${prefix}/_bun_hmr_entry/**`,
        ...instrumentationLoggerExclusions(prefix),
        ...(syncStreamPath ? [`${prefix}${syncStreamPath}`] : []),
        // Note: /_furin/data is logged with the *logical* path rewritten by
        // createDataEndpoint via useLogger().set({ path }), so SPA navigations
        // appear as "GET /board/123 200" — same shape as a normal SSR nav.
        // /_furin/ingest remains loggable when browser logging is explicitly
        // enabled so browser-side events show up.
        // evlog's `matchesPattern` only supports `*`, `**`, `?` — extglob
        // like `!(...)` matches nothing, so don't add patterns relying on it.
        ...(userExclude ?? []),
      ],
    })
  );

  if (!clientLogging) {
    return app as unknown as Elysia;
  }

  return app.post(
    "/_furin/ingest",
    async ({ log, request, status }) => {
      const parsed = await readBrowserIngest(request);
      if (parsed.kind === "oversized") {
        return status(413);
      }
      if (parsed.kind === "invalid") {
        return status("Bad Request");
      }
      const { body } = parsed;
      if (!Array.isArray(body)) {
        return status("Bad Request");
      }
      const batch = (body as DrainContext[]).slice(0, MAX_BROWSER_INGEST_EVENTS);
      for (const entry of batch) {
        if (!entry || typeof entry !== "object" || !("event" in entry)) {
          log.set({ msg: "[furin] ingest: skipping malformed entry" });
          continue;
        }
        // Pick only safe, known fields from the event to prevent prototype pollution
        const event = entry.event as FurinBrowserEvent | undefined;
        if (!event || typeof event !== "object") {
          continue;
        }
        const {
          __proto__,
          constructor: _ctor,
          prototype,
          environment: _browserEnv,
          ...safeEvent
        } = event;
        log.set({ ...safeEvent, service: "furin:browser" });
      }
      return status("No Content");
    },
    { parse: "none" }
  ) as unknown as Elysia;
}

function initializeLogger(logger: FurinLoggerOptions | undefined): EvlogElysiaOptions {
  const { sampling, ...elysiaLoggerOptions } = logger ?? {};
  initLogger({
    env: { service: "furin" },
    ...(sampling ? { sampling } : {}),
  });
  return elysiaLoggerOptions;
}

/**
 * Registers a HigherOrderFunction on the Elysia instance so that every request
 * runs inside a fresh instance-bound `AsyncLocalStorage` scope. This isolates
 * `pendingInvalidations` per request AND binds the request to the furin
 * instance that owns its path, so render/cache code resolves the right
 * per-instance state (build ID, template, caches, sync path).
 *
 * Uses `app.wrap()` (Elysia HigherOrderFunction) instead of mutating
 * `app.handle`, because handle mutations are lost when the Furin plugin is
 * `.use()`-d by a parent Elysia instance. HigherOrderFunctions survive the
 * plugin merge and wrap the entire composed `map` handler.
 *
 * IMPORTANT — multi-instance: HigherOrderFunctions apply to the WHOLE parent
 * app, so with N mounted furin instances all N wraps run stacked on every
 * request. The scope guard makes the wrap idempotent (first one wins) and the
 * owning instance is resolved from the request PATH, never from this
 * closure — which wrap executes first is therefore irrelevant.
 */
function wrapWithRequestScope(app: AnyElysia): Elysia {
  return app.wrap((handler, request) => (ctx: unknown) => {
    if (hasRequestScope()) {
      return handler(ctx);
    }
    markTraffic();
    const req = request ?? (ctx as { request?: Request } | undefined)?.request;
    const pathname = req ? new URL(req.url).pathname : "/";
    const instance = resolveInstanceByPath(pathname);
    return runWithInstanceScope(instance, () => {
      if (!(req && shouldInstrumentRequest(pathname, instance.prefix))) {
        return handler(ctx);
      }
      return runWithRequestInstrumentation(req, () => handler(ctx));
    });
  });
}

function createFurinPlugin(
  app: AnyElysia,
  prepareParent: ((parentApp: AnyElysia) => void) | undefined
) {
  const scopedApp = wrapWithRequestScope(app);
  return <ParentApp extends AnyElysia>(parentApp: ParentApp) => {
    prepareParent?.(parentApp);
    return parentApp.use(scopedApp);
  };
}

async function loadDevelopmentRoutes(resolvedPagesDir: string) {
  const { scanPages } = await import("./server/router/discovery.ts");
  return scanPages(resolvedPagesDir);
}

function createNativeRouteRenderer(
  prefix: string,
  routes: ResolvedRoute[],
  root: RootLayout,
  buildId: string,
  searchRoutes: ReturnType<typeof createSearchRouteMetadata>
): FurinRouteDispatcher {
  const matchNativeRoute = buildRouteMatcher(routes);
  return async (context) => {
    const { request } = context;
    const requestUrl = new URL(request.url);
    const { pathname } = requestUrl;
    const hasPrefix = prefix !== "" && (pathname === prefix || pathname.startsWith(`${prefix}/`));
    const logicalPath = hasPrefix ? pathname.slice(prefix.length) : pathname;
    const matched = matchNativeRoute(logicalPath || "/");
    if (!matched) {
      // Dev topology swap: the mounted Elysia route can outlive its source
      // file (hot-remove). Render the root not-found page instead of failing.
      const listenerOrigin = (context.server as { url?: { origin: string } } | undefined)?.url
        ?.origin;
      return renderRootNotFound(root, request, listenerOrigin);
    }
    const parsedParams = await parseRouteParams(
      matched.params,
      mergeRouteSchemas(matched.route.routeChain, "params")
    );
    if (!parsedParams.ok) {
      return Response.json(
        { errors: parsedParams.errors, message: "Invalid params", type: "validation" },
        { status: 422 }
      );
    }
    const parsedQuery = await parseRouteQuery(
      requestUrl,
      mergeRouteSchemas(matched.route.routeChain, "query")
    );
    if (!parsedQuery.ok) {
      return Response.json(
        { errors: parsedQuery.errors, message: "Invalid query", type: "validation" },
        { status: 422 }
      );
    }
    context.params = parsedParams.params;
    context.query = parsedQuery.query;
    return renderResolvedRoute(
      matched.route,
      context as unknown as Parameters<typeof renderResolvedRoute>[1],
      root,
      buildId,
      searchRoutes
    );
  };
}

interface DevelopmentRouteSnapshot {
  render: FurinRouteDispatcher;
  root: RootLayout;
  routes: ResolvedRoute[];
}

function createDevelopmentRouteSnapshot(
  prefix: string,
  root: RootLayout,
  routes: ResolvedRoute[]
): DevelopmentRouteSnapshot {
  const searchRoutes = createSearchRouteMetadata(routes);
  return {
    render: createNativeRouteRenderer(prefix, routes, root, "", searchRoutes),
    root,
    routes,
  };
}

const nativeRouteRenderers = new WeakMap<FurinInstance, FurinRouteDispatcher>();

function dispatchNativeRoute(context: Parameters<FurinRouteDispatcher>[0]): unknown {
  const { pathname } = new URL(context.request.url);
  const renderer = nativeRouteRenderers.get(resolveInstanceByPath(pathname));
  if (!renderer) {
    throw new Error(`[furin] No route renderer is registered for ${JSON.stringify(pathname)}`);
  }
  return renderer(context);
}

function hydrateSSGCacheFromCompileContext(ctx: CompileContext): void {
  if (!ctx.ssgCache) {
    return;
  }
  for (const [path, entry] of Object.entries(ctx.ssgCache)) {
    setSSGCache(path, entry);
  }
}

/** Options for the {@link furin} plugin. */
export type FurinLoggerOptions = EvlogElysiaOptions & Pick<LoggerConfig, "sampling">;

export interface FurinOptions {
  /**
   * Production only: explicit directory holding this app's built client
   * assets (chunks + index.html template). Packaged furin apps pass their own
   * `dist/furin/client` here; when omitted the directory is auto-resolved
   * next to the server artifact.
   */
  clientDir?: string;
  /**
   * Initialize the browser HTTP log drain in the hydration entry. Off by
   * default — enabling it adds `evlog/http` drain setup and points browser
   * events at `/_furin/ingest`. Server-side logging is configured via `logger`
   * and unaffected.
   */
  clientLogging?: boolean;
  logger?: FurinLoggerOptions;
  pagesDir?: string;
  /**
   * Mount prefix for this app, e.g. `"/admin"`. All pages, framework
   * endpoints (`/_furin/*`) and client assets (`/_client/*`) are served under
   * it, and the client bundle is built with the matching basePath. Defaults
   * to `""` (root). Mounting two furin instances on the same prefix throws.
   */
  prefix?: string;
  /**
   * Configures Furin's sync event stream with the required adapter. The
   * optional `streamPath` defaults to `/_furin/sync`. Omit this option or pass
   * `false` to disable sync.
   */
  sync?: FurinSyncOption;
}

/**
 * Main Furin plugin.
 *
 * Returns an Elysia plugin function. Applying the function to the parent app
 * before `listen()` lets development register Bun's native HTML bundle in the
 * initial server options while preserving Elysia's route composition.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await furin({ pagesDir: "./src/pages" }))
 *   .use(await furin({ pagesDir: "./src/admin", prefix: "/admin" }))
 *   .listen(3000)
 * ```
 */
export async function furin({
  pagesDir,
  prefix: rawPrefix,
  clientDir: explicitClientDir,
  logger,
  clientLogging,
  sync,
}: FurinOptions = {}) {
  const prefix = normalizePrefix(rawPrefix);
  const syncStreamPath = resolveSyncStreamPath(sync);
  const elysiaLoggerOptions = initializeLogger(logger);

  const cwd = process.cwd();
  // The pagesDir param drives which compile context this instance loads. In a
  // deployed binary the cwd-resolved path may miss the build-time key — the
  // lookup then falls back to the (stable) prefix, then to the sole context.
  const paramPagesDir = resolve(cwd, pagesDir ?? "src/pages");
  const ctx = getCompileContext(paramPagesDir, prefix);
  const loggerPlugin = createLoggerPlugin(
    prefix,
    syncStreamPath,
    elysiaLoggerOptions,
    clientLogging === true || ctx?.clientLogging === true
  );
  const resolvedPagesDir = ctx?.rootPath ? dirname(ctx.rootPath) : paramPagesDir;

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `furin-${prefix}-${resolvedPagesDir.replaceAll("\\", "/")}`;

  // Same prefix + different pagesDir is a mount collision — fail fast, but
  // only REGISTER right before returning so a failed mount leaves no stale
  // registration behind. All per-app runtime state (build ID, caches,
  // template, sync path) hangs off this object; requests are bound to it by
  // path in wrapWithRequestScope.
  const normalizedPagesDir = resolvedPagesDir.replaceAll("\\", "/");
  assertPrefixAvailable(prefix, normalizedPagesDir);
  const instance = createInstance(prefix, normalizedPagesDir);
  instance.syncStreamPath = syncStreamPath;

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    // Each instance gets its own generated-files dir so two mounted apps do
    // not overwrite each other's hydrate entry (root keeps plain `.furin`).
    const instanceSlug = prefix === "" ? "" : prefix.slice(1).replaceAll("/", "__");
    const furinDir = resolve(cwd, ".furin", instanceSlug);
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { registerDevPagePlugin } = await import("./server/dev-page-plugin.ts");
    registerDevPagePlugin();
    const {
      registerDevRoutesPlugin,
      registerDevRouteTopologyWatcher,
      routeModuleSpecifier,
      routeSourcePaths,
    } = await import("./plugin/routes.ts");
    const routeInstance = { pagesDir: resolvedPagesDir, prefix };
    registerDevRoutesPlugin([routeInstance]);

    // TanStack-style config auto-fix: verify each route file's `layout`
    // reference against the file-system tree and rewrite missing/misplaced
    // ones. Idempotent and content-diff safe — the watcher resynchronizes the
    // route-file signature after a rewrite, so the auto-fix cannot loop.
    const { fixRouteConfigLayout } = await import("./plugin/route-config-autofix.ts");
    const applyRouteConfigAutofix = (): boolean => {
      let changed = false;
      const sourcePaths = [
        join(resolvedPagesDir, "root.tsx"),
        ...routeSourcePaths(routeInstance),
      ].filter((sourcePath) => existsSync(sourcePath));
      for (const sourcePath of sourcePaths) {
        const source = readFileSync(sourcePath, "utf8");
        const fixed = fixRouteConfigLayout(source, sourcePath, resolvedPagesDir);
        if (fixed !== null && fixed !== source) {
          writeFileSync(sourcePath, fixed);
          changed = true;
        }
      }
      return changed;
    };
    applyRouteConfigAutofix();

    const { furinShell: nativeRoutesApp } = (await import(routeModuleSpecifier(routeInstance))) as {
      furinShell: AnyElysia;
    };
    const { root, routes } = await loadDevelopmentRoutes(resolvedPagesDir);
    let currentSnapshot = createDevelopmentRouteSnapshot(prefix, root, routes);
    nativeRouteRenderers.set(instance, (context) => currentSnapshot.render(context));

    const { writeDevFiles } = await import("./build/hydrate.ts");
    const writeCurrentDevFiles = (snapshot: DevelopmentRouteSnapshot): void => {
      writeDevFiles(
        snapshot.routes,
        {
          basePath: prefix,
          clientLogging: clientLogging ?? false,
          outDir: furinDir,
          publicPath: `${prefix}/_client/`,
          rootLayout: snapshot.root.path,
          // furin-env.d.ts is one file at the project root — only the root
          // instance owns it, otherwise mounted apps clobber each other's types.
          skipRouteTypes: prefix !== "",
        },
        cwd
      );
    };
    writeCurrentDevFiles(currentSnapshot);
    const refreshDevelopmentRoutes = async (): Promise<void> => {
      const next = await loadDevelopmentRoutes(resolvedPagesDir);
      const nextSnapshot = createDevelopmentRouteSnapshot(prefix, next.root, next.routes);
      writeCurrentDevFiles(nextSnapshot);
      invalidateStampedRouteModules();
      currentSnapshot = nextSnapshot;
    };
    const devHtmlBundle = (await import(join(furinDir, "index.html"))).default;
    const publicDir = resolve(cwd, "public");
    const publicExists = existsSync(publicDir);
    const hmrEntryPath = `${prefix}/_bun_hmr_entry`;
    let routeTopologyWatcher: ReturnType<typeof registerDevRouteTopologyWatcher> | undefined;

    // Routes registered below are LOGICAL — Elysia's `prefix` makes them
    // physical when this plugin is merged into the parent app (child prefixes
    // like staticPlugin's compose underneath).
    const devApp = new Elysia({
      name: instanceName,
      prefix: prefix || undefined,
      seed: resolvedPagesDir,
    })
      .onStart(() => {
        routeTopologyWatcher = registerDevRouteTopologyWatcher({
          instance: routeInstance,
          onRouteFilesTouched: async () => {
            applyRouteConfigAutofix();
            await refreshDevelopmentRoutes();
          },
          onTopologyChange: async () => {
            // Bun --hot cannot be triggered from generated artifacts (its
            // watch graph is the entry's static imports), so topology changes
            // are served by swapping the dispatcher's route matcher. Hot-added
            // routes then resolve through the NOT_FOUND fallback below;
            // removed routes 404 through the renderer's miss path.
            applyRouteConfigAutofix();
            await refreshDevelopmentRoutes();
          },
          pollIntervalMs: DEV_ROUTE_TOPOLOGY_POLL_INTERVAL_MS,
        });
      })
      .onStop(() => {
        routeTopologyWatcher?.close();
        routeTopologyWatcher = undefined;
      })
      // Elysia 1.4.30 only preserves Bun's native HTMLBundle handler when the
      // bundle is also present in serve.routes once request hooks are installed.
      .use(await staticPlugin({ assets: furinDir, bunFullstack: true, prefix: "/_bun_hmr_entry" }))
      .use(loggerPlugin)
      // Local scope (default) — a global hook would leak onto sibling furin
      // instances mounted on the same parent app.
      .onError(async ({ code, request, server }) => {
        if (code === "NOT_FOUND") {
          return await renderRootNotFound(currentSnapshot.root, request, server?.url.origin);
        }
      })
      .onAfterHandle(({ set }) => {
        // Forward pending revalidation paths so the client can bust its prefetch cache
        const pending = consumePendingInvalidations();
        if (pending.length > 0) {
          set.headers["x-furin-revalidate"] = pending.join(",");
        }
      })
      .use(
        publicExists ? await staticPlugin({ assets: publicDir, prefix: "/public" }) : new Elysia()
      )
      .get(
        "/favicon.ico",
        publicExists
          ? file(join(publicDir, "favicon.ico"))
          : () => new Response(null, { status: 404 })
      )
      .use(createInstrumentationPlugin(() => currentSnapshot.routes, syncStreamPath))
      .use(sync ? createSyncStreamPlugin(sync) : new Elysia())
      .use(createDataEndpoint(() => currentSnapshot.routes))
      .decorate(FURIN_RENDER_DECORATOR, dispatchNativeRoute)
      .use(nativeRoutesApp)
      .use(
        createNotFoundHandling(prefix, routes, root, async (notFoundContext) => {
          // Dev topology: try the (watcher-refreshed) native renderer before
          // the root not-found page, so hot-added routes are served without
          // a restart. Instances outside this pathname's prefix are skipped.
          const { pathname } = new URL(notFoundContext.request.url);
          if (!nativeRouteRenderers.has(resolveInstanceByPath(pathname))) {
            return;
          }
          return await dispatchNativeRoute(
            notFoundContext as unknown as Parameters<FurinRouteDispatcher>[0]
          );
        })
      );
    registerInstance(instance);
    return createFurinPlugin(devApp, (parentApp) => {
      parentApp.config.serve = {
        ...parentApp.config.serve,
        routes: {
          ...parentApp.config.serve?.routes,
          [hmrEntryPath]: devHtmlBundle,
        },
      };
    });
  }

  // ── Production ──────────────────────────────────────────────────────────
  if (!ctx) {
    throw new Error("[furin] No pre-built assets found. Run `bunx furin build` first.");
  }
  const { root, routes } = loadProdRoutes(ctx);
  const searchRoutes = createSearchRouteMetadata(routes);
  const prodBuildId = ctx.buildId ?? "";
  if (!ctx.nativeRoutes) {
    throw new Error("[furin] Production build is missing the composed Elysia route app.");
  }
  const renderNativeRoute = createNativeRouteRenderer(
    prefix,
    routes,
    root,
    prodBuildId,
    searchRoutes
  );
  nativeRouteRenderers.set(instance, renderNativeRoute);
  instance.buildId = prodBuildId;
  // Init-time writes target THIS instance explicitly — with several mounted
  // apps there is no ambient request scope to resolve it from.
  withInstance(instance, () => {
    hydrateSSGCacheFromCompileContext(ctx);
  });

  const embedded = ctx?.embedded;
  const clientDir = embedded ? "" : (explicitClientDir ?? resolveClientDirFromArgv(prefix));
  await setupProdTemplate(embedded, clientDir, instance);

  const clientAssetPrefix = `${prefix}/_client/`;
  const prodApp = new Elysia({
    name: instanceName,
    prefix: prefix || undefined,
    seed: resolvedPagesDir,
  })
    .use(loggerPlugin)
    // Local scope (default) — a global hook would leak onto sibling furin
    // instances mounted on the same parent app.
    .onError(async ({ code, request, server }) => {
      if (code === "NOT_FOUND") {
        return await renderRootNotFound(root, request, server?.url.origin);
      }
    })
    .onAfterHandle(({ path, set }) => {
      // Content-hashed client assets are permanently cacheable — browsers never need to
      // revalidate them because any change produces a new filename.
      if (path.startsWith(clientAssetPrefix)) {
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
      // Forward pending revalidation paths so the client can bust its prefetch cache
      const pending = consumePendingInvalidations();
      if (pending.length > 0) {
        set.headers["x-furin-revalidate"] = pending.join(",");
      }
      // Tell the client the current build ID so it can detect stale deploys
      if (instance.buildId) {
        set.headers["x-furin-build-id"] = instance.buildId;
      }
    })
    .onStart(async ({ server }) => {
      if (ctx.ssgCache) {
        return;
      }
      const origin = server?.url?.origin ?? "http://localhost:3000";
      // Synthetic (non-request) renders — bind them to this instance so the
      // render pipeline resolves its template/caches, not a sibling's.
      await withInstance(instance, () => warmSSGCache(routes, root, origin, searchRoutes));
    })
    .use(
      await (async () => {
        if (embedded) {
          return new Elysia()
            .get("/favicon.ico", ({ status }) => {
              const asset = embedded.assets["/public/favicon.ico"];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/_client/*", ({ params, status }) => {
              const asset = embedded.assets[`/_client/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/public/*", ({ params, status }) => {
              const asset = embedded.assets[`/public/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            });
        }
        const publicDir = join(dirname(clientDir), "public");
        const app = new Elysia();
        if (existsSync(publicDir)) {
          app
            .get("/favicon.ico", file(join(publicDir, "favicon.ico")))
            .use(await staticPlugin({ assets: publicDir, prefix: "/public" }));
        }
        app.use(await staticPlugin({ assets: clientDir, prefix: "/_client" }));
        return app;
      })()
    )
    .use(sync ? createSyncStreamPlugin(sync) : new Elysia())
    .use(createDataEndpoint(routes))
    .decorate(FURIN_RENDER_DECORATOR, dispatchNativeRoute)
    .use(ctx.nativeRoutes)
    .use(createNotFoundHandling(prefix, routes, root));
  registerInstance(instance);
  return createFurinPlugin(prodApp, undefined);
}

/**
 * 404 handling per mount position:
 *
 * - ROOT instance (`prefix === ""`): the historical `{as:"global"}`
 *   onError(NOT_FOUND) hook — it owns the root scope, and a parent `.onError`
 *   registered BEFORE `.use(furin)` still wins (documented escape hatch for
 *   JSON API 404s).
 * - PREFIXED instance: a global hook would leak onto sibling apps, and a
 *   local one never sees unmatched paths (they belong to no route). Instead
 *   the instance registers a lowest-priority catch-all under its own prefix;
 *   the router prefers every more-specific route, so this only fires for
 *   paths no page matched. Skipped when the app defines its own `[...rest]`
 *   catch-all page.
 */
function createNotFoundHandling(
  prefix: string,
  routes: Array<{ pattern: string }>,
  root: Parameters<typeof renderRootNotFound>[0],
  tryNativeDispatch?: (context: { request: Request }) => Promise<unknown>
): Elysia {
  const app = new Elysia();
  if (prefix === "") {
    app.onError({ as: "global" }, async (context) => {
      if (context.code !== "NOT_FOUND") {
        return;
      }
      // Dev topology: the native renderer is rebuilt by the watcher on route
      // add/remove, so a hot-added route (no mounted Elysia route yet) can
      // still be served here. `tryNativeDispatch` is undefined in production.
      if (tryNativeDispatch) {
        const rendered = await tryNativeDispatch(context);
        if (rendered !== undefined && rendered !== null) {
          return rendered;
        }
      }
      return await renderRootNotFound(root, context.request, context.server?.url.origin);
    });
    return app;
  }
  if (routes.some((route) => route.pattern === "/*")) {
    return app;
  }
  app.get("/*", async ({ request, server }) => {
    if (tryNativeDispatch) {
      const rendered = await tryNativeDispatch({ request });
      if (rendered !== undefined && rendered !== null) {
        return rendered;
      }
    }
    return renderRootNotFound(root, request, server?.url.origin);
  });
  return app;
}

export { FurinErrorBoundary, FurinNotFoundBoundary } from "./client/boundaries.tsx";
export { HeadContent, Scripts } from "./client/document.tsx";
// ── Public API re-export ──────────────────────────────────────────────────────
// biome-ignore-start lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
export type { DeferredData } from "./client.ts";
export { defer, isDeferred } from "./client.ts";
export type { InvalidationInput, InvalidationRule } from "./server/auto-invalidate/index.ts";
export { furinInvalidate, revalidateTag } from "./server/auto-invalidate/index.ts";
export { revalidatePath, setCachePurger } from "./server/cache/invalidation.ts";
export { buildElement, buildErrorElement, renderRootNotFound } from "./server/render/index.ts";
export {
  type FurinSyncOption,
  type FurinSyncOptions,
  furinSync,
  type SyncAdapter,
  type SyncInput,
  type SyncNotifier,
  type SyncRouteOption,
  type SyncRuntimeOptions,
} from "./server/sync/index.ts";
export { Await, useAsyncError, useAsyncValue } from "./shared/await.tsx";
export type { ErrorComponent, ErrorProps } from "./shared/error.ts";
export type {
  NotFoundComponent,
  NotFoundOptions,
  NotFoundProps,
} from "./shared/not-found.ts";
export { isNotFoundError, notFound } from "./shared/not-found.ts";
// biome-ignore-end lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
