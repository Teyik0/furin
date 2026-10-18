import { AsyncLocalStorage } from "node:async_hooks";
import { WeakRegistry } from "./weak-registry.ts";

// ── Furin runtime model ──────────────────────────────────────────────────────
// Each `furin({ pagesDir, prefix })` call creates one runtime. All per-app
// state (build ID, caches, template, sync path, …) hangs off it via
// `instanceSlot()` so several furin apps can be mounted in one Elysia process
// without stomping each other. Plugins bind their runtime through closures;
// render code reaches it through the request scope opened by those closures.
//
// This module is a dependency leaf with no imports from state modules. State
// modules (cache/ssg.ts, render/template.ts, …) import it to declare their
// per-instance slots — never the other way around.

export interface FurinInstance {
  buildId: string;
  /** Absolute pagesDir — also the compile-context key. */
  readonly pagesDir: string;
  /** Full physical mount prefix declared by `furin({ prefix })`, `""` for root. */
  readonly prefix: string;
  /** Generic per-instance state bag backing `instanceSlot()`. */
  readonly state: Map<symbol, unknown>;
  /** Logical durable sync path (unprefixed) injected into HTML, or undefined. */
  syncPath: string | undefined;
}

interface RuntimeScope {
  /** Whether the request is a `?_furin=data` SPA navigation data request. */
  navigationData: boolean;
  /** Runtimes composed into the application serving this request. */
  readonly peers: FurinInstance[] | undefined;
  /** Pending client-invalidation paths reported in the response. */
  readonly pending: Set<string>;
  /** Requests (original and rewritten) seen while Elysia applies its wraps. */
  readonly requests: WeakSet<Request>;
  /** Runtime with the longest prefix containing the request path, if any. */
  runtime: FurinInstance | undefined;
}

const _scope = new AsyncLocalStorage<RuntimeScope>();

const WHITESPACE_RE = /\s/;

/** Live runtimes; owning applications retain them. */
const _runtimes = new WeakRegistry<FurinInstance>();

/**
 * Bucket for code running before any runtime exists (unit tests importing
 * state modules directly, build-time rendering). Lazily created so a plain
 * `import` of a state module allocates nothing.
 */
let _defaultInstance: FurinInstance | null = null;

export function createInstance(prefix: string, pagesDir: string): FurinInstance {
  return {
    buildId: "",
    pagesDir,
    prefix,
    state: new Map(),
    syncPath: undefined,
  };
}

/** The bucket used when no runtime has been created in this process. */
export function defaultInstanceBucket(): FurinInstance {
  if (!_defaultInstance) {
    _defaultInstance = createInstance("", "");
  }
  return _defaultInstance;
}

/**
 * Normalizes a user-provided mount prefix. Accepts `""`, `"/"` (both → root)
 * or `/segment(/segment)*`. Throws on anything else so misconfiguration fails
 * at startup instead of producing silently unreachable routes.
 */
export function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "" || prefix === "/") {
    return "";
  }
  if (!prefix.startsWith("/")) {
    throw new Error(`[furin] prefix must start with "/" (got "${prefix}").`);
  }
  // Check the RAW value for "//" so "/admin//" is rejected instead of being
  // trimmed to "/admin/" — a trailing slash never matches the path-boundary
  // checks in isWithinPrefix, i.e. every route would be unreachable.
  if (prefix.includes("//") || WHITESPACE_RE.test(prefix)) {
    throw new Error(`[furin] invalid prefix "${prefix}".`);
  }
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/** Whether `pathname` lies under `prefix` on a path-segment boundary. */
export function isWithinPrefix(pathname: string, prefix: string): boolean {
  return (
    prefix === "" ||
    pathname === prefix ||
    (pathname.startsWith(prefix) && pathname.charCodeAt(prefix.length) === 47)
  );
}

/** Makes a runtime visible to process-wide helpers such as `revalidatePath()`. */
export function registerInstance(instance: FurinInstance): FurinInstance {
  _runtimes.add(instance);
  return instance;
}

export function unregisterInstance(instance: FurinInstance): void {
  _runtimes.delete(instance);
}

/**
 * Opens or refines the request scope for `runtime`. Elysia applies every
 * `.wrap()` of the composed application around the same request, outermost
 * first, before routing starts. The first Furin wrap opens the scope; later
 * ones only take ownership when their prefix is more specific, so the order in
 * which sibling plugins were mounted is irrelevant.
 */
export function enterRequestScope<T>(runtime: FurinInstance, request: Request, fn: () => T): T {
  const scope = _scope.getStore();
  const owns = isWithinPrefix(new URL(request.url).pathname, runtime.prefix);
  if (scope?.peers && scope.requests.has(request)) {
    if (!scope.peers.includes(runtime)) {
      scope.peers.push(runtime);
    }
    if (owns && (!scope.runtime || scope.runtime.prefix.length < runtime.prefix.length)) {
      scope.runtime = runtime;
    }
    return fn();
  }
  return _scope.run(
    {
      navigationData: false,
      // An in-process request issued while rendering shares its parent's
      // pending invalidations, so they still reach the parent response.
      pending: scope?.pending ?? new Set<string>(),
      peers: [runtime],
      requests: new WeakSet([request]),
      runtime: owns ? runtime : undefined,
    },
    fn
  );
}

/**
 * Gives a request served without any Furin runtime (an API app using
 * `furinSync()` or `furinInvalidate()` on its own) its pending invalidations.
 */
export function ensureRequestScope<T>(fn: () => T): T {
  if (_scope.getStore()) {
    return fn();
  }
  return _scope.run(
    {
      navigationData: false,
      pending: new Set<string>(),
      peers: undefined,
      requests: new WeakSet(),
      runtime: undefined,
    },
    fn
  );
}

/** Keeps a request rewritten by a wrap inside the scope that rewrote it. */
export function adoptScopedRequest(request: Request): void {
  _scope.getStore()?.requests.add(request);
}

/** Marks the current request as a navigation data request. */
export function markNavigationDataRequest(): void {
  const scope = _scope.getStore();
  if (scope) {
    scope.navigationData = true;
  }
}

/** Whether the current request asked for navigation data instead of a document. */
export function isNavigationDataRequest(): boolean {
  return _scope.getStore()?.navigationData === true;
}

/** Runtime whose logging options apply: the owner, else the outermost composed runtime. */
export function requestLogRuntime(): FurinInstance | undefined {
  const scope = _scope.getStore();
  return scope?.runtime ?? scope?.peers?.[0];
}

/** The runtime owning the current request or `withInstance()` call, if any. */
export function scopedInstance(): FurinInstance | undefined {
  return _scope.getStore()?.runtime;
}

/**
 * The runtime the current code runs for. Furin binds it through the request
 * scope or `withInstance()`; code without that binding only resolves to the
 * default bucket while no runtime exists, so a missing binding fails loudly
 * instead of silently reading or writing another app's state.
 */
export function currentInstance(): FurinInstance {
  const scope = _scope.getStore();
  if (scope?.runtime) {
    return scope.runtime;
  }
  if (_runtimes.values().next().done) {
    return defaultInstanceBucket();
  }
  throw new Error(
    "[furin] No Furin runtime is bound here. Runtime state is only available while a Furin route handles a request, or inside withInstance()."
  );
}

/** Runtimes composed with the current request, else every live runtime. */
export function allInstances(): FurinInstance[] {
  const peers = _scope.getStore()?.peers;
  if (peers) {
    return [...peers];
  }
  const instances = [..._runtimes.values()];
  return instances.length > 0 ? instances : [defaultInstanceBucket()];
}

/**
 * @internal Every state bucket: live runtimes plus the default bucket. Reset
 * helpers iterate this so state written before any runtime existed is covered.
 */
export function allStateBuckets(): FurinInstance[] {
  return [..._runtimes.values(), defaultInstanceBucket()];
}

/**
 * @internal test-only — forgets live runtimes while PRESERVING the default
 * bucket, so process-wide defaults installed once (e.g. a test template in
 * `beforeAll`) survive.
 */
export function __clearInstanceRegistry(): void {
  _runtimes.clear();
}

/** Pending client-invalidation paths for the current request, if any. */
export function requestPendingInvalidations(): Set<string> | undefined {
  return _scope.getStore()?.pending;
}

/**
 * Runs `fn` bound to `instance` for work that is not a live request of that
 * runtime — SSG cache warming, background ISR revalidation, watcher callbacks.
 */
export function withInstance<T>(instance: FurinInstance, fn: () => T): T {
  const scope = _scope.getStore();
  return _scope.run(
    {
      navigationData: false,
      pending: scope?.pending ?? new Set<string>(),
      peers: scope?.peers,
      requests: new WeakSet(),
      runtime: instance,
    },
    fn
  );
}

/**
 * Declares a lazily-initialized per-instance state slot. Returns an accessor
 * for an explicit runtime. This is how state modules attach caches and
 * registries to runtimes without this module importing them.
 */
export function instanceSlot<T>(
  init: (instance: FurinInstance) => T
): (instance: FurinInstance) => T {
  const key = Symbol("furin-instance-slot");
  return (instance: FurinInstance) => {
    if (instance.state.has(key)) {
      return instance.state.get(key) as T;
    }
    const value = init(instance);
    instance.state.set(key, value);
    return value;
  };
}
