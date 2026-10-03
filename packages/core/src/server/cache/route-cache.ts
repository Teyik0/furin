export type RevalidateType = "page" | "layout";

export interface CacheInvalidationResult {
  deleted: boolean;
  purgedPaths: string[];
}

export interface CacheGeneration {
  valid: boolean;
}

export interface Cache<Entry> {
  captureGeneration: (key: string) => CacheGeneration;
  clear: () => void;
  delete: (key: string) => boolean;
  entries: () => IterableIterator<[string, Entry]>;
  get: (key: string) => Entry | undefined;
  has: (key: string) => boolean;
  invalidatePath: (path: string, type: RevalidateType) => CacheInvalidationResult;
  keys: () => IterableIterator<string>;
  readonly name: string;
  releaseGeneration: (key: string, generation: CacheGeneration) => void;
  set: (key: string, entry: Entry) => void;
  get size(): number;
  readonly store: Map<string, Entry>;
}

export interface RouteCacheOptions<Entry> {
  maxSize?: number;
  name: string;
  onDelete?: (key: string, entry: Entry) => void;
  onSet?: (key: string, entry: Entry, previous: Entry | undefined) => void;
  pathFromKey?: (key: string) => string | null;
}

function defaultPathFromKey(key: string): string {
  return key;
}

export function pathWithoutSearch(path: string): string {
  const searchStart = path.indexOf("?");
  if (searchStart === -1) {
    return path;
  }
  return path.slice(0, searchStart);
}

export function pathWithRequestSearch(path: string, requestUrl: string): string {
  const { search } = new URL(requestUrl);
  return `${pathWithoutSearch(path)}${search}`;
}

function matchesPath(urlPath: string, path: string, type: RevalidateType): boolean {
  if (type === "page") {
    return urlPath === path;
  }
  const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
  return urlPath === path || urlPath.startsWith(prefix);
}

export function createRouteCache<Entry>(options: RouteCacheOptions<Entry>): Cache<Entry> {
  const store = new Map<string, Entry>();
  const generations = new Map<string, Set<CacheGeneration>>();
  const pathFromKey = options.pathFromKey ?? defaultPathFromKey;

  const invalidateGenerations = (key: string): void => {
    for (const generation of generations.get(key) ?? []) {
      generation.valid = false;
    }
    generations.delete(key);
  };

  const evictOldest = (): void => {
    if (options.maxSize === undefined || store.size <= options.maxSize) {
      return;
    }
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      deleteEntry(oldest);
    }
  };

  const deleteEntry = (key: string): boolean => {
    invalidateGenerations(key);
    const entry = store.get(key);
    if (entry === undefined) {
      return false;
    }
    store.delete(key);
    options.onDelete?.(key, entry);
    return true;
  };

  return {
    captureGeneration(key) {
      const generation = { valid: true };
      let pending = generations.get(key);
      if (pending === undefined) {
        pending = new Set();
        generations.set(key, pending);
      }
      pending.add(generation);
      return generation;
    },
    clear() {
      for (const key of generations.keys()) {
        invalidateGenerations(key);
      }
      for (const key of [...store.keys()]) {
        deleteEntry(key);
      }
      store.clear();
    },
    delete(key) {
      return deleteEntry(key);
    },
    entries() {
      return store.entries();
    },
    get(key) {
      const entry = store.get(key);
      if (entry !== undefined && options.maxSize !== undefined) {
        store.delete(key);
        store.set(key, entry);
      }
      return entry;
    },
    has(key) {
      return store.has(key);
    },
    invalidatePath(path, type) {
      let deleted = false;
      const purgedPaths: string[] = [];

      for (const key of new Set([...store.keys(), ...generations.keys()])) {
        const urlPath = pathFromKey(key);
        if (urlPath === null || !matchesPath(urlPath, path, type)) {
          continue;
        }
        if (deleteEntry(key)) {
          deleted = true;
          purgedPaths.push(urlPath);
        }
      }

      return { deleted, purgedPaths: [...new Set(purgedPaths)] };
    },
    keys() {
      return store.keys();
    },
    name: options.name,
    releaseGeneration(key, generation) {
      const pending = generations.get(key);
      pending?.delete(generation);
      if (pending?.size === 0) {
        generations.delete(key);
      }
    },
    set(key, entry) {
      const previous = store.get(key);
      if (previous !== undefined) {
        store.delete(key);
      }
      store.set(key, entry);
      options.onSet?.(key, entry, previous);
      evictOldest();
    },
    get size() {
      return store.size;
    },
    store,
  };
}
