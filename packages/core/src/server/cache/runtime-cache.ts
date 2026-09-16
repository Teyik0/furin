export interface RuntimeCacheOptions {
  namespace?: string;
}

export interface RuntimeCacheSetOptions {
  name?: string;
  tags?: string[];
  ttl?: number;
}

export interface RuntimeCache {
  delete: (key: string) => Promise<void>;
  expireTag: (tag: string | string[]) => Promise<void>;
  get: (key: string) => Promise<unknown | null>;
  set: (key: string, value: unknown, options?: RuntimeCacheSetOptions) => Promise<void>;
}

export interface RuntimeCacheProvider {
  getCache: (options: RuntimeCacheOptions | undefined) => RuntimeCache;
}

interface MemoryEntry {
  expiresAt: number | undefined;
  tags: Set<string>;
  value: unknown;
}

interface RuntimeCacheState {
  memoryProvider: RuntimeCacheProvider;
  provider: RuntimeCacheProvider;
}

const RUNTIME_CACHE_STATE = Symbol.for("@teyik0/furin/runtime-cache-state");

function createMemoryProvider(): RuntimeCacheProvider {
  const namespaces = new Map<string, Map<string, MemoryEntry>>();
  return {
    getCache(options) {
      const namespace = options?.namespace ?? "";
      let entries = namespaces.get(namespace);
      if (entries === undefined) {
        entries = new Map();
        namespaces.set(namespace, entries);
      }
      return {
        delete(key) {
          entries.delete(key);
          return Promise.resolve();
        },
        expireTag(tag) {
          const tags = new Set(Array.isArray(tag) ? tag : [tag]);
          for (const namespaceEntries of namespaces.values()) {
            for (const [key, entry] of namespaceEntries) {
              if (!entry.tags.isDisjointFrom(tags)) {
                namespaceEntries.delete(key);
              }
            }
          }
          return Promise.resolve();
        },
        get(key) {
          const entry = entries.get(key);
          if (entry === undefined) {
            return Promise.resolve(null);
          }
          if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
            entries.delete(key);
            return Promise.resolve(null);
          }
          return Promise.resolve(entry.value);
        },
        set(key, value, setOptions) {
          entries.set(key, {
            expiresAt:
              setOptions?.ttl === undefined ? undefined : Date.now() + setOptions.ttl * 1000,
            tags: new Set(setOptions?.tags ?? []),
            value,
          });
          return Promise.resolve();
        },
      };
    },
  };
}

function runtimeCacheState(): RuntimeCacheState {
  const existing = Reflect.get(globalThis, RUNTIME_CACHE_STATE);
  if (existing !== undefined) {
    return existing as RuntimeCacheState;
  }
  const memoryProvider = createMemoryProvider();
  const state: RuntimeCacheState = { memoryProvider, provider: memoryProvider };
  Reflect.set(globalThis, RUNTIME_CACHE_STATE, state);
  return state;
}

export function getCache(options?: RuntimeCacheOptions): RuntimeCache {
  let activeCache: RuntimeCache | undefined;
  let activeProvider: RuntimeCacheProvider | undefined;
  const resolveCache = (): RuntimeCache => {
    const { provider } = runtimeCacheState();
    if (activeCache === undefined || activeProvider !== provider) {
      activeCache = provider.getCache(options);
      activeProvider = provider;
    }
    return activeCache;
  };
  return {
    delete: (key) => resolveCache().delete(key),
    expireTag: (tag) => resolveCache().expireTag(tag),
    get: (key) => resolveCache().get(key),
    set: (key, value, setOptions) => resolveCache().set(key, value, setOptions),
  };
}

export function setRuntimeCacheProvider(provider: RuntimeCacheProvider): void {
  runtimeCacheState().provider = provider;
}

export function resetRuntimeCacheProvider(): void {
  const state = runtimeCacheState();
  state.provider = state.memoryProvider;
}
