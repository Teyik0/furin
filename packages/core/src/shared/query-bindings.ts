import type { QueryBinding, QuerySeed } from "./sync-query.ts";

export interface DeferredQueryValue {
  projection?: { value: unknown; promise: Promise<unknown> };
  value: unknown;
}

function isContainer(value: unknown): value is { [key: string]: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

/** Track returned objects by reference; computed scalars have no reliable provenance. */
export function bindQueryData(data: object, seeds: readonly QuerySeed[]): QuerySeed[] {
  return seeds.map((seed) => {
    const sources = new WeakMap<object, string[]>();
    const index = (value: unknown, path: string[]) => {
      if (!isContainer(value) || sources.has(value)) {
        return;
      }
      sources.set(value, path);
      // An array element's position does not identify an entity after an optimistic reorder.
      if (!Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
          index(child, [...path, key]);
        }
      }
    };
    index(seed.data, []);
    const bindings: QueryBinding[] = [];
    const visiting = new WeakSet<object>();
    const visit = (value: unknown, target: string[]) => {
      if (!isContainer(value) || visiting.has(value)) {
        return;
      }
      const source = sources.get(value);
      if (source) {
        bindings.push({ source, target });
        return;
      }
      visiting.add(value);
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...target, key]);
      }
      visiting.delete(value);
    };
    visit(data, []);
    return { ...seed, bindings };
  });
}

function replace(value: unknown, path: readonly string[], next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return next;
  }
  if (!(isContainer(value) && Object.hasOwn(value, key))) {
    return value;
  }
  const child = replace(value[key], rest, next);
  if (child === value[key]) {
    return value;
  }
  const copy = Array.isArray(value) ? [...value] : { ...value };
  Object.defineProperty(copy, key, {
    configurable: true,
    enumerable: true,
    value: child,
    writable: true,
  });
  return copy;
}

function isDeferredTarget(data: object, target: readonly string[]): boolean {
  const [key] = target;
  return key !== undefined && isContainer(data) && data[key] instanceof Promise;
}

export function projectQueryData<Data extends object>(
  data: Data,
  seeds: readonly QuerySeed[],
  read: (seed: QuerySeed) => unknown
): Data {
  let projected: unknown = data;
  for (const seed of seeds) {
    const snapshot = read(seed);
    if (snapshot === undefined) {
      continue;
    }
    for (const binding of seed.bindings ?? []) {
      if (isDeferredTarget(data, binding.target)) {
        continue;
      }
      let value: unknown = snapshot;
      for (const key of binding.source) {
        value = isContainer(value) && Object.hasOwn(value, key) ? value[key] : undefined;
      }
      projected = replace(projected, binding.target, value);
    }
  }
  return projected as Data;
}

export function projectDeferredQueryData<Data extends object>(
  data: Data,
  seeds: readonly QuerySeed[],
  read: (seed: QuerySeed) => unknown,
  resolved: WeakMap<Promise<unknown>, DeferredQueryValue>
): Data {
  let base: object = data;
  const deferred = new Map<string, { promise: Promise<unknown>; state: DeferredQueryValue }>();
  for (const [key, promise] of Object.entries(data)) {
    if (!(promise instanceof Promise)) {
      continue;
    }
    const state = resolved.get(promise);
    if (state) {
      deferred.set(key, { promise, state });
      base = replace(base, [key], state.value) as object;
    }
  }
  let projected: unknown = projectQueryData(base, seeds, read);
  for (const [key, { promise, state }] of deferred) {
    const value = isContainer(projected) ? projected[key] : undefined;
    if (value === state.value) {
      projected = replace(projected, [key], promise);
      continue;
    }
    if (!state.projection || state.projection.value !== value) {
      state.projection = { value, promise: Promise.resolve(value) };
    }
    projected = replace(projected, [key], state.projection.promise);
  }
  return projected as Data;
}
