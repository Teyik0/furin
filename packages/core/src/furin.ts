import { dirname, resolve } from "node:path";
import { type AnyElysia, Elysia, NotFound } from "elysia";
import type { RequestLogger } from "evlog";
import { FURIN_RENDER_DECORATOR, type FurinNativeRouteContext } from "./define-route.ts";
import { consumePendingInvalidations } from "./server/cache/invalidation.ts";
import type { PageCacheAdapter } from "./server/cache/page-cache.ts";
import { setPageCacheAdapter } from "./server/cache/page-cache-state.ts";
import {
  type CachePurger,
  setInstanceCachePurger,
  setInstanceCacheTagPurger,
} from "./server/cache/purger.ts";
import {
  createInstance,
  type FurinInstance,
  normalizePrefix,
  registerInstance,
  unregisterInstance,
} from "./server/instance.ts";
import { type CompileContext, getCompileContext } from "./server/internal.ts";
import { createLoggerPlugin, type FurinLoggerOptions } from "./server/logging/ingest-plugin.ts";
import type { ModeOptions, ModeRuntime } from "./server/mode.ts";
import { createProdRuntime } from "./server/prod/runtime.ts";
import { recordFurinRegistration } from "./server/registrations.ts";
import { createNotFoundHandling } from "./server/render/not-found-plugin.ts";
import {
  createRequestScope,
  dispatchNativeRoute,
  renderNotFound,
} from "./server/router/dispatch.ts";
import { IS_DEV } from "./server/runtime-env.ts";
import { type FurinSyncOption, resolveSyncPath } from "./server/sync/config.ts";
import { bindSyncValidation } from "./server/sync/validation.ts";
import { serializeInvalidationPaths } from "./shared/invalidation-header.ts";

// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmentable via furin-env.d.ts
export interface FurinCacheTags {}

export type CacheTag = keyof FurinCacheTags extends never ? string : keyof FurinCacheTags;

// biome-ignore lint/performance/noBarrelFile: furin.ts is the public package entry
export {
  type DefineRouteConfig,
  defineRootRoute,
  defineRoute,
  type FurinLayoutRoute,
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
export type { FurinLoggerOptions } from "./server/logging/ingest-plugin.ts";
export { isFurinPageRequest } from "./server/router/dispatch.ts";
export { type FurinCspOptions, furinCsp } from "./server/security/csp.ts";

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

/** Options for the {@link furin} plugin. */
export interface FurinOptions {
  /**
   * CDN purge hook for this app. Receives the physical (prefixed) paths that
   * `revalidatePath()` and `revalidateTag()` invalidate. Takes precedence over
   * the process-wide `setCachePurger()`.
   */
  cachePurger?: CachePurger;
  /**
   * CDN purge hook for this app's semantic cache tags. Receives the tags passed
   * to `revalidateTag()`. Takes precedence over the tag purger installed by
   * the deployment adapter (e.g. Vercel). Runtimes sharing one purger get a
   * single call per `revalidateTag()`.
   */
  cacheTagPurger?: CachePurger;
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
   * Full physical mount path of this app, e.g. `"/admin"`. All pages,
   * framework endpoints (`/_furin/*`) and client assets (`/_client/*`) are
   * served under it, and the client bundle is built with it as basePath.
   * Defaults to `""` (root). Mount Furin on an Elysia instance without a
   * prefix: under `new Elysia({ prefix: "/outer" })`, declare
   * `furin({ prefix: "/outer/admin" })` on an unprefixed child instead.
   * Mounting two furin instances on the same prefix throws.
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
  if (pageCache !== undefined && ctx?.adapter?.capabilities.publicCache === "platform") {
    throw new Error(
      `[furin] pageCache cannot be configured with the ${JSON.stringify(ctx.adapter.name)} adapter: its platform caches public SSG, ISR, and PPR pages.`
    );
  }
  if (pageCache !== undefined) {
    setPageCacheAdapter(instance, pageCache);
  }
}

/** Runtimes started by each composed application, by prefix. */
const startedRuntimes = new WeakMap<AnyElysia, Map<string, FurinInstance>>();

function assertMountedPrefix(instance: FurinInstance, app: AnyElysia, owner: AnyElysia): void {
  const anchor = app.routes.find((route) => typeof route.handler === "function");
  const mounted =
    anchor &&
    owner.routes.find(
      (route) =>
        route.method === anchor.method &&
        route.handler === anchor.handler &&
        route.path.endsWith(anchor.path)
    );
  if (!(anchor && mounted) || mounted.path === anchor.path) {
    return;
  }
  const found = normalizePrefix(
    `${mounted.path.slice(0, mounted.path.length - anchor.path.length)}${instance.prefix}`
  );
  throw new Error(
    `[furin] furin({ prefix: ${JSON.stringify(instance.prefix)} }) is served at ${JSON.stringify(found)}. The prefix is build-time configuration (the client bundle is built for it), so it must be the full physical path: when mounting under a prefixed parent, repeat the parent prefix in furin({ prefix: ${JSON.stringify(found)} }) and mount Furin on an Elysia instance without a prefix.`
  );
}

/** The application currently serving each runtime. */
const servingOwners = new WeakMap<FurinInstance, AnyElysia>();

function trackStartedRuntime(instance: FurinInstance, owner: AnyElysia): void {
  const serving = servingOwners.get(instance);
  if (serving && serving !== owner) {
    throw new Error(
      "[furin] This furin() runtime is already served by another Elysia application. Each plugin owns one runtime (caches, build ID, watchers): call furin() again for each application."
    );
  }
  servingOwners.set(instance, owner);
  const runtimes = startedRuntimes.get(owner) ?? new Map<string, FurinInstance>();
  startedRuntimes.set(owner, runtimes);
  const existing = runtimes.get(instance.prefix);
  if (existing && existing !== instance) {
    throw new Error(
      `[furin] prefix "${instance.prefix || "/"}" is already mounted by pagesDir "${existing.pagesDir}" (attempted to mount "${instance.pagesDir}"). Give each furin() instance a unique prefix.`
    );
  }
  runtimes.set(instance.prefix, instance);
}

async function createFurinApp(options: FurinOptions): Promise<{
  app: AnyElysia;
  hasSync: boolean;
  instance: FurinInstance;
}> {
  const {
    cachePurger,
    cacheTagPurger,
    clientDir,
    clientLogging,
    logger,
    pageCache,
    pagesDir,
    sync,
  } = options;
  const prefix = normalizePrefix(options.prefix);
  const cwd = process.cwd();
  // In a deployed binary the cwd-resolved pagesDir may differ from the build
  // machine's; the compile context is found by the (stable) declared prefix.
  const paramPagesDir = resolve(cwd, pagesDir ?? "src/pages");
  const ctx = getCompileContext(paramPagesDir, prefix);
  const resolvedPagesDir = ctx?.rootPath ? dirname(ctx.rootPath) : paramPagesDir;
  const normalizedPagesDir = resolvedPagesDir.replaceAll("\\", "/");

  // All per-app runtime state (build ID, caches, template, sync path) hangs
  // off this object; the plugin's closures bind requests to it.
  const instance = createInstance(prefix, normalizedPagesDir);
  instance.syncPath = resolveSyncPath(sync);
  const loggerPlugin = createLoggerPlugin(
    instance,
    logger,
    clientLogging === true || ctx?.clientLogging === true
  );
  configurePageCache(instance, ctx, pageCache);
  setInstanceCachePurger(instance, cachePurger);
  setInstanceCacheTagPurger(instance, cacheTagPurger);
  registerInstance(instance);

  const development = IS_DEV;
  const modeOptions: ModeOptions = {
    clientLogging,
    requestHooks: (runtimeApp) =>
      (runtimeApp as Elysia)
        .use(loggerPlugin)
        // Local scope keeps hooks isolated from sibling Furin mounts.
        .onError(NotFound, (context) =>
          renderNotFound(instance, context as unknown as FurinNativeRouteContext)
        )
        .onAfterHandle(({ set }) => {
          const pending = consumePendingInvalidations();
          if (pending.length > 0) {
            set.headers["x-furin-revalidate"] = serializeInvalidationPaths(pending);
          }
          if (!development && instance.buildId) {
            set.headers["x-furin-build-id"] = instance.buildId;
          }
        }),
    sync: sync || undefined,
  };
  const mode: ModeRuntime = development
    ? await (await import("./server/dev/runtime.ts")).createDevRuntime(
        instance,
        resolvedPagesDir,
        modeOptions
      )
    : await createProdRuntime(instance, ctx, clientDir, modeOptions);

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const app: AnyElysia = new Elysia({
    name: `furin-${prefix}-${normalizedPagesDir}`,
    prefix: prefix || undefined,
    seed: resolvedPagesDir,
  })
    .wrap(createRequestScope(instance))
    .onStart((owner) => {
      assertMountedPrefix(instance, app, owner);
      trackStartedRuntime(instance, owner);
    })
    .onStop((owner) => {
      startedRuntimes.get(owner)?.delete(instance.prefix);
      if (servingOwners.get(instance) === owner) {
        servingOwners.delete(instance);
        unregisterInstance(instance);
      }
    })
    .use(mode.plugins)
    .use(
      sync ? (await import("./server/sync/stream.ts")).createSyncChangesPlugin(sync) : new Elysia()
    )
    .decorate(FURIN_RENDER_DECORATOR, dispatchNativeRoute)
    .use(mode.nativeRoutes)
    .use(createNotFoundHandling(instance));
  return { app, hasSync: Boolean(sync), instance };
}

/** Parent applications and the prefixes their Furin plugins claim. */
const mountedPrefixes = new WeakMap<AnyElysia, Map<string, FurinInstance>>();

/**
 * Main Furin plugin.
 *
 * Returns an Elysia plugin function for exactly one application. Applying the
 * function to the parent app before `listen()` lets development register
 * Bun's native HTML bundle in the initial server options while preserving
 * Elysia's route composition.
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
  const registration = {
    pagesDir: options?.pagesDir ?? "src/pages",
    prefix: normalizePrefix(options?.prefix),
  };
  if (recordFurinRegistration(registration)) {
    // The build only discovers mounts: no runtime, nothing to mount.
    return <ParentApp extends AnyElysia>(parentApp: ParentApp) =>
      parentApp as unknown as FurinApplication<ParentApp>;
  }
  const { app, hasSync, instance } = await createFurinApp(options ?? {});
  let mounted = false;
  return <ParentApp extends AnyElysia>(parentApp: ParentApp): FurinApplication<ParentApp> => {
    if (mounted) {
      throw new Error(
        "[furin] This furin() plugin is already mounted. Each plugin owns one runtime (caches, build ID, watchers): call furin() again for each application."
      );
    }
    const prefixes = mountedPrefixes.get(parentApp) ?? new Map<string, FurinInstance>();
    const existing = prefixes.get(instance.prefix);
    if (existing) {
      throw new Error(
        `[furin] prefix "${instance.prefix || "/"}" is already mounted by pagesDir "${existing.pagesDir}" (attempted to mount "${instance.pagesDir}"). Give each furin() instance a unique prefix.`
      );
    }
    mounted = true;
    prefixes.set(instance.prefix, instance);
    mountedPrefixes.set(parentApp, prefixes);
    if (hasSync) {
      bindSyncValidation(parentApp);
    }
    // The mounted evlog plugin contributes only log; preserve the parent's
    // native route, schema and macro types instead of merging AnyElysia.
    return parentApp.use(app) as unknown as FurinApplication<ParentApp>;
  };
}

export { FurinErrorBoundary, FurinNotFoundBoundary } from "./client/boundaries.tsx";
export { HeadContent, Scripts } from "./client/document.tsx";
export type { InvalidationInput, InvalidationRule } from "./server/auto-invalidate/index.ts";
export { furinInvalidate, revalidateTag } from "./server/auto-invalidate/index.ts";
export { revalidatePath, setCachePurger } from "./server/cache/invalidation.ts";
export { buildErrorElement, renderRootNotFound } from "./server/render/index.ts";
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
