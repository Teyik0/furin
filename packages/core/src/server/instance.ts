import { AsyncLocalStorage } from "node:async_hooks";
import { WeakRegistry } from "./weak-registry.ts";

// ── Furin instance model ─────────────────────────────────────────────────────
// Each `furin({ pagesDir, prefix })` call registers one instance. All
// previously module-global state (build ID, caches, template, sync path, …)
// hangs off the instance via `instanceSlot()` so several furin apps can be
// mounted in one Elysia process without stomping each other.
//
// This module is a dependency leaf with no imports from state modules. State
// modules (cache/ssg.ts, render/template.ts, …) import it to declare their
// per-instance slots — never the other way around.

export interface FurinInstance {
  buildId: string;
  /** Prefix declared by the plugin, before composition with a parent. */
  readonly declaredPrefix: string;
  /** Absolute pagesDir — also the compile-context key. */
  readonly pagesDir: string;
  /** Mount prefix, `""` for the root app or `/admin`-style (no trailing slash). */
  prefix: string;
  /** Generic per-instance state bag backing `instanceSlot()`. */
  readonly state: Map<symbol, unknown>;
  /** Logical durable sync path (unprefixed) injected into HTML, or undefined. */
  syncPath: string | undefined;
}

interface RequestScope {
  instance: FurinInstance;
  instances: ReadonlyMap<string, FurinInstance> | undefined;
  pending: Set<string>;
}

const _requestScope = new AsyncLocalStorage<RequestScope>();

const WHITESPACE_RE = /\s/;

/** Live instances; owning applications retain their runtime buckets. */
const _instances = new WeakRegistry<FurinInstance>();
const _prepared = new WeakRegistry<FurinInstance>();
const _tracked = new WeakRegistry<FurinInstance>();
const _defaultRegistry = new Map<string, FurinInstance>();

/**
 * Fallback bucket used when no instance was ever registered (unit tests
 * importing state modules directly, build-time rendering). Lazily created so
 * a plain `import` of a state module allocates nothing.
 */
let _defaultInstance: FurinInstance | null = null;

export function createInstance(prefix: string, pagesDir: string): FurinInstance {
  return {
    buildId: "",
    pagesDir,
    prefix,
    declaredPrefix: prefix,
    state: new Map(),
    syncPath: undefined,
  };
}

function defaultInstance(): FurinInstance {
  if (!_defaultInstance) {
    _defaultInstance = createInstance("", "");
  }
  return _defaultInstance;
}

/**
 * The process-wide fallback bucket. State written outside any instance scope
 * before the first `furin()` registration lands here — config-like readers
 * (e.g. the production template) treat it as a default.
 */
export function defaultInstanceBucket(): FurinInstance {
  return defaultInstance();
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
  // checks in resolveInstanceByPath, i.e. every route would be unreachable.
  if (prefix.includes("//") || WHITESPACE_RE.test(prefix)) {
    throw new Error(`[furin] invalid prefix "${prefix}".`);
  }
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/**
 * Rejects conflicting mounts in the same application. Independent servers
 * can use the same prefix without sharing runtime state.
 */
export function assertPrefixAvailable(
  prefix: string,
  pagesDir: string,
  registry?: ReadonlyMap<string, FurinInstance>
): void {
  const existing = (registry ?? _defaultRegistry).get(prefix);
  if (existing && existing.pagesDir !== pagesDir) {
    throw new Error(
      `[furin] prefix "${prefix || "/"}" is already mounted by pagesDir "${existing.pagesDir}" ` +
        `(attempted to mount "${pagesDir}"). Give each furin() instance a unique prefix.`
    );
  }
}

/** Include prepared runtime state in resets without registering a mount. */
export function trackInstance(instance: FurinInstance): void {
  _tracked.add(instance);
  _prepared.add(instance);
}

/** Registers an instance under its prefix (see assertPrefixAvailable). */
export function registerInstance(
  instance: FurinInstance,
  registry?: Map<string, FurinInstance>
): FurinInstance {
  const target = registry ?? _defaultRegistry;
  assertPrefixAvailable(instance.prefix, instance.pagesDir, target);
  const previous = target.get(instance.prefix);
  if (previous) {
    _instances.delete(previous);
  }
  target.set(instance.prefix, instance);
  _instances.add(instance);
  _prepared.delete(instance);
  _tracked.add(instance);
  return instance;
}

export function unregisterInstance(
  instance: FurinInstance,
  registry: Map<string, FurinInstance>
): void {
  for (const [prefix, mounted] of registry) {
    if (mounted === instance) {
      registry.delete(prefix);
    }
  }
  _instances.delete(instance);
  _prepared.delete(instance);
}

function availableInstances(): FurinInstance[] {
  const mounted = [..._instances.values()];
  return mounted.length > 0 ? mounted : [..._prepared.values()];
}

/**
 * Resolves the instance owning `pathname` by longest-prefix match on a path
 * boundary. Falls back to the root (`""`) instance when one is mounted, else
 * the default bucket — never an arbitrary prefixed sibling, whose template/
 * cache/build state would otherwise leak into parent-app routes.
 */
export function resolveInstanceByPath(
  pathname: string,
  registry?: ReadonlyMap<string, FurinInstance>
): FurinInstance {
  let best: FurinInstance | null = null;
  const instances = registry ?? _requestScope.getStore()?.instances;
  for (const instance of instances?.values() ?? _instances.values()) {
    const { prefix } = instance;
    if (prefix === "") {
      best ??= instance;
      continue;
    }
    if (
      (pathname === prefix ||
        (pathname.startsWith(prefix) && pathname.charCodeAt(prefix.length) === 47)) &&
      (!best || prefix.length > best.prefix.length || best.prefix === "")
    ) {
      best = instance;
    }
  }
  if (best) {
    return best;
  }
  return defaultInstance();
}

/**
 * The instance the current code runs for. Resolution order:
 * 1. request/render ALS scope, 2. sole mounted instance (or sole prepared
 * instance before any mount), 3. default bucket.
 * With ≥2 instances and no scope, state access is ambiguous — the default
 * bucket keeps out-of-request writes (e.g. build-time template setup)
 * self-consistent instead of leaking into an arbitrary app.
 */
export function currentInstance(): FurinInstance {
  const scope = _requestScope.getStore();
  if (scope) {
    return scope.instance;
  }
  const instances = availableInstances();
  const only = instances.length === 1 ? instances[0] : undefined;
  if (only) {
    return only;
  }
  return defaultInstance();
}

/** Mounted instances, or prepared instances before mounting, for invalidation. */
export function allInstances(): FurinInstance[] {
  const scoped = _requestScope.getStore()?.instances;
  if (scoped) {
    return [...scoped.values()];
  }
  const instances = availableInstances();
  if (instances.length === 0) {
    return [defaultInstance()];
  }
  return instances;
}

/**
 * @internal Every prepared state bucket: tracked instances plus the default
 * fallback bucket. Reset helpers iterate this so state written outside any
 * registration (tests, config-before-mount) is covered too.
 */
export function allStateBuckets(): FurinInstance[] {
  const buckets = [..._tracked.values()];
  const fallback = defaultInstance();
  if (!buckets.includes(fallback)) {
    buckets.push(fallback);
  }
  return buckets;
}

/**
 * @internal test-only — forgets registered instances (fresh mounts get a
 * clean registry) while PRESERVING the default bucket, so process-wide
 * defaults installed once (e.g. a test template in `beforeAll`) survive.
 */
export function __clearInstanceRegistry(): void {
  _instances.clear();
  _prepared.clear();
  _tracked.clear();
  _defaultRegistry.clear();
}

export function hasRequestScope(): boolean {
  return _requestScope.getStore() !== undefined;
}

/** Pending client-invalidation paths for the current request, if any. */
export function requestPendingInvalidations(): Set<string> | undefined {
  return _requestScope.getStore()?.pending;
}

/** Runs `fn` inside a fresh request scope bound to `instance`. */
export function runWithInstanceScope<T>(
  instance: FurinInstance,
  fn: () => T,
  instances?: ReadonlyMap<string, FurinInstance>
): T {
  return _requestScope.run(
    {
      instance,
      instances: instances ?? _requestScope.getStore()?.instances,
      pending: new Set<string>(),
    },
    fn
  );
}

/**
 * Runs `fn` bound to `instance` for synthetic (non-request) work — SSG cache
 * warming, background ISR revalidation kicked off outside a live request.
 */
export function withInstance<T>(instance: FurinInstance, fn: () => T): T {
  return runWithInstanceScope(instance, fn);
}

/**
 * Declares a lazily-initialized per-instance state slot. Returns an accessor
 * that resolves against the current instance (or an explicit one). This is
 * how state modules attach caches/registries to instances without this module
 * importing them (avoids import cycles).
 */
export function instanceSlot<T>(
  init: (instance: FurinInstance) => T
): (instance?: FurinInstance) => T {
  const key = Symbol("furin-instance-slot");
  return (instance?: FurinInstance) => {
    const target = instance ?? currentInstance();
    if (target.state.has(key)) {
      return target.state.get(key) as T;
    }
    const value = init(target);
    target.state.set(key, value);
    return value;
  };
}
