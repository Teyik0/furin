export type PageCacheMode = "isr" | "ppr" | "ssg";

const TRAILING_SLASHES = /\/+$/;

export interface PageCacheIdentity {
  buildId: string;
  key: string;
  mode: PageCacheMode;
  path: string;
  scope: string;
  tags: readonly string[];
}

export interface PageCacheEntry {
  cachedAt: number;
  payload: string;
  revalidate: number | null;
}

export interface PageCacheLease {
  expiresAt: number;
  fence: number;
  id: string;
  revision: string;
}

export type PageCacheInvalidation =
  | {
      kind: "path";
      path: string;
      scope: string;
      type: "layout" | "page";
    }
  | {
      kind: "tags";
      scope: string;
      tags: readonly string[];
    };

export interface PageCacheInvalidationResult {
  invalidated: boolean;
  paths: readonly string[];
}

export interface PageCacheAdapter {
  acquire: (input: {
    identity: PageCacheIdentity;
    leaseMs: number;
  }) => Promise<PageCacheLease | null>;
  commit: (input: {
    entry: PageCacheEntry;
    identity: PageCacheIdentity;
    lease: PageCacheLease;
  }) => Promise<"stored" | "superseded">;
  invalidate: (input: PageCacheInvalidation) => Promise<PageCacheInvalidationResult>;
  read: (identity: PageCacheIdentity) => Promise<PageCacheEntry | null>;
  release: (input: { identity: PageCacheIdentity; lease: PageCacheLease }) => Promise<void>;
}

export async function waitForPageCacheEntry(
  adapter: PageCacheAdapter,
  identity: PageCacheIdentity,
  timeoutMs: number
): Promise<PageCacheEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling must observe the preceding read before retrying.
    await Bun.sleep(10);
    const entry = await adapter.read(identity);
    if (entry !== null) {
      return entry;
    }
  }
  return null;
}

function identityMatchesPath(
  identity: PageCacheIdentity,
  input: Extract<PageCacheInvalidation, { kind: "path" }>
): boolean {
  if (identity.scope !== input.scope) {
    return false;
  }
  if (input.type === "page") {
    return identity.path === input.path;
  }
  return (
    input.path === "/" || identity.path === input.path || identity.path.startsWith(`${input.path}/`)
  );
}

function identityMatchesTags(
  identity: PageCacheIdentity,
  scope: string,
  tags: ReadonlySet<string>
): boolean {
  return identity.scope === scope && identity.tags.some((tag) => tags.has(tag));
}

interface StoredPageCacheEntry {
  entry: PageCacheEntry;
  identity: PageCacheIdentity;
  revision: string;
}

interface ActivePageCacheLease {
  identity: PageCacheIdentity;
  lease: PageCacheLease;
}

function invalidateMatchingEntries(
  entries: Map<string, StoredPageCacheEntry>,
  leases: Map<string, ActivePageCacheLease>,
  matches: (identity: PageCacheIdentity) => boolean
): PageCacheInvalidationResult {
  const affectedPaths = new Set<string>();
  for (const [key, stored] of entries) {
    if (matches(stored.identity)) {
      affectedPaths.add(stored.identity.path);
      entries.delete(key);
    }
  }
  for (const active of leases.values()) {
    if (matches(active.identity)) {
      affectedPaths.add(active.identity.path);
    }
  }
  return { invalidated: affectedPaths.size > 0, paths: [...affectedPaths] };
}

function identityKey(identity: PageCacheIdentity): string {
  return JSON.stringify([identity.scope, identity.buildId, identity.mode, identity.key]);
}

function layoutPaths(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }
  const segments = path.split("/").filter(Boolean);
  const paths = ["/"];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    paths.push(current);
  }
  return paths;
}

function selectorKey(scope: string, selector: "layout" | "page" | "tag", value: string): string {
  return JSON.stringify([scope, selector, value]);
}

function normalizeInvalidationPath(path: string): string {
  return path.length > 1 ? path.replace(TRAILING_SLASHES, "") : path;
}

export function createMemoryPageCache(): PageCacheAdapter {
  const maxEntries = 1000;
  const entries = new Map<string, StoredPageCacheEntry>();
  const leases = new Map<string, ActivePageCacheLease>();
  const fences = new Map<string, number>();
  const versions = new Map<string, number>();

  const selectorsFor = (identity: PageCacheIdentity): string[] => [
    selectorKey(identity.scope, "page", identity.path),
    ...layoutPaths(identity.path).map((path) => selectorKey(identity.scope, "layout", path)),
    ...identity.tags.map((tag) => selectorKey(identity.scope, "tag", tag)),
  ];

  const revisionFor = (identity: PageCacheIdentity): string =>
    JSON.stringify(selectorsFor(identity).map((selector) => versions.get(selector) ?? 0));

  const increment = (key: string): void => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
  };

  const removeExpiredLeases = (now: number): void => {
    for (const [key, active] of leases) {
      if (active.lease.expiresAt <= now) {
        leases.delete(key);
      }
    }
  };

  const liveSelectors = (): Set<string> => {
    const selectors = new Set<string>();
    for (const identity of [
      ...[...entries.values()].map((stored) => stored.identity),
      ...[...leases.values()].map((active) => active.identity),
    ]) {
      for (const selector of selectorsFor(identity)) {
        selectors.add(selector);
      }
    }
    return selectors;
  };

  const cleanupMetadata = (now: number): void => {
    removeExpiredLeases(now);
    const liveKeys = new Set([...entries.keys(), ...leases.keys()]);
    for (const key of fences.keys()) {
      if (!liveKeys.has(key)) {
        fences.delete(key);
      }
    }
    const retainedSelectors = liveSelectors();
    for (const selector of versions.keys()) {
      if (!retainedSelectors.has(selector)) {
        versions.delete(selector);
      }
    }
  };

  return {
    acquire({ identity, leaseMs }) {
      const key = identityKey(identity);
      const now = Date.now();
      cleanupMetadata(now);
      const active = leases.get(key);
      if (active !== undefined && active.lease.expiresAt > now) {
        return Promise.resolve(null);
      }
      if (leases.size >= maxEntries) {
        return Promise.resolve(null);
      }
      const lease: PageCacheLease = {
        expiresAt: now + leaseMs,
        fence: (fences.get(key) ?? 0) + 1,
        id: crypto.randomUUID(),
        revision: revisionFor(identity),
      };
      fences.set(key, lease.fence);
      leases.set(key, { identity, lease });
      return Promise.resolve(lease);
    },
    commit({ entry, identity, lease }) {
      const key = identityKey(identity);
      cleanupMetadata(Date.now());
      const active = leases.get(key);
      if (active?.lease.id !== lease.id || active.lease.fence !== lease.fence) {
        return Promise.resolve("superseded");
      }
      leases.delete(key);
      if (lease.expiresAt <= Date.now() || lease.revision !== revisionFor(identity)) {
        return Promise.resolve("superseded");
      }
      entries.delete(key);
      entries.set(key, { entry, identity, revision: lease.revision });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
      cleanupMetadata(Date.now());
      return Promise.resolve("stored");
    },
    invalidate(input) {
      cleanupMetadata(Date.now());
      if (input.kind === "path") {
        const normalizedInput = { ...input, path: normalizeInvalidationPath(input.path) };
        const result = invalidateMatchingEntries(entries, leases, (identity) =>
          identityMatchesPath(identity, normalizedInput)
        );
        increment(selectorKey(input.scope, input.type, normalizedInput.path));
        cleanupMetadata(Date.now());
        return Promise.resolve(result);
      }
      const tags = new Set(input.tags);
      const result = invalidateMatchingEntries(entries, leases, (identity) =>
        identityMatchesTags(identity, input.scope, tags)
      );
      for (const tag of input.tags) {
        increment(selectorKey(input.scope, "tag", tag));
      }
      cleanupMetadata(Date.now());
      return Promise.resolve(result);
    },
    read(identity) {
      cleanupMetadata(Date.now());
      const key = identityKey(identity);
      const stored = entries.get(key);
      if (stored === undefined || stored.revision !== revisionFor(identity)) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      entries.delete(key);
      entries.set(key, stored);
      return Promise.resolve(stored.entry);
    },
    release({ identity, lease }) {
      const key = identityKey(identity);
      if (leases.get(key)?.lease.id === lease.id) {
        leases.delete(key);
      }
      cleanupMetadata(Date.now());
      return Promise.resolve();
    },
  };
}
