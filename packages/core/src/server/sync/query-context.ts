import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "elysia";
import { QueryStore, setServerQueryEnvironment } from "../../client/query-store.ts";
import { toLogical } from "../../client/router/link-utils.ts";
import { bindQueryData } from "../../shared/query-bindings.ts";
import { mergeQuerySeeds, type QuerySeed, queryTag } from "../../shared/sync-query.ts";
import { getAutoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { currentInstance, instanceSlot } from "../instance.ts";
import type { LoaderResult } from "../render/loaders.ts";

interface QueryContext {
  onRead: () => void;
  origin: string;
  store: QueryStore;
}
const QUERY_CONTEXT = Symbol.for("furin.query.server-context.v1");
const contextGlobal = globalThis as typeof globalThis & {
  [QUERY_CONTEXT]?: AsyncLocalStorage<QueryContext>;
};
const contexts = (contextGlobal[QUERY_CONTEXT] ??= new AsyncLocalStorage<QueryContext>());
setServerQueryEnvironment(() => contexts.getStore());
const trackedQueryPaths = instanceSlot(() => new Set<string>());
const deferredQueries = new WeakMap<Promise<unknown>, QuerySeed[]>();

export function deferredQuerySeeds(promise: Promise<unknown>): QuerySeed[] | undefined {
  return deferredQueries.get(promise);
}

export function captureQueryReads<Result extends LoaderResult>(
  ctx: Context,
  run: () => Promise<Result>,
  owner?: "eden-request-queries"
): Promise<Result> {
  const { origin } = new URL(ctx.request.url);
  const store = new QueryStore(origin);
  const registry = getAutoInvalidateRegistry();
  const trackedPaths = trackedQueryPaths();
  const requestUrl = new URL(ctx.request.url);
  const path = toLogical(requestUrl.pathname, currentInstance().prefix) + requestUrl.search;
  const onRead = () => {
    const seeds = store.dehydrate();
    registry.registerLoaderTags(
      path,
      seeds.map((seed) => queryTag(seed.identity)),
      owner ?? "eden-queries"
    );
    trackedPaths.delete(path);
    if (seeds.length > 0) {
      trackedPaths.add(path);
    }
    // Discovery metadata is bounded like the render caches, including uncached SSR paths.
    if (trackedPaths.size > 1000) {
      const oldest = trackedPaths.values().next().value;
      if (oldest !== undefined) {
        trackedPaths.delete(oldest);
        registry.unregisterPath(oldest, "eden-queries");
        registry.unregisterPath(oldest, "eden-request-queries");
      }
    }
  };
  return contexts.run({ origin, store, onRead }, async () => {
    const result = { ...(await run()) };
    const seeds = store.dehydrate();
    if (result.type === "data" && seeds.length > 0) {
      const captured = [...((result.syncData.__furinQueries as QuerySeed[] | undefined) ?? [])];
      mergeQuerySeeds(captured, bindQueryData(result.syncData, seeds));
      result.syncData = { ...result.syncData, __furinQueries: captured };
    }
    if (result.type === "data" && result.deferredPromises) {
      for (const [key, promise] of Object.entries(result.deferredPromises)) {
        promise
          .then((value) => {
            const completed = store.dehydrate();
            if (completed.length > 0) {
              const captured = deferredQueries.get(promise) ?? [];
              mergeQuerySeeds(captured, bindQueryData({ [key]: value }, completed));
              deferredQueries.set(promise, captured);
            }
          })
          .catch(() => undefined);
      }
    }
    return result;
  });
}
