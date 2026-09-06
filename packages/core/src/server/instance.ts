import { AsyncLocalStorage } from "node:async_hooks";

// ── Furin instance model ─────────────────────────────────────────────────────
// Each `furin({ pagesDir, prefix })` call registers one instance. All
// previously module-global state (build ID, caches, template, sync path, …)
// hangs off the instance via `instanceSlot()` so several furin apps can be
// mounted in one Elysia process without stomping each other.
//
// This module is a dependency LEAF: it only imports node:async_hooks. State
// modules (cache/ssg.ts, render/template.ts, …) import it to declare their
// per-instance slots — never the other way around.

export interface FurinInstance {
  buildId: string;
  /** Absolute pagesDir — also the compile-context key. */
  readonly pagesDir: string;
  /** Mount prefix, `""` for the root app or `/admin`-style (no trailing slash). */
  readonly prefix: string;
  /** @internal Traffic epoch at registration time (see registerInstance). */
  registrationEpoch: number;
  /** Generic per-instance state bag backing `instanceSlot()`. */
  readonly state: Map<symbol, unknown>;
  /** Logical sync stream path (unprefixed) injected into HTML, or undefined. */
  syncStreamPath: string | undefined;
}

interface RequestScope {
  instance: FurinInstance;
  pending: Set<string>;
}

const _requestScope = new AsyncLocalStorage<RequestScope>();

const WHITESPACE_RE = /\s/;

/** Registered instances, keyed by prefix. */
const _instances = new Map<string, FurinInstance>();

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
    registrationEpoch: 0,
    state: new Map(),
    syncStreamPath: undefined,
  };
}

// Bumped on every served request. Lets registerInstance tell a REAL prefix
// collision (two apps composed in one startup, no traffic in between) from a
// stale registration left behind by a previous test/server in this process
// (traffic flowed since — the old mount is dead, replace it).
let _trafficEpoch = 0;

/** @internal Called by the request wrap for every served request. */
export function markTraffic(): void {
  _trafficEpoch += 1;
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
 * Throws when mounting `pagesDir` under `prefix` would collide with a LIVE
 * registration. Rules:
 * - same pagesDir → idempotent re-mount (mirrors Elysia's name-based dedup);
 * - different pagesDir, NO traffic since the existing registration → two apps
 *   composed into one server are claiming the same prefix: hard error;
 * - different pagesDir, traffic flowed since → the existing registration is a
 *   leftover from a torn-down server (tests): replacement is allowed.
 */
export function assertPrefixAvailable(prefix: string, pagesDir: string): void {
  const existing = _instances.get(prefix);
  if (existing && existing.pagesDir !== pagesDir && existing.registrationEpoch === _trafficEpoch) {
    throw new Error(
      `[furin] prefix "${prefix || "/"}" is already mounted by pagesDir "${existing.pagesDir}" ` +
        `(attempted to mount "${pagesDir}"). Give each furin() instance a unique prefix.`
    );
  }
}

/** Registers an instance under its prefix (see assertPrefixAvailable). */
export function registerInstance(instance: FurinInstance): FurinInstance {
  assertPrefixAvailable(instance.prefix, instance.pagesDir);
  instance.registrationEpoch = _trafficEpoch;
  _instances.set(instance.prefix, instance);
  return instance;
}

/**
 * Resolves the instance owning `pathname` by longest-prefix match on a path
 * boundary. Falls back to the root (`""`) instance when one is mounted, else
 * the default bucket — never an arbitrary prefixed sibling, whose template/
 * cache/build state would otherwise leak into parent-app routes.
 */
export function resolveInstanceByPath(pathname: string): FurinInstance {
  let best: FurinInstance | null = null;
  for (const [prefix, instance] of _instances) {
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
 * 1. request/render ALS scope, 2. sole registered instance, 3. default bucket.
 * With ≥2 instances and no scope, state access is ambiguous — the default
 * bucket keeps out-of-request writes (e.g. build-time template setup)
 * self-consistent instead of leaking into an arbitrary app.
 */
export function currentInstance(): FurinInstance {
  const scope = _requestScope.getStore();
  if (scope) {
    return scope.instance;
  }
  if (_instances.size === 1) {
    const only = _instances.values().next().value;
    if (only) {
      return only;
    }
  }
  return defaultInstance();
}

/** All registered instances (used by cross-instance ops like revalidateTag). */
export function allInstances(): FurinInstance[] {
  if (_instances.size === 0) {
    return [defaultInstance()];
  }
  return [..._instances.values()];
}

/**
 * @internal Every live state bucket: registered instances plus the default
 * fallback bucket. Reset helpers iterate this so state written outside any
 * registration (tests, config-before-mount) is covered too.
 */
export function allStateBuckets(): FurinInstance[] {
  const buckets = [..._instances.values()];
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
}

export function hasRequestScope(): boolean {
  return _requestScope.getStore() !== undefined;
}

/** Pending client-invalidation paths for the current request, if any. */
export function requestPendingInvalidations(): Set<string> | undefined {
  return _requestScope.getStore()?.pending;
}

/** Runs `fn` inside a fresh request scope bound to `instance`. */
export function runWithInstanceScope<T>(instance: FurinInstance, fn: () => T): T {
  return _requestScope.run({ instance, pending: new Set<string>() }, fn);
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
