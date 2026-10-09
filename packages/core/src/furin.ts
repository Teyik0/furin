import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysia/static";
import { type AnyElysia, Elysia, file, NotFound, problem } from "elysia";
import type { DrainContext, LoggerConfig, RequestLogger } from "evlog";
import { FURIN_RENDER_DECORATOR, type FurinRouteDispatcher } from "./define-route.ts";
import { createProductionAssetsPlugin } from "./server/assets/production.ts";
import { consumePendingInvalidations } from "./server/cache/invalidation.ts";
import type { PageCacheAdapter } from "./server/cache/page-cache.ts";
import { setPageCacheAdapter } from "./server/cache/page-cache-state.ts";
import { setSSGCache } from "./server/cache/ssg.ts";
import { getLogger } from "./server/context-logger.ts";
import type { DevelopmentRouteSnapshot, DevGraph } from "./server/dev/graph.ts";
import {
  createInstrumentationPlugin,
  instrumentationLoggerExclusions,
  runWithRequestInstrumentation,
  shouldInstrumentRequest,
} from "./server/devtools/instrumentation.ts";
import {
  registerRequestScopeWrapper,
  replaceFurinMountRoutes,
  requestScopeOwner,
} from "./server/elysia-owner.ts";
import { createFurinEvlog, type FurinEvlogOptions, setFurinEvlogOptions } from "./server/evlog.ts";
import {
  createInstance,
  currentInstance,
  defaultInstanceBucket,
  type FurinInstance,
  hasRequestScope,
  normalizePrefix,
  registerInstance,
  resolveInstanceByPath,
  runWithInstanceScope,
  trackInstance,
  unregisterInstance,
  withInstance,
} from "./server/instance.ts";
import type { CompileContext, EmbeddedAppData } from "./server/internal.ts";
import { getCompileContext } from "./server/internal.ts";
import { initializeFurinLogger } from "./server/logger.ts";
import { renderRootNotFound } from "./server/render/not-found.ts";
import { warmSSGCache } from "./server/render/ssg.ts";
import {
  setProductionPreloadManifest,
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "./server/render/template.ts";
import { loadProdRoutes } from "./server/router/discovery.ts";
import { invalidateStampedRouteModules, resolveCurrentDevRoute } from "./server/router/hmr.ts";
import { buildRouteMatcher } from "./server/router/patterns.ts";
import {
  renderResolvedRoute,
  renderRouteData,
  serializeGuardRedirect,
} from "./server/router/plugin.ts";
import { mergeRouteSchemas } from "./server/router/schema-merge.ts";
import {
  createSearchRouteMetadata,
  parseDataEndpointPath,
  parseRouteParams,
  parseRouteQuery,
} from "./server/router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "./server/router/types.ts";
import { IS_DEV } from "./server/runtime-env.ts";
import { type FurinSyncOption, resolveSyncPath } from "./server/sync/config.ts";
import { bindSyncValidation } from "./server/sync/validation.ts";
import { serializeInvalidationPaths } from "./shared/invalidation-header.ts";
import { physicalPath, prefixSlug } from "./shared/prefix.ts";

// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmentable via furin-env.d.ts
export interface FurinCacheTags {}

export type CacheTag = keyof FurinCacheTags extends never ? string : keyof FurinCacheTags;

async function createProductionBrowserEventsPlugin(
  sync: FurinSyncOption | undefined,
  deploymentTarget: "vercel" | undefined
): Promise<AnyElysia> {
  if (!sync) {
    return new Elysia();
  }
  const browserEvents = await import("./server/browser-events/plugin.ts");
  // Vercel invokes app.handle(Request), so Elysia's Bun.Server WebSocket upgrade is unavailable.
  return deploymentTarget === "vercel"
    ? browserEvents.createSseBrowserEventsPlugin({ sync })
    : browserEvents.createBrowserEventsPlugin({ sync });
}

function repairedDevelopmentRoutes(
  snapshot: DevelopmentRouteSnapshot,
  changedSources: readonly string[],
  graph: DevGraph<DevelopmentRouteSnapshot | null>
): { patterns: ReadonlySet<string>; root: boolean } {
  const patterns = new Set<string>();
  for (const route of snapshot.routes) {
    if (
      changedSources.some(
        (sourcePath) => route.path === sourcePath || graph.dependsOn(route.path, sourcePath)
      )
    ) {
      patterns.add(route.pattern);
    }
  }
  return {
    patterns,
    root: changedSources.some(
      (sourcePath) =>
        snapshot.root.path === sourcePath || graph.dependsOn(snapshot.root.path, sourcePath)
    ),
  };
}

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
export { type FurinCspOptions, furinCsp } from "./server/security/csp.ts";
export { clientDirNameForPrefix } from "./shared/prefix.ts";

const MAX_BROWSER_INGEST_BYTES = 64 * 1024;
const MAX_BROWSER_INGEST_EVENTS = 100;
const TRAILING_SLASH_RE = /\/$/;
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
    const clientDir = join(dirname(absolute), dirName);
    if (existsSync(join(clientDir, "index.html"))) {
      return clientDir;
    }
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate, dirName);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string, dirName: string): string | null {
  const pathEntries = process.env.PATH?.split(delimiter) ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      const clientDir = join(dirname(fullPath), dirName);
      if (existsSync(join(clientDir, "index.html"))) {
        return clientDir;
      }
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

function createLoggerOptions(
  prefix: string,
  syncPath: string | undefined,
  logger: FurinEvlogOptions | undefined
): FurinEvlogOptions {
  const { exclude: userExclude, ...evlogOptions } = logger ?? {};
  return {
    ...evlogOptions,
    // Exclude patterns match the PHYSICAL request path — prefix them.
    exclude: [
      `${prefix}/_client/**`,
      `${prefix}/public/**`,
      `${prefix}/favicon.ico`,
      `${prefix}/_bun_hmr_entry/**`,
      ...instrumentationLoggerExclusions(prefix),
      ...(syncPath ? [`${prefix}${syncPath}/**`] : []),
      // Note: /_furin/data is logged with the logical page path, so SPA navigations
      // appear as "GET /board/123 200" — same shape as a normal SSR nav.
      // /_furin/ingest remains loggable when browser logging is explicitly
      // enabled so browser-side events show up.
      // evlog's `matchesPattern` only supports `*`, `**`, `?` — extglob
      // like `!(...)` matches nothing, so don't add patterns relying on it.
      ...(userExclude ?? []),
    ],
  };
}

/** Evlog wide-event plugin + browser log ingest endpoint for one instance. */
function createLoggerPlugin(
  instance: FurinInstance,
  prefix: string,
  syncPath: string | undefined,
  logger: FurinEvlogOptions | undefined,
  clientLogging: boolean
) {
  const options = createLoggerOptions(prefix, syncPath, logger);
  setFurinEvlogOptions(instance, options);
  const app = new Elysia().use(createFurinEvlog(options));

  if (!clientLogging) {
    return app;
  }

  return app.post("/_furin/ingest", { parse: "none" }, async ({ log, request, status }) => {
    const parsed = await readBrowserIngest(request);
    if (parsed.kind === "oversized") {
      return problem(413, { detail: "Browser event payload exceeds 64 KiB." });
    }
    if (parsed.kind === "invalid") {
      return problem("Bad Request", { detail: "Browser event payload must be valid JSON." });
    }
    const { body } = parsed;
    if (!Array.isArray(body)) {
      return problem("Bad Request", { detail: "Browser event payload must be a JSON array." });
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
  }) as unknown as Elysia;
}

function initializeLogger(logger: FurinLoggerOptions | undefined): FurinEvlogOptions {
  const { sampling, ...elysiaLoggerOptions } = logger ?? {};
  initializeFurinLogger({
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
const navigationDataRequests = new WeakSet<Request>();
const navigationDataRefreshers = new WeakMap<FurinInstance, () => Promise<void>>();
const navigationDataMatchers = new WeakMap<FurinInstance, (path: string) => boolean>();
type RequestScopeWrapper = Parameters<AnyElysia["wrap"]>[0];
const requestScopeRegistries = new WeakMap<RequestScopeWrapper, Map<string, FurinInstance>>();

interface FurinMount {
  anchor: { handler: unknown; method: string; path: string } | undefined;
  app: AnyElysia;
  cleanup: readonly ((app: AnyElysia) => unknown)[];
  createRuntime: () => Promise<FurinMount>;
  hasSync: boolean;
  hmrPrefix: string | undefined;
  hoc: readonly RequestScopeWrapper[];
  instance: FurinInstance;
  logger: FurinEvlogOptions | undefined;
  setup: readonly ((app: AnyElysia) => unknown)[];
}

const furinMountMarkers = new WeakMap<object, FurinMount>();
const mountOwners = new WeakMap<FurinMount, { owner: WeakRef<AnyElysia>; prefix: string }>();
const ownerMounts = new WeakMap<AnyElysia, Map<FurinMount, Map<string, FurinMount>>>();
const preparingOwners = new WeakMap<AnyElysia, Promise<void>>();
const preparedOwners = new WeakMap<AnyElysia, { routes: readonly unknown[]; length: number }>();
const finalInstances = new WeakMap<AnyElysia, Map<string, FurinInstance>>();

function composedMounts(app: AnyElysia): { mount: FurinMount; prefix: string }[] {
  const mounts: { mount: FurinMount; prefix: string }[] = [];
  for (const route of app.routes) {
    const hooks = route.hooks?.beforeHandle;
    if (!hooks) {
      continue;
    }
    for (const hook of Array.isArray(hooks) ? hooks : [hooks]) {
      const mount = furinMountMarkers.get(hook);
      if (
        mount?.anchor &&
        route.method === mount.anchor.method &&
        route.handler === mount.anchor.handler &&
        route.path.endsWith(mount.anchor.path)
      ) {
        mounts.push({
          mount,
          prefix: normalizePrefix(
            `${route.path.slice(0, -mount.anchor.path.length)}${mount.instance.declaredPrefix}`
          ),
        });
      }
    }
  }
  return mounts;
}

function prepareFinalMounts(app: AnyElysia): Promise<void> | undefined {
  const pending = preparingOwners.get(app);
  if (pending) {
    return pending;
  }
  const declared = Reflect.get(app, "declaredRoutes") as readonly unknown[] | undefined;
  const prepared = preparedOwners.get(app);
  if (declared && prepared?.routes === declared && prepared.length === declared.length) {
    return;
  }
  let mounts = ownerMounts.get(app);
  if (!mounts) {
    mounts = new Map();
    ownerMounts.set(app, mounts);
  }
  const initialize: { source: FurinMount; prefix: string; mounted: Map<string, FurinMount> }[] = [];
  for (const { mount: source, prefix } of composedMounts(app)) {
    let mounted = mounts.get(source);
    if (!mounted) {
      mounted = new Map();
      mounts.set(source, mounted);
    }
    if (mounted.has(prefix)) {
      continue;
    }
    const claimed = mountOwners.get(source);
    if (!claimed || (claimed.owner.deref() === app && claimed.prefix === prefix)) {
      mountOwners.set(source, { owner: new WeakRef(app), prefix });
      source.instance.prefix = prefix;
      mounted.set(prefix, source);
    } else {
      initialize.push({ source, prefix, mounted });
    }
  }
  if (!initialize.length) {
    const routes = Reflect.get(app, "declaredRoutes") as readonly unknown[];
    preparedOwners.set(app, { routes, length: routes.length });
    return;
  }
  const task = (async () => {
    for (const { source, prefix, mounted } of initialize) {
      // biome-ignore lint/performance/noAwaitInLoops: mounts write shared generated files; initialize them sequentially.
      const fresh = await source.createRuntime();
      fresh.instance.prefix = prefix;
      mountOwners.set(fresh, { owner: new WeakRef(app), prefix });
      const parentPrefix = source.instance.declaredPrefix
        ? prefix.slice(0, -source.instance.declaredPrefix.length)
        : prefix;
      replaceFurinMountRoutes(app, source.app, fresh.app, parentPrefix);
      mounted.set(prefix, fresh);
    }
    const routes = Reflect.get(app, "declaredRoutes") as readonly unknown[];
    preparedOwners.set(app, { routes, length: routes.length });
  })();
  preparingOwners.set(app, task);
  return task.finally(() => preparingOwners.delete(app));
}

function finalMountRegistry(app: AnyElysia): Map<string, FurinInstance> {
  const instances = finalInstances.get(app) ?? new Map<string, FurinInstance>();
  finalInstances.set(app, instances);
  instances.clear();
  for (const { mount, prefix } of composedMounts(app)) {
    const { instance } = mount;
    instance.prefix = prefix;
    setFurinEvlogOptions(
      instance,
      createLoggerOptions(instance.prefix, instance.syncPath, mount.logger)
    );
    registerInstance(instance, instances);
  }
  return instances;
}

/** Whether a request targets a registered page in the specified Furin mount. */
export function isFurinPageRequest(request: Request, prefix: string): boolean {
  if (request.method !== "GET") {
    return false;
  }
  const url = new URL(request.url);
  const { pathname } = url;
  const mountPrefix = normalizePrefix(prefix);
  const instance = resolveInstanceByPath(pathname);
  if (instance.prefix !== mountPrefix && instance.declaredPrefix !== mountPrefix) {
    return false;
  }
  const path = pathname.slice(instance.prefix.length) || "/";
  if (path === "/_furin/data") {
    const dataPath = parseDataEndpointPath(url.searchParams.get("path") ?? "");
    return (
      dataPath !== undefined && (navigationDataMatchers.get(instance)?.(dataPath.pathname) ?? false)
    );
  }
  if (
    path.startsWith("/_client/") ||
    path.startsWith("/_furin/") ||
    path.startsWith("/_bun_hmr_entry") ||
    path.startsWith("/public/") ||
    path === "/favicon.ico"
  ) {
    return false;
  }
  return navigationDataMatchers.get(instance)?.(path) ?? false;
}

function rewriteNavigationDataRequest(
  request: Request,
  instance: FurinInstance
): Request | Response {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== `${instance.prefix}/_furin/data`) {
    return request;
  }
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return new Response("Missing required query param: path", { status: 400 });
  }
  const parsed = parseDataEndpointPath(rawPath);
  if (!parsed) {
    return new Response("Invalid path", { status: 400 });
  }
  if (!navigationDataMatchers.get(instance)?.(parsed.pathname)) {
    return new Response("Not Found", { status: 404 });
  }
  url.pathname = physicalPath(instance.prefix, parsed.pathname);
  url.search = parsed.url.search;
  const rewritten = new Request(url, request);
  navigationDataRequests.add(rewritten);
  return rewritten;
}

function wrapWithRequestScope(app: AnyElysia, instances: Map<string, FurinInstance>): AnyElysia {
  // Elysia invokes HOC factories as hoc[index](fetch). Resolve the final
  // composition's registries before logging or any request middleware runs.
  const wrap: RequestScopeWrapper = function (this: readonly RequestScopeWrapper[], fetch) {
    const owner = requestScopeOwner(this);
    const composed = owner ? finalMountRegistry(owner) : new Map<string, FurinInstance>();
    const wrappers = Array.isArray(this) ? this : [wrap];
    for (const wrapper of owner ? [] : wrappers) {
      for (const instance of requestScopeRegistries.get(wrapper)?.values() ?? []) {
        registerInstance(instance, composed);
      }
    }
    return (request, ...rest) => {
      const { pathname } = new URL(request.url);
      const instance = resolveInstanceByPath(pathname, composed);
      if (
        hasRequestScope() &&
        (instance === defaultInstanceBucket() ||
          (currentInstance() !== defaultInstanceBucket() &&
            currentInstance().prefix.length >= instance.prefix.length))
      ) {
        return fetch(request, ...rest);
      }
      return runWithInstanceScope(
        instance,
        () => {
          const dispatch = () => {
            const rewritten = rewriteNavigationDataRequest(request, instance);
            if (rewritten instanceof Response) {
              return rewritten;
            }
            const response = shouldInstrumentRequest(pathname, instance.prefix)
              ? runWithRequestInstrumentation(request, () => fetch(rewritten, ...rest))
              : fetch(rewritten, ...rest);
            if (rewritten === request) {
              return response;
            }
            return Promise.resolve(response).then((resolved) =>
              resolved.status >= 300 && resolved.status < 400
                ? serializeGuardRedirect(resolved, request)
                : resolved
            );
          };
          const dataPath =
            pathname === `${instance.prefix}/_furin/data`
              ? parseDataEndpointPath(new URL(request.url).searchParams.get("path") || "")
              : undefined;
          const refresh =
            pathname === `${instance.prefix}/_furin/data` &&
            request.method === "GET" &&
            dataPath !== undefined &&
            navigationDataMatchers.get(instance)?.(dataPath.pathname) === true &&
            request.headers.get("x-furin-hmr-refresh") === "1"
              ? navigationDataRefreshers.get(instance)
              : undefined;
          return refresh ? refresh().then(dispatch) : dispatch();
        },
        composed
      );
    };
  };
  registerRequestScopeWrapper(wrap, prepareFinalMounts);
  requestScopeRegistries.set(wrap, instances);
  return app.wrap(wrap);
}

const applicationInstances = new WeakMap<AnyElysia, Map<string, FurinInstance>>();

type FurinApplication<App extends AnyElysia> =
  App extends Elysia<
    infer Prefix,
    infer Scope,
    infer Singleton,
    infer Definitions,
    infer Metadata,
    infer Routes,
    infer Ephemeral,
    infer Volatile
  >
    ? Elysia<
        Prefix,
        Scope,
        {
          decorator: Singleton["decorator"];
          derive: Singleton["derive"] & { log: RequestLogger };
          store: Singleton["store"];
        },
        Definitions,
        Metadata,
        Routes,
        Ephemeral,
        Volatile
      >
    : never;

function disableNativeHmrHooks(app: AnyElysia, entryPath: string): void {
  const routes = Reflect.get(app, "~routes") as
    | [string, string, unknown, unknown, unknown, unknown, unknown?][]
    | undefined;
  for (const route of routes ?? []) {
    if (route[0] === "GET" && (route[1] === entryPath || route[1] === `${entryPath}/index.html`)) {
      // Bun serves these HTML bundles natively; inherited hooks cannot run.
      route[6] = undefined;
    }
  }
}

function createFurinMount(
  app: AnyElysia,
  instance: FurinInstance,
  hmrPrefix: string | undefined,
  hasSync: boolean,
  createRuntime: () => Promise<FurinMount>,
  loggerOptions: FurinEvlogOptions
): FurinMount {
  const marker = () => undefined;
  const anchor = app.routes.find((route) => typeof route.handler === "function");
  const extension = Reflect.get(app, "~ext") as {
    cleanup?: ((app: AnyElysia) => unknown)[];
    hoc?: RequestScopeWrapper[];
    setup?: ((app: AnyElysia) => unknown)[];
  };
  const mount: FurinMount = {
    anchor,
    app,
    cleanup: extension.cleanup?.slice() ?? [],
    createRuntime,
    hasSync,
    hmrPrefix,
    hoc: extension.hoc?.slice() ?? [],
    instance,
    logger: loggerOptions,
    setup: extension.setup?.slice() ?? [],
  };
  if (anchor) {
    furinMountMarkers.set(marker, mount);
  }
  mount.app = new Elysia().beforeHandle(marker).use(app);
  return mount;
}

function createFurinPlugin(mount: FurinMount) {
  const { app, hasSync, hmrPrefix, instance } = mount;
  let used = false;
  const extension = Reflect.get(app, "~ext") as {
    cleanup?: ((app: AnyElysia) => unknown)[];
    hoc?: RequestScopeWrapper[];
    setup?: ((app: AnyElysia) => unknown)[];
  };
  if (mount.anchor) {
    if (extension.hoc) {
      extension.hoc = mount.hoc.map(
        (original, index) =>
          function (this: readonly RequestScopeWrapper[], fetch) {
            const owner = requestScopeOwner(this);
            const handlers = new WeakMap<FurinInstance, typeof fetch>();
            return (request, ...rest) => {
              const runtime = owner ? ownerMounts.get(owner)?.get(mount)?.values() : undefined;
              const scopedInstance = currentInstance();
              const selected =
                [...(runtime ?? [])].find((candidate) => candidate.instance === scopedInstance) ??
                mount;
              let handler = handlers.get(selected.instance);
              if (!handler) {
                handler = (selected.hoc[index] ?? original)(fetch);
                handlers.set(selected.instance, handler);
              }
              return handler(request, ...rest);
            };
          }
      );
    }
    const lifecycle = (owner: AnyElysia, phase: "setup" | "cleanup") => {
      const execute = () => {
        let running: Promise<void> | undefined;
        const invoke = (callback: () => unknown) => {
          if (running) {
            running = running.then(callback).then(() => undefined);
          } else {
            const result = callback();
            if (result instanceof Promise) {
              running = result.then(() => undefined);
            }
          }
        };
        for (const runtime of ownerMounts.get(owner)?.get(mount)?.values() ?? []) {
          for (const callback of runtime[phase]) {
            invoke(() => callback(owner));
          }
          if (phase === "cleanup") {
            invoke(() => {
              unregisterInstance(runtime.instance, finalInstances.get(owner) ?? new Map());
              const initial = applicationInstances.get(owner);
              if (initial) {
                unregisterInstance(runtime.instance, initial);
              }
            });
          }
        }
        return running;
      };
      const pending = prepareFinalMounts(owner);
      return pending ? pending.then(execute) : execute();
    };
    app.setup((owner) => lifecycle(owner, "setup"));
    app.cleanup((owner) => lifecycle(owner, "cleanup"));
    const ownedExtension = Reflect.get(app, "~ext") as typeof extension;
    ownedExtension.setup?.splice(0, mount.setup.length);
    ownedExtension.cleanup?.splice(0, mount.cleanup.length);
  }
  const plugin = <ParentApp extends AnyElysia>(
    parentApp: ParentApp
  ): FurinApplication<ParentApp> => {
    // The mounted evlog plugin contributes only log; preserve the parent's
    // native route, schema and macro types instead of merging AnyElysia.
    const result: unknown = parentApp;
    let instances = applicationInstances.get(parentApp);
    if (!instances) {
      instances = new Map();
      applicationInstances.set(parentApp, instances);
      wrapWithRequestScope(parentApp, instances);
    }
    if (used) {
      parentApp.use(mount.createRuntime().then(createFurinPlugin));
      return result as FurinApplication<ParentApp>;
    }
    used = true;
    const parentConfig = Reflect.get(parentApp, "~config") as { prefix?: string } | undefined;
    instance.prefix = normalizePrefix(`${parentConfig?.prefix ?? ""}${instance.declaredPrefix}`);
    registerInstance(instance, instances);
    if (hasSync) {
      bindSyncValidation(parentApp);
    }
    parentApp.use(app);
    if (hmrPrefix !== undefined) {
      const entryPath = `${parentConfig?.prefix ?? ""}${hmrPrefix}/_bun_hmr_entry`;
      disableNativeHmrHooks(parentApp, entryPath);
    }
    return result as FurinApplication<ParentApp>;
  };
  return plugin;
}

async function loadDevelopmentRoutes(resolvedPagesDir: string) {
  const { scanPages } = await import("./server/router/discovery.ts");
  return scanPages(resolvedPagesDir);
}

function matchesNativeRoute(
  context: Parameters<FurinRouteDispatcher>[0],
  prefix: string,
  pattern: string
): context is Parameters<FurinRouteDispatcher>[0] & {
  params: { [key: string]: unknown };
} {
  return (
    context.params !== null &&
    typeof context.params === "object" &&
    typeof context.route === "string" &&
    context.route.replace(TRAILING_SLASH_RE, "") ===
      physicalPath(prefix, pattern).replace(TRAILING_SLASH_RE, "")
  );
}

function parseRendererParams(
  context: Parameters<FurinRouteDispatcher>[0],
  prefix: string,
  route: ResolvedRoute,
  matchedParams: { [key: string]: string }
) {
  const nativeParams = matchesNativeRoute(context, prefix, route.pattern)
    ? context.params
    : undefined;
  // Dev's schema-free route shell must validate against the current snapshot.
  // Production's native route has already validated and decoded its schema.
  return !IS_DEV && nativeParams
    ? Promise.resolve({ ok: true as const, params: nativeParams })
    : parseRouteParams(
        nativeParams ?? matchedParams,
        mergeRouteSchemas(route.routeChain, "params")
      );
}

function createNativeRouteRenderer(
  routes: ResolvedRoute[],
  root: RootLayout,
  buildId: string,
  searchRoutes: ReturnType<typeof createSearchRouteMetadata>
): FurinRouteDispatcher {
  const matchNativeRoute = buildRouteMatcher(routes);
  return async (context) => {
    const { prefix } = currentInstance();
    const { request } = context;
    const requestUrl = new URL(request.url);
    const { pathname } = requestUrl;
    const hasPrefix = pathname === prefix || pathname.startsWith(`${prefix}/`);
    const logicalPath = hasPrefix ? pathname.slice(prefix.length) : pathname;
    const matched = matchNativeRoute(logicalPath || "/");
    if (!matched || (IS_DEV && !existsSync(matched.route.path))) {
      // Dev topology swap: the mounted Elysia route can outlive its source
      // file (hot-remove). Render the root not-found page instead of failing.
      const listenerOrigin = (context.server as { url?: { origin: string } } | undefined)?.url
        ?.origin;
      return renderRootNotFound(root, request, listenerOrigin);
    }
    const parsedParams = await parseRendererParams(context, prefix, matched.route, matched.params);
    if (!parsedParams.ok) {
      return problem(422, { detail: "Invalid params", errors: parsedParams.errors });
    }
    const parsedQuery = await parseRouteQuery(
      requestUrl,
      mergeRouteSchemas(matched.route.routeChain, "query")
    );
    if (!parsedQuery.ok) {
      return problem(422, { detail: "Invalid query", errors: parsedQuery.errors });
    }
    context.params = parsedParams.params;
    context.query = parsedQuery.query;
    if (navigationDataRequests.has(request)) {
      getLogger().set({
        path: (logicalPath || "/") + requestUrl.search,
        routePattern: matched.route.pattern,
      });
      const current = IS_DEV
        ? await resolveCurrentDevRoute(matched.route, root)
        : { root, route: matched.route };
      return renderRouteData(
        current.route,
        context as unknown as Parameters<typeof renderRouteData>[1],
        current.root,
        searchRoutes,
        logicalPath + requestUrl.search
      );
    }
    return renderResolvedRoute(
      matched.route,
      context as unknown as Parameters<typeof renderResolvedRoute>[1],
      root,
      buildId,
      searchRoutes
    );
  };
}

function createDevelopmentRouteSnapshot(
  root: RootLayout,
  routes: ResolvedRoute[]
): DevelopmentRouteSnapshot {
  const searchRoutes = createSearchRouteMetadata(routes);
  return {
    render: createNativeRouteRenderer(routes, root, "", searchRoutes),
    root,
    routes,
  };
}

const nativeRouteRenderers = new WeakMap<FurinInstance, FurinRouteDispatcher>();

function dispatchNativeRoute(context: Parameters<FurinRouteDispatcher>[0]): unknown {
  const { pathname } = new URL(context.request.url);
  const renderer = nativeRouteRenderers.get(currentInstance());
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
export type FurinLoggerOptions = FurinEvlogOptions & Pick<LoggerConfig, "sampling">;

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
  /**
   * Cache for public page artifacts. Use a distributed adapter when several
   * replicas serve the same application. When omitted, Furin keeps its
   * process-local cache.
   */
  pageCache?: PageCacheAdapter;
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
   * optional `path` defaults to `/_furin/sync`. Omit this option or pass
   * `false` to disable sync.
   */
  sync?: FurinSyncOption;
}

function configurePageCache(
  instance: FurinInstance,
  ctx: CompileContext | null,
  pageCache: PageCacheAdapter | undefined
): void {
  if (pageCache !== undefined && ctx?.deploymentTarget === "vercel") {
    throw new Error(
      "[furin] pageCache cannot be configured with the Vercel target. Vercel owns SSG, ISR, and PPR public caching."
    );
  }
  if (pageCache !== undefined) {
    setPageCacheAdapter(instance, pageCache);
  }
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
export async function furin(options?: FurinOptions) {
  return createFurinPlugin(await createFurinRuntime(options === undefined ? {} : options));
}

async function createFurinRuntime({
  pagesDir,
  prefix: rawPrefix,
  clientDir: explicitClientDir,
  logger,
  clientLogging,
  pageCache,
  sync,
}: FurinOptions): Promise<FurinMount> {
  const prefix = normalizePrefix(rawPrefix);
  const syncPath = resolveSyncPath(sync);
  const elysiaLoggerOptions = initializeLogger(logger);

  const cwd = process.cwd();
  // The pagesDir param drives which compile context this instance loads. In a
  // deployed binary the cwd-resolved path may miss the build-time key — the
  // lookup then falls back to the (stable) prefix, then to the sole context.
  const paramPagesDir = resolve(cwd, pagesDir ?? "src/pages");
  const ctx = getCompileContext(paramPagesDir, prefix);
  const resolvedPagesDir = ctx?.rootPath ? dirname(ctx.rootPath) : paramPagesDir;

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `furin-${prefix}-${resolvedPagesDir.replaceAll("\\", "/")}`;

  // Same prefix + different pagesDir is a mount collision — fail fast, but
  // only REGISTER right before returning so a failed mount leaves no stale
  // registration behind. All per-app runtime state (build ID, caches,
  // template, sync path) hangs off this object; requests are bound to it by
  // path in wrapWithRequestScope.
  const normalizedPagesDir = resolvedPagesDir.replaceAll("\\", "/");
  const instance = createInstance(prefix, normalizedPagesDir);
  trackInstance(instance);
  instance.syncPath = syncPath;
  configurePageCache(instance, ctx, pageCache);
  const loggerPlugin = createLoggerPlugin(
    instance,
    prefix,
    syncPath,
    elysiaLoggerOptions,
    clientLogging === true || ctx?.clientLogging === true
  );
  const mountOptions: FurinOptions = {
    clientDir: explicitClientDir,
    clientLogging,
    logger,
    pageCache,
    pagesDir: resolvedPagesDir,
    prefix,
    sync,
  };
  const development = IS_DEV;
  const app = new Elysia({
    name: instanceName,
    prefix: prefix || undefined,
    seed: resolvedPagesDir,
  });
  let nativeRoutes: AnyElysia;
  let notFoundHandling: Elysia;
  let hmrPrefix: string | undefined;
  const requestHooks = (getRoot: () => RootLayout) => (application: typeof app) =>
    application
      .use(loggerPlugin)
      // Local scope keeps hooks isolated from sibling Furin mounts.
      .error(NotFound, async ({ request, server }) =>
        renderRootNotFound(getRoot(), request, server?.url.origin)
      )
      .afterHandle(({ set }) => {
        const pending = consumePendingInvalidations();
        if (pending.length > 0) {
          set.headers["x-furin-revalidate"] = serializeInvalidationPaths(pending);
        }
        if (!development && instance.buildId) {
          set.headers["x-furin-build-id"] = instance.buildId;
        }
      });

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (development) {
    hmrPrefix = prefix;
    // Each instance gets its own generated-files dir so two mounted apps do
    // not overwrite each other's hydrate entry (root keeps plain `.furin`).
    const instanceSlug = prefix === "" ? "" : prefixSlug(prefix);
    const furinDir = resolve(cwd, ".furin", instanceSlug);
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { devDiagnosticStore, publishDevDiagnostic } = await import(
      "./server/dev/diagnostics.ts"
    );
    const { devGraph, releaseDevGraph } = await import("./server/dev/graph.ts");
    const { createDevDiagnosticPlugin } = await import("./server/dev/plugin.ts");
    const { createDevelopmentBrowserEventSources } = await import("./server/dev/browser-events.ts");
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
        let source: string;
        try {
          source = readFileSync(sourcePath, "utf8");
        } catch (error) {
          console.warn(
            `[furin] Could not read ${sourcePath} for route config autofix: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }
        const fixed = fixRouteConfigLayout(source, sourcePath, resolvedPagesDir);
        if (fixed !== null && fixed !== source) {
          writeFileSync(sourcePath, fixed);
          changed = true;
        }
      }
      return changed;
    };
    applyRouteConfigAutofix();

    const graph = devGraph(instance);
    const { nativeRoutesApp, root, routes } = await withInstance(instance, async () => {
      const { furinShell } = (await import(routeModuleSpecifier(routeInstance))) as {
        furinShell: AnyElysia;
      };
      const loaded = await loadDevelopmentRoutes(resolvedPagesDir);
      return { nativeRoutesApp: furinShell, ...loaded };
    });
    nativeRoutes = nativeRoutesApp;
    const initialSnapshot = createDevelopmentRouteSnapshot(root, routes);
    const currentSnapshot = (): DevelopmentRouteSnapshot => graph.snapshot ?? initialSnapshot;
    nativeRouteRenderers.set(instance, (context) => currentSnapshot().render(context));
    let matchNavigationData = buildRouteMatcher(initialSnapshot.routes);
    navigationDataMatchers.set(instance, (path) => matchNavigationData(path) !== null);

    const { writeDevFiles } = await import("./build/hydrate.ts");
    const { discoverClientBoundaries, registerServerBoundaries } = await import(
      "./rsc/build/discover.ts"
    );
    const { routeModuleSourceVersion } = await import("./server/router/source-version.ts");
    const { LINK_MODULE_PATH } = await import("./build/shared.ts");
    const { getHmrDataSignature } = await import("./plugin/transform-client.ts");
    let serverSourceVersion = 0;
    let serverDataSignatures = new Map<string, string>();
    let serverSourcePaths: string | undefined;
    const writeCurrentDevFiles = async (
      snapshot: DevelopmentRouteSnapshot,
      changedSources: readonly string[]
    ): Promise<void> => {
      const paths = [
        ...new Set([
          snapshot.root.path,
          ...snapshot.routes.flatMap((route) => [
            route.path,
            ...route.routeChain.flatMap((entry) => (entry.sourcePath ? [entry.sourcePath] : [])),
          ]),
        ]),
      ].toSorted();
      const clientBoundaries = await discoverClientBoundaries(paths, undefined);
      await registerServerBoundaries([
        ...clientBoundaries,
        ...clientBoundaries
          .filter(
            ({ path }) =>
              path !== LINK_MODULE_PATH.replaceAll("\\", "/") && !path.includes("/node_modules/")
          )
          .map((boundary) => ({
            ...boundary,
            path: `${boundary.path}?furin-server&t=${routeModuleSourceVersion(boundary.path)}`,
          })),
      ]);
      const nextPaths = JSON.stringify(paths);
      const nextSignatures = new Map(
        paths.map((path) => {
          let signature: string;
          try {
            signature = getHmrDataSignature(readFileSync(path, "utf8"), path);
            if (signature.startsWith("external:")) {
              signature = graph.sourceVersion(path);
            }
          } catch {
            // A broken route still needs a client entry for its diagnostic.
            signature = graph.sourceVersion(path);
          }
          return [path, signature] as const;
        })
      );
      // Route additions/removals already update the native client manifest.
      // Rebase their signature without issuing a second data invalidation.
      const changedPaths = new Set(changedSources);
      const importsChanged = paths.some(
        (path) =>
          !changedPaths.has(path) && serverDataSignatures.get(path) !== nextSignatures.get(path)
      );
      if (importsChanged && serverSourcePaths === nextPaths) {
        serverSourceVersion += 1;
      }
      serverSourcePaths = nextPaths;
      serverDataSignatures = nextSignatures;
      writeDevFiles(
        snapshot.routes,
        {
          basePath: prefix,
          clientLogging: clientLogging ?? false,
          clientBoundaries,
          outDir: furinDir,
          publicPath: `${prefix}/_client/`,
          rootLayout: snapshot.root.path,
          // furin-env.d.ts is one file at the project root — only the root
          // instance owns it, otherwise mounted apps clobber each other's types.
          skipRouteTypes: prefix !== "",
        },
        cwd,
        String(serverSourceVersion)
      );
    };
    await writeCurrentDevFiles(initialSnapshot, []);
    graph.commit(initialSnapshot);
    const hmrEntry = (await import(join(furinDir, "index.html"))).default;
    const refreshDevelopmentRoutes = (changedSources: readonly string[]): Promise<void> =>
      withInstance(instance, async () => {
        invalidateStampedRouteModules();
        try {
          const previousSnapshot = currentSnapshot();
          const repaired = repairedDevelopmentRoutes(previousSnapshot, changedSources, graph);
          const next = await loadDevelopmentRoutes(resolvedPagesDir);
          // Retain tags only for routes whose current module could not be loaded.
          const nextRoutes = next.routes.map((route) =>
            route.routeChain.length > 0
              ? route
              : {
                  ...route,
                  tags: previousSnapshot.routes.find((previous) => previous.path === route.path)
                    ?.tags,
                }
          );
          const nextSnapshot = createDevelopmentRouteSnapshot(next.root, nextRoutes);
          await writeCurrentDevFiles(nextSnapshot, changedSources);
          graph.commit(nextSnapshot);
          matchNavigationData = buildRouteMatcher(nextSnapshot.routes);
          const diagnostics = devDiagnosticStore(instance);
          if (repaired.root) {
            diagnostics.markReady("*");
          }
          for (const pattern of repaired.patterns) {
            if (diagnostics.markReady(pattern)) {
              break;
            }
          }
        } catch (error) {
          publishDevDiagnostic(error, {
            entryPath: join(resolvedPagesDir, "root.tsx"),
            phase: "import",
            route: "*",
          });
          throw error;
        }
      });
    const publicDir = resolve(cwd, "public");
    const publicExists = existsSync(publicDir);
    let routeTopologyWatcher: ReturnType<typeof registerDevRouteTopologyWatcher> | undefined;
    navigationDataRefreshers.set(instance, async () => {
      await routeTopologyWatcher?.refresh();
    });

    // Routes registered below are LOGICAL — Elysia's `prefix` makes them
    // physical when this plugin is merged into the parent app (child prefixes
    // like staticPlugin's compose underneath).
    app
      .setup((owner) => {
        routeTopologyWatcher = registerDevRouteTopologyWatcher({
          instance: routeInstance,
          owner: { app: owner.server ?? owner, prefix: instance.prefix },
          onRouteFilesTouched: async (sourcePaths) => {
            applyRouteConfigAutofix();
            await refreshDevelopmentRoutes(sourcePaths);
          },
          onSourceError: (error, sourcePath) => {
            const route = currentSnapshot().routes.find((candidate) =>
              graph.dependsOn(candidate.path, sourcePath)
            );
            withInstance(instance, () =>
              publishDevDiagnostic(error, {
                entryPath: route ? route.path : sourcePath,
                phase: "transform",
                route: route ? route.pattern : "*",
              })
            );
          },
          onTopologyChange: async (sourcePaths) => {
            // Bun --hot cannot be triggered from generated artifacts (its
            // watch graph is the entry's static imports), so topology changes
            // are served by swapping the dispatcher's route matcher. Hot-added
            // routes then resolve through the NOT_FOUND fallback below;
            // removed routes 404 through the renderer's miss path.
            applyRouteConfigAutofix();
            await refreshDevelopmentRoutes(sourcePaths);
          },
        });
      })
      .cleanup(() => {
        releaseDevGraph(instance);
        routeTopologyWatcher?.close();
        routeTopologyWatcher = undefined;
        navigationDataRefreshers.delete(instance);
        navigationDataMatchers.delete(instance);
      })
      .get("/_bun_hmr_entry/index.html", hmrEntry)
      .get("/_bun_hmr_entry", hmrEntry)
      .use(requestHooks(() => currentSnapshot().root))
      .use(
        publicExists ? await staticPlugin({ assets: publicDir, prefix: "/public" }) : new Elysia()
      )
      .get(
        "/favicon.ico",
        publicExists
          ? file(join(publicDir, "favicon.ico"))
          : () => new Response(null, { status: 404 })
      )
      .use(
        (await import("./server/browser-events/plugin.ts")).createBrowserEventsPlugin({
          sources: createDevelopmentBrowserEventSources(instance, devDiagnosticStore(instance)),
          sync: sync || undefined,
        })
      )
      .use(
        createDevDiagnosticPlugin(devDiagnosticStore(instance), instance, async () => {
          await routeTopologyWatcher?.refresh();
        })
      )
      .use(createInstrumentationPlugin(() => currentSnapshot().routes, syncPath));
    notFoundHandling = createNotFoundHandling(prefix, routes, root, async (notFoundContext) => {
      // Dev topology: try the (watcher-refreshed) native renderer before
      // the root not-found page, so hot-added routes are served without
      // a restart. Instances outside this pathname's prefix are skipped.
      if (!nativeRouteRenderers.has(currentInstance())) {
        return;
      }
      return await dispatchNativeRoute(
        notFoundContext as unknown as Parameters<FurinRouteDispatcher>[0]
      );
    });
  } else {
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
    const renderNativeRoute = createNativeRouteRenderer(routes, root, prodBuildId, searchRoutes);
    nativeRouteRenderers.set(instance, renderNativeRoute);
    const matchNavigationData = buildRouteMatcher(routes);
    navigationDataMatchers.set(instance, (path) => matchNavigationData(path) !== null);
    instance.buildId = prodBuildId;
    // Init-time writes target THIS instance explicitly — with several mounted
    // apps there is no ambient request scope to resolve it from.
    withInstance(instance, () => {
      hydrateSSGCacheFromCompileContext(ctx);
    });

    const embedded = ctx?.embedded;
    const clientDir =
      embedded?.clientDir ?? explicitClientDir ?? ctx.clientDir ?? resolveClientDirFromArgv(prefix);
    await setupCompiledTemplate(ctx, embedded, clientDir, instance);

    app
      .use(requestHooks(() => root))
      .setup(async ({ server }) => {
        if (ctx.ssgCache) {
          return;
        }
        const origin = server?.url?.origin ?? "http://localhost:3000";
        // Synthetic (non-request) renders — bind them to this instance so the
        // render pipeline resolves its template/caches, not a sibling's.
        await withInstance(instance, () => warmSSGCache(routes, root, origin, searchRoutes));
      })
      .use(await createProductionAssetsPlugin(ctx, embedded, clientDir))
      .use(await createProductionBrowserEventsPlugin(sync, ctx?.deploymentTarget));
    ({ nativeRoutes } = ctx);
    notFoundHandling = createNotFoundHandling(prefix, routes, root);
  }

  return createFurinMount(
    app
      .use(
        sync
          ? (await import("./server/sync/stream.ts")).createSyncChangesPlugin(sync)
          : new Elysia()
      )
      .decorate(FURIN_RENDER_DECORATOR, dispatchNativeRoute)
      .use(nativeRoutes)
      .use(notFoundHandling),
    instance,
    hmrPrefix,
    Boolean(sync),
    () => createFurinRuntime(mountOptions),
    elysiaLoggerOptions
  );
}

/**
 * 404 handling per mount position:
 *
 * - ROOT instance (`prefix === ""`): a global `NotFound` handler owns the root
 *   scope, and a parent `.error()`
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
  const dispatch =
    tryNativeDispatch ??
    (routes.some((route) => route.pattern === "/*")
      ? async (context: { request: Request }): Promise<unknown> => {
          if (context.request.method !== "GET") {
            return;
          }
          return await dispatchNativeRoute(context as Parameters<FurinRouteDispatcher>[0]);
        }
      : undefined);
  if (prefix === "") {
    app.error("global", NotFound, async (context) => {
      // Dev topology: the native renderer is rebuilt by the watcher on route
      // add/remove, so a hot-added route (no mounted Elysia route yet) can
      // still be served here. Production also renders root catch-all pages here.
      if (dispatch) {
        const rendered = await dispatch(context);
        if (rendered !== undefined && rendered !== null) {
          return rendered;
        }
      }
      return await renderRootNotFound(root, context.request, context.server?.url.origin);
    });
    return app;
  }
  app.get("/*", async (context) => {
    if (dispatch) {
      const rendered = await dispatch(context);
      if (rendered !== undefined && rendered !== null) {
        return rendered;
      }
    }
    return renderRootNotFound(root, context.request, context.server?.url.origin);
  });
  return app;
}

export { FurinErrorBoundary, FurinNotFoundBoundary } from "./client/boundaries.tsx";
export { HeadContent, Scripts } from "./client/document.tsx";
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
// ── Public API re-export ──────────────────────────────────────────────────────
// biome-ignore-start lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
export { type DeferredData, defer, isDeferred } from "./shared/defer.ts";
export type { ErrorComponent, ErrorProps } from "./shared/error.ts";
export type {
  NotFoundComponent,
  NotFoundOptions,
  NotFoundProps,
} from "./shared/not-found.ts";
export { isNotFoundError, notFound } from "./shared/not-found.ts";
// biome-ignore-end lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
