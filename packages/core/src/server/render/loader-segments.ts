import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { isDeferred } from "../../shared/defer.ts";
import type { SerializedRouteMatch } from "../../shared/route-matches.ts";
import { getLogger } from "../context-logger.ts";
import { isDevelopment } from "../instance.ts";

const FURIN_RESERVED_KEY_PREFIX = "__furin";
/**
 * Loader data keys that the render pipeline overwrites with request-context
 * values when assembling component props — a loader field with one of these
 * names is silently dead on arrival.
 */
const ROUTE_CTX_RESERVED_KEYS = new Set([
  "catch",
  "children",
  "finally",
  "key",
  "params",
  "path",
  "query",
  "ref",
  "then",
  "toJSON",
]);

export function assertPublicLoaderKey(key: string): void {
  if (key.startsWith(FURIN_RESERVED_KEY_PREFIX)) {
    throw new Error(
      `[furin] Loader data key "${key}" is reserved for framework metadata. Rename this field to avoid conflicts.`
    );
  }
  if (ROUTE_CTX_RESERVED_KEYS.has(key)) {
    throw new Error(
      `[furin] Loader data key "${key}" is reserved: it is overwritten by the route context when component props are assembled. Rename this field to avoid conflicts.`
    );
  }
}

/**
 * Splits a single loader result into sync scalars and deferred Promises.
 *
 * A loader result is considered "deferred" only when wrapped with `defer()`
 * (i.e. carries the internal deferred brand). A loader that returned a plain
 * object keeps all its values in sync — even if some happen to be Promises —
 * preserving the long-standing semantic that only an explicit `defer()` opts
 * into streaming.
 */
export function splitOneLoaderResult(result: RuntimeData): {
  sync: RuntimeData;
  deferred: Record<string, Promise<unknown>>;
} {
  const sync: RuntimeData = {};
  const deferred: Record<string, Promise<unknown>> = {};
  const isDef = isDeferred(result);
  for (const [key, value] of Object.entries(result)) {
    assertPublicLoaderKey(key);
    if (isDef && isPromiseLike(value)) {
      deferred[key] = Promise.resolve(value);
    } else {
      sync[key] = value;
    }
  }
  return { deferred, sync };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface SegmentData {
  deferred: Record<string, Promise<unknown>>;
  sync: RuntimeData;
}

export const NO_SEGMENT_DATA: SegmentData = { deferred: {}, sync: {} };

/**
 * Flattens per-segment loader data (root → page) into the page's sync and
 * deferred maps, where later segments overwrite earlier ones on key collision,
 * and serializes one success match per segment.
 *
 * Cross-map cleanup: when a later segment contributes a key, drop any stale
 * entry from the opposite map so the wire never carries two values for it.
 *
 * A match names the flat key holding each of its fields. When a deeper segment
 * overwrote a field, the segment's own value moves to a `__furinMatch` slot so
 * its layout still receives it. Request fields are referenced by name: their
 * promises are attached (or postponed by PPR) after the public loaders run.
 */
export function flattenSegments(
  segments: SegmentData[],
  requestKeys: string[][] | undefined
): {
  allDeferred: Record<string, Promise<unknown>>;
  allSync: RuntimeData;
  matches: SerializedRouteMatch[];
} {
  const allSync: RuntimeData = {};
  const allDeferred: Record<string, Promise<unknown>> = {};
  for (const { sync, deferred } of segments) {
    for (const k of Object.keys(sync)) {
      delete allDeferred[k];
    }
    for (const k of Object.keys(deferred)) {
      delete allSync[k];
    }
    Object.assign(allSync, sync);
    Object.assign(allDeferred, deferred);
  }
  const matches = segments.map(({ sync, deferred }, index): SerializedRouteMatch => {
    const fields: { [field: string]: string } = {};
    for (const [values, flat] of [
      [sync, allSync],
      [deferred, allDeferred],
    ] as const) {
      for (const [field, value] of Object.entries(values)) {
        if (Object.is(flat[field], value)) {
          fields[field] = field;
        } else {
          const slot = `__furinMatch${index}:${field}`;
          (flat as RuntimeData)[slot] = value;
          fields[field] = slot;
        }
      }
    }
    for (const field of requestKeys?.[index] ?? []) {
      fields[field] ??= field;
    }
    return { fields, status: "success" };
  });
  return { allDeferred, allSync, matches };
}

export function mergeParentData(parent: RuntimeData, own: RuntimeData, path: string): RuntimeData {
  if (isDevelopment()) {
    for (const key of Object.keys(own)) {
      if (Object.hasOwn(parent, key)) {
        getLogger().warn(
          `[furin] Loader data collision on "${key}" for ${path}: a deeper loader overwrites the value inherited from its layout chain (deepest wins).`
        );
      }
    }
  }
  return { ...parent, ...own };
}
