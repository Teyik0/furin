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

const MAX_MEMORY_ENTRIES = 1000;

interface MemoryEntry {
  expirationIndex?: number;
  expiresAt: number | undefined;
  key: string;
  namespace: string;
  tags: Set<string>;
  value: unknown;
}

interface ExpiringEntry extends MemoryEntry {
  expiresAt: number;
}

class ExpirationHeap {
  private readonly entries: ExpiringEntry[] = [];

  takeExpired(now: number): ExpiringEntry | undefined {
    const [entry] = this.entries;
    if (entry === undefined || entry.expiresAt > now) {
      return;
    }
    this.delete(entry);
    return entry;
  }

  add(entry: MemoryEntry): void {
    if (entry.expiresAt === undefined || !Number.isFinite(entry.expiresAt)) {
      return;
    }
    entry.expirationIndex = this.entries.length;
    this.entries.push(entry as ExpiringEntry);
    this.repair(entry.expirationIndex);
  }

  delete(entry: MemoryEntry): void {
    const index = entry.expirationIndex;
    if (index === undefined) {
      return;
    }
    const last = this.entries.pop() as ExpiringEntry;
    entry.expirationIndex = undefined;
    if (last !== entry) {
      this.entries[index] = last;
      last.expirationIndex = index;
      this.repair(index);
    }
  }

  private swap(left: number, right: number): void {
    const first = this.entries[left] as ExpiringEntry;
    const second = this.entries[right] as ExpiringEntry;
    this.entries[left] = second;
    this.entries[right] = first;
    second.expirationIndex = left;
    first.expirationIndex = right;
  }

  private repair(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (
        (this.entries[parent] as ExpiringEntry).expiresAt <=
        (this.entries[index] as ExpiringEntry).expiresAt
      ) {
        break;
      }
      this.swap(parent, index);
      index = parent;
    }
    while (index * 2 + 1 < this.entries.length) {
      const left = index * 2 + 1;
      const right = this.entries[left + 1];
      const child =
        right && right.expiresAt < (this.entries[left] as ExpiringEntry).expiresAt
          ? left + 1
          : left;
      if (
        (this.entries[index] as ExpiringEntry).expiresAt <=
        (this.entries[child] as ExpiringEntry).expiresAt
      ) {
        break;
      }
      this.swap(index, child);
      index = child;
    }
  }
}

interface RuntimeCacheState {
  memoryProvider: RuntimeCacheProvider;
  provider: RuntimeCacheProvider;
}

const RUNTIME_CACHE_STATE = Symbol.for("@teyik0/furin/runtime-cache-state");

function createMemoryProvider(): RuntimeCacheProvider {
  const namespaces = new Map<string, Map<string, MemoryEntry>>();
  const recent = new Map<MemoryEntry, undefined>();
  const expirations = new ExpirationHeap();
  const remove = (entry: MemoryEntry): void => {
    expirations.delete(entry);
    recent.delete(entry);
    const entries = namespaces.get(entry.namespace);
    entries?.delete(entry.key);
    if (entries?.size === 0) {
      namespaces.delete(entry.namespace);
    }
  };
  return {
    getCache(options) {
      const namespace = options?.namespace ?? "";
      return {
        delete(key) {
          const entry = namespaces.get(namespace)?.get(key);
          if (entry) {
            remove(entry);
          }
          return Promise.resolve();
        },
        expireTag(tag) {
          const tags = new Set(Array.isArray(tag) ? tag : [tag]);
          for (const entry of recent.keys()) {
            if (!entry.tags.isDisjointFrom(tags)) {
              remove(entry);
            }
          }
          return Promise.resolve();
        },
        get(key) {
          const entry = namespaces.get(namespace)?.get(key);
          if (entry === undefined) {
            return Promise.resolve(null);
          }
          if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
            remove(entry);
            return Promise.resolve(null);
          }
          recent.delete(entry);
          recent.set(entry, undefined);
          return Promise.resolve(entry.value);
        },
        set(key, value, setOptions) {
          const now = Date.now();
          const previous = namespaces.get(namespace)?.get(key);
          if (previous) {
            remove(previous);
          }
          const expiresAt = setOptions?.ttl === undefined ? undefined : now + setOptions.ttl * 1000;
          if (expiresAt !== undefined && expiresAt <= now) {
            return Promise.resolve();
          }
          const entries = namespaces.get(namespace) ?? new Map<string, MemoryEntry>();
          namespaces.set(namespace, entries);
          const entry: MemoryEntry = {
            key,
            namespace,
            expiresAt,
            tags: new Set(setOptions?.tags ?? []),
            value,
          };
          entries.set(key, entry);
          recent.set(entry, undefined);
          expirations.add(entry);
          for (
            let expired = expirations.takeExpired(now);
            expired;
            expired = expirations.takeExpired(now)
          ) {
            remove(expired);
          }
          if (recent.size > MAX_MEMORY_ENTRIES) {
            remove(recent.keys().next().value as MemoryEntry);
          }
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

export function hasExternalRuntimeCache(): boolean {
  const state = runtimeCacheState();
  return state.provider !== state.memoryProvider;
}

export function resetRuntimeCacheProvider(): void {
  const state = runtimeCacheState();
  state.provider = state.memoryProvider;
}
