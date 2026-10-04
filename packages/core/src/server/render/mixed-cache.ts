import type { Context } from "elysia";
import { fromCrossJSON, toCrossJSONAsync } from "seroval";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { currentQueryEnvironment } from "../../client/query-store.ts";
import { toLogical } from "../../client/router/link-utils.ts";
import { isDeferred } from "../../shared/defer.ts";
import { bindQueryData, projectQueryData } from "../../shared/query-bindings.ts";
import { type QuerySeed, queryTag } from "../../shared/sync-query.ts";
import { autoInvalidateRegistry, getAutoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import type { PageCacheAdapter, PageCacheIdentity, PageCacheLease } from "../cache/page-cache.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { registerCacheInvalidator } from "../cache/registry.ts";
import { createRouteCache } from "../cache/route-cache.ts";
import { getLogger } from "../context-logger.ts";
import { allStateBuckets, currentInstance, type FurinInstance } from "../instance.ts";
import { routeModuleSourceVersion } from "../router/source-version.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";

interface CachedSegment {
  cachedAt: number;
  payload: string;
}

interface ParentDependency {
  key: string;
  signature: string;
}

interface SegmentSnapshot {
  data: Parameters<typeof fromCrossJSON>[0];
  dependencies: ParentDependency[];
  queries?: QuerySeed[];
}

function capturedQueryTags(): string[] {
  return (
    currentQueryEnvironment()
      ?.store.dehydrate()
      .map((seed) => queryTag(seed.identity)) ?? []
  );
}

const mixedCacheKey = Symbol("furin-mixed-loader-cache");

interface MixedCacheState {
  cache: ReturnType<typeof createRouteCache<CachedSegment>>;
  generation: number;
  unregister?: () => void;
}

function cachePathWithSearch(key: string): string | null {
  const separator = key.indexOf("|");
  return separator < 0 ? null : key.slice(separator + 1);
}

function localCache() {
  const instance = currentInstance();
  const existing = instance.state.get(mixedCacheKey) as MixedCacheState | undefined;
  if (existing) {
    return existing;
  }
  const cache = createRouteCache<CachedSegment>({
    maxSize: 1000,
    name: "render:mixed-public-loader",
    onDelete: (key) => {
      const path = cachePathWithSearch(key);
      if (path && ![...cache.keys()].some((other) => cachePathWithSearch(other) === path)) {
        getAutoInvalidateRegistry(instance).unregisterPath(path, "render:mixed-public-loader");
      }
    },
    pathFromKey: (key) => {
      const path = cachePathWithSearch(key);
      return path === null ? null : new URL(path, "http://furin.local").pathname;
    },
  });
  const state: MixedCacheState = { cache, generation: 0 };
  state.unregister = registerCacheInvalidator(
    {
      invalidatePath(path, type) {
        state.generation += 1;
        return cache.invalidatePath(path, type);
      },
      name: cache.name,
    },
    instance
  );
  instance.state.set(mixedCacheKey, state);
  return state;
}

export function clearMixedPublicCache(instance?: FurinInstance): void {
  for (const target of instance === undefined ? allStateBuckets() : [instance]) {
    const state = target.state.get(mixedCacheKey) as MixedCacheState | undefined;
    if (state) {
      state.generation += 1;
      state.cache.clear();
      state.unregister?.();
      target.state.delete(mixedCacheKey);
    }
  }
}

async function parentSignature(value: unknown): Promise<string> {
  return JSON.stringify(await toCrossJSONAsync(value));
}

async function readCachedSegment(
  entry: CachedSegment | undefined,
  revalidate: number,
  parentData: Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
  if (entry === undefined || Date.now() - entry.cachedAt >= revalidate * 1000) {
    return;
  }
  try {
    const snapshot = JSON.parse(entry.payload) as SegmentSnapshot;
    if (snapshot.dependencies.length > 0) {
      const parent = await parentData;
      const matches = await Promise.all(
        snapshot.dependencies.map(
          async (dependency) =>
            (await parentSignature(parent[dependency.key])) === dependency.signature
        )
      );
      if (matches.some((match) => !match)) {
        return;
      }
    }
    const environment = currentQueryEnvironment();
    environment?.store.hydrate(snapshot.queries ?? []);
    environment?.onRead();
    const data = fromCrossJSON(snapshot.data, {}) as Record<string, unknown>;
    return projectQueryData(data, snapshot.queries ?? [], (seed) => seed.data);
  } catch {
    getLogger().warn("Mixed loader cache entry is invalid; loading fresh data");
  }
}

async function createSegmentSnapshot(
  data: Record<string, unknown>,
  parentData: Promise<Record<string, unknown>>,
  parentFieldsRead: ReadonlySet<string>
): Promise<string> {
  const parent = parentFieldsRead.size > 0 ? await parentData : {};
  const dependencies: ParentDependency[] = await Promise.all(
    [...parentFieldsRead].map(async (key) => ({
      key,
      signature: await parentSignature(parent[key]),
    }))
  );
  return JSON.stringify({
    data: await toCrossJSONAsync(data),
    dependencies,
    queries: bindQueryData(data, currentQueryEnvironment()?.store.dehydrate() ?? []).filter(
      (seed) => (seed.bindings?.length ?? 0) > 0
    ),
  } satisfies SegmentSnapshot);
}

async function acquireSharedSegment(
  shared: PageCacheAdapter,
  identity: PageCacheIdentity
): Promise<PageCacheLease | null> {
  try {
    return await shared.acquire({ identity, leaseMs: 30_000 });
  } catch {
    getLogger().warn("Mixed loader cache lease failed; loading fresh data");
    return null;
  }
}

async function releaseSharedSegment(
  shared: PageCacheAdapter,
  identity: PageCacheIdentity,
  lease: PageCacheLease
): Promise<void> {
  try {
    await shared.release({ identity, lease });
  } catch {
    getLogger().warn("Mixed loader cache lease release failed");
  }
}

async function readSharedSegment(
  shared: PageCacheAdapter,
  identity: PageCacheIdentity,
  revalidate: number,
  parentData: Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
  try {
    const entry = await shared.read(identity);
    return entry === null ? undefined : readCachedSegment(entry, revalidate, parentData);
  } catch {
    getLogger().warn("Mixed loader cache read failed; loading fresh data");
  }
}

async function commitSharedSegment(
  shared: PageCacheAdapter,
  identity: PageCacheIdentity,
  lease: PageCacheLease,
  cached: CachedSegment,
  revalidate: number
): Promise<void> {
  const identityTags = new Set(identity.tags);
  if (capturedQueryTags().some((tag) => !identityTags.has(tag))) {
    return;
  }
  try {
    await shared.commit({
      entry: {
        cachedAt: cached.cachedAt,
        payload: cached.payload,
        revalidate: Number.isFinite(revalidate) ? revalidate : null,
      },
      identity,
      lease,
    });
  } catch {
    getLogger().warn("Mixed loader cache write failed; serving fresh data");
  }
}

async function readLocalSegment(
  state: MixedCacheState | undefined,
  generation: number | undefined,
  key: string,
  revalidate: number,
  parentData: Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
  const cached = await readCachedSegment(state?.cache.get(key), revalidate, parentData);
  return state?.generation === generation ? cached : undefined;
}

function storeLocalSegment(
  state: MixedCacheState | undefined,
  generation: number | undefined,
  key: string,
  path: string,
  tags: readonly string[] | undefined,
  cached: CachedSegment
): void {
  if (state === undefined || state.generation !== generation) {
    return;
  }
  state.cache.set(key, cached);
  autoInvalidateRegistry.registerLoaderTags(path, tags, "render:mixed-public-loader");
}

export async function cacheMixedPublicLoader(
  route: ResolvedRoute,
  ctx: Context,
  segment: RuntimeRoute | RuntimePage,
  index: number,
  parentData: Promise<Record<string, unknown>>,
  parentFieldsRead: ReadonlySet<string>,
  run: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const instance = currentInstance();
  const declaredTags = route.tags ?? [];
  const mode = segment.mode ?? route.mode;
  const revalidate = mode === "isr" ? (segment.revalidate ?? 60) : Number.POSITIVE_INFINITY;
  const requestUrl = new URL(ctx.request.url);
  const path = toLogical(new URL(ctx.path, requestUrl).pathname, instance.prefix);
  const sourcePath = "sourcePath" in segment ? segment.sourcePath : route.path;
  const sourceVersion = IS_DEV && sourcePath ? routeModuleSourceVersion(sourcePath) : "";
  const key = `${route.path}:${instance.buildId}:${index}:${sourceVersion}|${path}${requestUrl.search}`;
  const shared = IS_DEV ? undefined : getPageCacheAdapter(instance);
  const localState = shared === undefined ? localCache() : undefined;
  const generation = localState?.generation;
  const local = await readLocalSegment(localState, generation, key, revalidate, parentData);
  if (local !== undefined) {
    return local;
  }

  const identity = {
    buildId: instance.buildId,
    key,
    mode: mode === "isr" ? ("isr" as const) : ("ssg" as const),
    path,
    scope: instance.prefix,
    tags: [
      ...new Set([
        ...declaredTags,
        ...getAutoInvalidateRegistry().tagsForPath(`${path}${requestUrl.search}`),
      ]),
    ],
  };
  const stored =
    shared === undefined
      ? undefined
      : await readSharedSegment(shared, identity, revalidate, parentData);
  if (stored !== undefined) {
    return stored;
  }

  const lease = shared === undefined ? null : await acquireSharedSegment(shared, identity);
  try {
    const data = await run();
    if (isDeferred(data)) {
      throw new Error(
        "[furin] defer() requires an SSR loader; public ISR/SSG loaders must resolve their data."
      );
    }
    const cached = {
      cachedAt: Date.now(),
      payload: await createSegmentSnapshot(data, parentData, parentFieldsRead),
    };
    storeLocalSegment(
      localState,
      generation,
      key,
      `${path}${requestUrl.search}`,
      [...declaredTags, ...capturedQueryTags()],
      cached
    );
    if (shared !== undefined && lease !== null) {
      await commitSharedSegment(shared, identity, lease, cached, revalidate);
    }
    return data;
  } finally {
    if (shared !== undefined && lease !== null) {
      await releaseSharedSegment(shared, identity, lease);
    }
  }
}
