import type { Context } from "elysia";
import { physicalPath } from "../../shared/prefix.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry, getAutoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { pendingISRRevalidations } from "../cache/isr.ts";
import type { PageCacheAdapter, PageCacheIdentity, PageCacheLease } from "../cache/page-cache.ts";
import { waitForPageCacheEntry } from "../cache/page-cache.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { registerCacheInvalidator } from "../cache/registry.ts";
import { type Cache, createRouteCache, type RevalidateType } from "../cache/route-cache.ts";
import { getCache, hasExternalRuntimeCache } from "../cache/runtime-cache.ts";
import { useLogger } from "../context-logger.ts";
import { isExternalPrerenderRequest } from "../external-prerender.ts";
import { allStateBuckets, currentInstance, type FurinInstance } from "../instance.ts";
import { resolveRouteRevalidate } from "../router/patterns.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { type LoaderResult, runPublicLoaders } from "./loaders.ts";
import {
  isPprArtifact,
  type PprArtifact,
  type PprResult,
  pprPublicResult,
  prerenderPprDocument,
  resumePprDocument,
} from "./ppr-document.ts";
import { getPprResumeState, pprPrerenderResponse } from "./ppr-request.ts";
import { renderSSR } from "./ssr.ts";

interface CachedPprRoute {
  artifact: PprArtifact;
  revalidate: number;
}

interface PprRouteState {
  cache: Cache<CachedPprRoute>;
  unregisterInvalidator: () => void;
}

const MAX_PPR_ROUTE_CACHE_SIZE = 1000;

const pprRouteStateKey = Symbol("furin-ppr-route-cache");

function pathFromPprCacheKey(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return null;
  }
  return new URL(key.slice(separator + 1), "http://furin.local").pathname;
}

function hasPprEntryForPath(cache: Cache<CachedPprRoute>, path: string): boolean {
  for (const key of cache.keys()) {
    if (pathFromPprCacheKey(key) === path) {
      return true;
    }
  }
  return false;
}

function createPprRouteState(instance: FurinInstance): PprRouteState {
  const registry = getAutoInvalidateRegistry(instance);
  let cache: Cache<CachedPprRoute>;
  cache = createRouteCache<CachedPprRoute>({
    maxSize: MAX_PPR_ROUTE_CACHE_SIZE,
    name: "render:ppr-public-shell",
    onDelete: (key) => {
      const path = pathFromPprCacheKey(key);
      if (path === null || hasPprEntryForPath(cache, path)) {
        return;
      }
      registry.unregisterPath(path);
    },
    pathFromKey: pathFromPprCacheKey,
  });

  return {
    cache,
    unregisterInvalidator: registerCacheInvalidator(cache, instance),
  };
}

function getPprRouteState(instance: FurinInstance): PprRouteState {
  const existing = instance.state.get(pprRouteStateKey) as PprRouteState | undefined;
  if (existing !== undefined) {
    return existing;
  }

  const state = createPprRouteState(instance);
  instance.state.set(pprRouteStateKey, state);
  return state;
}

function getPprRoutes(): Cache<CachedPprRoute> {
  return getPprRouteState(currentInstance()).cache;
}

const runtimePprCache = getCache({ namespace: "furin-ppr-v2" });

async function readPprArtifact(key: string, buildId: string): Promise<PprArtifact | undefined> {
  try {
    const stored = await runtimePprCache.get(key);
    if (typeof stored !== "string") {
      return;
    }
    const artifact: unknown = JSON.parse(stored);
    if (!isPprArtifact(artifact) || artifact.state.buildId !== buildId) {
      throw new Error("Invalid PPR artifact");
    }
    await pprPublicResult(artifact.state);
    return artifact;
  } catch {
    useLogger().warn("PPR runtime cache read failed; rendering fresh public data");
  }
}

function revalidatePprArtifact(
  cache: Cache<CachedPprRoute>,
  key: string,
  cached: CachedPprRoute,
  render: () => Promise<PprResult>
): void {
  const pending = pendingISRRevalidations();
  const pendingKey = `ppr:${key}`;
  if (pending.has(pendingKey)) {
    return;
  }
  const refresh = render()
    .then((artifact) => {
      if (isPprArtifact(artifact) && cache.get(key) === cached) {
        cache.set(key, { ...cached, artifact });
      }
    })
    .catch(() => {
      /* Retain the previous coherent shell after a failed regeneration. */
    })
    .finally(() => pending.delete(pendingKey));
  pending.set(pendingKey, refresh);
}

async function writePprArtifact(
  key: string,
  result: PprResult,
  tagPath: string,
  ttl: number | undefined
): Promise<void> {
  if (!isPprArtifact(result)) {
    return;
  }
  try {
    await runtimePprCache.set(key, JSON.stringify(result), {
      tags: [tagPath, ...(result.tags ?? [])],
      ttl,
    });
  } catch {
    useLogger().warn("PPR runtime cache write failed; serving the fresh result");
  }
}

async function parseSharedPprArtifact(
  payload: string,
  buildId: string
): Promise<PprArtifact | undefined> {
  const artifact: unknown = JSON.parse(payload);
  if (!isPprArtifact(artifact) || artifact.state.buildId !== buildId) {
    return;
  }
  await pprPublicResult(artifact.state);
  return artifact;
}

interface SharedPprInput {
  buildId: string;
  cacheKey: string;
  ctx: Context;
  pageCache: PageCacheAdapter;
  resolvedPath: string;
  root: RootLayout;
  route: ResolvedRoute;
  searchRoutes: SearchRouteMetadata[] | undefined;
}

async function renderSharedPpr(
  input: SharedPprInput,
  identity: PageCacheIdentity,
  lease: PageCacheLease | null,
  revalidate: number
): Promise<PprResult> {
  try {
    const result = await prerenderPprDocument(
      input.route,
      input.ctx,
      input.root,
      input.buildId,
      input.searchRoutes,
      undefined
    );
    if (lease === null || !isPprArtifact(result)) {
      return result;
    }
    try {
      await input.pageCache.commit({
        entry: {
          cachedAt: result.cachedAt,
          payload: JSON.stringify(result),
          revalidate: input.route.mode === "isr" ? revalidate : null,
        },
        identity,
        lease,
      });
    } catch {
      useLogger().warn("PPR shared page cache write failed; serving fresh public data");
    }
    return result;
  } finally {
    if (lease !== null) {
      try {
        await input.pageCache.release({ identity, lease });
      } catch {
        useLogger().warn("PPR shared page cache lease release failed");
      }
    }
  }
}

function revalidateSharedPpr(
  input: SharedPprInput,
  identity: PageCacheIdentity,
  lease: PageCacheLease,
  revalidate: number
): void {
  const pending = pendingISRRevalidations();
  const pendingKey = `ppr-shared:${input.cacheKey}`;
  const refresh = renderSharedPpr(input, identity, lease, revalidate)
    .then(() => undefined)
    .catch(() => {
      useLogger().warn("PPR shared page cache background regeneration failed");
    })
    .finally(() => pending.delete(pendingKey));
  pending.set(pendingKey, refresh);
}

interface SharedPprLookup {
  artifact: PprArtifact | undefined;
  available: boolean;
}

async function lookupSharedPpr(
  input: SharedPprInput,
  identity: PageCacheIdentity
): Promise<SharedPprLookup> {
  try {
    const cached = await input.pageCache.read(identity);
    return {
      artifact:
        cached === null ? undefined : await parseSharedPprArtifact(cached.payload, input.buildId),
      available: true,
    };
  } catch {
    useLogger().warn("PPR shared page cache read failed; rendering fresh public data");
    return { artifact: undefined, available: false };
  }
}

function renderFreshPpr(input: SharedPprInput): Promise<PprResult> {
  return prerenderPprDocument(
    input.route,
    input.ctx,
    input.root,
    input.buildId,
    input.searchRoutes,
    undefined
  );
}

async function getSharedPprArtifact(input: SharedPprInput): Promise<PprResult> {
  const { prefix } = currentInstance();
  const identity: PageCacheIdentity = {
    buildId: input.buildId,
    key: input.cacheKey,
    mode: "ppr",
    path: input.resolvedPath,
    scope: prefix,
    tags: input.route.tags ?? [],
  };
  const revalidate = resolveRouteRevalidate(input.route.page) ?? 60;
  const lookup = await lookupSharedPpr(input, identity);
  if (!lookup.available) {
    return renderFreshPpr(input);
  }
  const cachedArtifact = lookup.artifact;
  if (
    cachedArtifact !== undefined &&
    (input.route.mode !== "isr" || Date.now() - cachedArtifact.cachedAt < revalidate * 1000)
  ) {
    return cachedArtifact;
  }

  let lease: PageCacheLease | null;
  try {
    lease = await input.pageCache.acquire({ identity, leaseMs: 30_000 });
  } catch {
    useLogger().warn("PPR shared page cache lease failed");
    if (cachedArtifact !== undefined) {
      return cachedArtifact;
    }
    return renderFreshPpr(input);
  }
  if (cachedArtifact !== undefined) {
    if (lease !== null) {
      revalidateSharedPpr(input, identity, lease, revalidate);
    }
    return cachedArtifact;
  }
  if (lease === null) {
    try {
      const concurrent = await waitForPageCacheEntry(input.pageCache, identity, 2000);
      if (concurrent !== null) {
        const artifact = await parseSharedPprArtifact(concurrent.payload, input.buildId);
        if (artifact !== undefined) {
          return artifact;
        }
      }
    } catch {
      useLogger().warn("PPR shared page cache wait failed; rendering fresh public data");
    }
  }
  return renderSharedPpr(input, identity, lease, revalidate);
}

async function getPprArtifact(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<PprResult> {
  const requestUrl = new URL(ctx.request.url);
  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});
  const cacheKey = `${route.mode}:${resolvedPath}${requestUrl.search}`;
  const externalPrerender = isExternalPrerenderRequest(ctx.request);
  const pageCache = externalPrerender ? undefined : getPageCacheAdapter();
  if (pageCache !== undefined) {
    return getSharedPprArtifact({
      buildId,
      cacheKey,
      ctx,
      pageCache,
      resolvedPath,
      root,
      route,
      searchRoutes,
    });
  }
  if (hasExternalRuntimeCache()) {
    const { prefix } = currentInstance();
    const key = JSON.stringify([process.env.VERCEL_DEPLOYMENT_ID, buildId, prefix, cacheKey]);
    const stored = externalPrerender ? undefined : await readPprArtifact(key, buildId);
    if (stored !== undefined) {
      return stored;
    }
    const result = await prerenderPprDocument(route, ctx, root, buildId, searchRoutes, undefined);
    await writePprArtifact(
      key,
      result,
      physicalPath(prefix, resolvedPath),
      route.mode === "isr" ? (resolveRouteRevalidate(route.page) ?? 60) : undefined
    );
    return result;
  }
  const pprRoutes = getPprRoutes();
  const cached = externalPrerender ? undefined : pprRoutes.get(cacheKey);
  if (cached === undefined || cached.artifact.state.buildId !== buildId) {
    const result = await prerenderPprDocument(route, ctx, root, buildId, searchRoutes, undefined);
    if (!isPprArtifact(result)) {
      return result;
    }
    pprRoutes.set(cacheKey, {
      artifact: result,
      revalidate: resolveRouteRevalidate(route.page) ?? 60,
    });
    autoInvalidateRegistry.registerLoaderTags(resolvedPath, route.tags);
    return result;
  }

  if (route.mode !== "isr" || Date.now() - cached.artifact.cachedAt < cached.revalidate * 1000) {
    return cached.artifact;
  }
  revalidatePprArtifact(pprRoutes, cacheKey, cached, () =>
    prerenderPprDocument(route, ctx, root, buildId, searchRoutes, undefined)
  );
  return cached.artifact;
}

export async function runPprPublicLoaders(
  route: ResolvedRoute,
  ctx: Context,
  buildId: string,
  root: RootLayout | undefined,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<LoaderResult> {
  if (root === undefined) {
    return runPublicLoaders(route, ctx);
  }
  const result = await getPprArtifact(route, ctx, root, buildId, searchRoutes);
  return isPprArtifact(result) ? pprPublicResult(result.state) : result;
}

export async function renderPprRoute(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<Response> {
  const state = getPprResumeState(ctx.request);
  if (state !== undefined) {
    return resumePprDocument(route, ctx, root, { html: "", state }, searchRoutes);
  }
  const result = await getPprArtifact(route, ctx, root, buildId, searchRoutes);
  if (!isPprArtifact(result)) {
    return renderSSR(route, ctx, root, result, searchRoutes);
  }
  if (isExternalPrerenderRequest(ctx.request)) {
    return pprPrerenderResponse(result);
  }
  return resumePprDocument(route, ctx, root, result, searchRoutes);
}

export function clearPprRouteCache(instance?: FurinInstance): void {
  const instances = instance === undefined ? allStateBuckets() : [instance];
  for (const target of instances) {
    const state = target.state.get(pprRouteStateKey) as PprRouteState | undefined;
    if (state === undefined) {
      continue;
    }
    state.cache.clear();
    state.unregisterInvalidator();
    target.state.delete(pprRouteStateKey);
  }
}

export function invalidatePprRoute(path: string, type: RevalidateType): boolean {
  let deleted = false;
  for (const instance of allStateBuckets()) {
    const state = instance.state.get(pprRouteStateKey) as PprRouteState | undefined;
    if (state === undefined) {
      continue;
    }
    deleted = state.cache.invalidatePath(path, type).deleted || deleted;
  }
  return deleted;
}
