import type { Context } from "elysia";
import { serializeInvalidationPaths } from "../../shared/invalidation-header.ts";
import { physicalPath } from "../../shared/prefix.ts";
import {
  callCachePurger,
  consumePendingInvalidations,
  revalidatePath,
  revalidatePathForInstance,
} from "../cache/invalidation.ts";
import { getPageCacheAdapter } from "../cache/page-cache-state.ts";
import { callCacheTagPurger } from "../cache/purger.ts";
import { pathWithoutSearch } from "../cache/route-cache.ts";
import {
  currentInstrumentationRequest,
  emitCacheInvalidated,
} from "../devtools/instrumentation.ts";
import { allInstances, withInstance } from "../instance.ts";
import { IS_DEV } from "../runtime-env.ts";
import { effectiveResponseStatus } from "../sync/response.ts";
import { getAutoInvalidateRegistry } from "./registry.ts";
import type { InvalidationInput, InvalidationRule } from "./types.ts";

function toRules(input: InvalidationInput): readonly InvalidationRule[] {
  return Array.isArray(input) ? input : [input as InvalidationRule];
}

export function isSuccessfulMutationResponse(
  ctx: Pick<Context, "set"> & {
    responseValue?: unknown;
    response?: unknown;
  }
): boolean {
  const status = effectiveResponseStatus(ctx.responseValue ?? ctx.response, ctx.set);
  return status >= 200 && status < 400;
}

export function appendPendingInvalidationHeader(set: Context["set"]): string[] {
  const pending = consumePendingInvalidations();
  if (pending.length === 0) {
    return [];
  }

  const headerName = "x-furin-revalidate";
  const existing = set.headers[headerName];
  set.headers[headerName] =
    typeof existing === "string" && existing.length > 0
      ? `${existing},${serializeInvalidationPaths(pending)}`
      : serializeInvalidationPaths(pending);
  return pending;
}

async function invalidateTagsForInstance(
  instance: ReturnType<typeof allInstances>[number],
  tagList: readonly string[]
): Promise<{ deleted: boolean; purgedPaths: string[] }> {
  let deleted = false;
  const purgedPaths = new Set<string>();
  const logicalPurgedPaths = new Set<string>();
  const sharedInvalidations: Promise<{ invalidated: boolean; paths: readonly string[] }>[] = [];
  const pageCache = getPageCacheAdapter(instance);
  const sharedResult =
    pageCache === undefined
      ? undefined
      : await pageCache.invalidate({
          kind: "tags",
          scope: instance.prefix,
          tags: tagList,
        });
  if (sharedResult !== undefined) {
    deleted = sharedResult.invalidated;
  }
  const taggedPaths = new Set([
    ...getAutoInvalidateRegistry(instance).pathsForTags(tagList),
    ...(sharedResult?.paths ?? []),
  ]);
  const tags = new Set(tagList);
  // Registry paths are LOGICAL (unprefixed); the CDN caches the PHYSICAL
  // request URL, so prefix each with the instance's mount prefix before
  // queueing it for purge — otherwise a mounted app's `/admin/x` stays stale.
  for (const path of taggedPaths) {
    const logicalPath = pathWithoutSearch(path);
    const registered = getAutoInvalidateRegistry(instance)
      .tagsForPath(path)
      .some((tag) => tags.has(tag));
    const result = revalidatePathForInstance(instance, logicalPath, "page", false);
    if (pageCache !== undefined && registered) {
      sharedInvalidations.push(
        pageCache.invalidate({
          kind: "path",
          scope: instance.prefix,
          path: logicalPath,
          type: "page",
        })
      );
    }
    deleted = result.deleted || deleted;
    purgedPaths.add(physicalPath(instance.prefix, logicalPath));
    logicalPurgedPaths.add(logicalPath);
    for (const purged of result.purgedPaths) {
      purgedPaths.add(physicalPath(instance.prefix, purged));
      logicalPurgedPaths.add(purged);
    }
  }
  const pathResults = await Promise.all(sharedInvalidations);
  deleted = pathResults.some((result) => result.invalidated) || deleted;
  if (IS_DEV) {
    withInstance(instance, () => {
      const request = currentInstrumentationRequest();
      const operationId = request === undefined ? null : request.operationId;
      const requestId = request === undefined ? null : request.requestId;
      emitCacheInvalidated({
        deleted,
        operationId,
        purgedPaths: logicalPurgedPaths.size,
        reason: "tag",
        requestId,
        target: tagList.join(","),
      });
    });
  }
  return { deleted, purgedPaths: [...purgedPaths] };
}

export async function revalidateTag(tags: string | readonly string[]): Promise<boolean> {
  const tagList = typeof tags === "string" ? [tags] : [...tags];
  // Tags are cross-app by design: with several mounted furin instances a
  // shared mutation must be able to invalidate pages rendered by any of them.
  // But each instance's tag-registered paths are evicted from THAT instance's
  // caches only — the cross-app fan-out of `revalidatePath` would also evict
  // a sibling app's unrelated page that merely shares the pathname.
  callCacheTagPurger(tagList);
  const results = await Promise.all(
    allInstances().map((instance) => invalidateTagsForInstance(instance, tagList))
  );
  const purgedPaths = new Set<string>();
  let deleted = false;
  for (const result of results) {
    deleted = result.deleted || deleted;
    for (const path of result.purgedPaths) {
      purgedPaths.add(path);
    }
  }
  // One batched CDN purge — the CDN sits in front of every mounted app, so
  // physical paths from all instances go out together, deduped.
  callCachePurger([...purgedPaths]);
  return deleted;
}

export async function runInvalidationRules(input: InvalidationInput): Promise<boolean> {
  const operations = toRules(input).flatMap((rule) => {
    const pending: Promise<boolean>[] = [];
    if ("path" in rule && rule.path) {
      pending.push(revalidatePath(rule.path, rule.type));
    }
    if (rule.tags && rule.tags.length > 0) {
      pending.push(revalidateTag(rule.tags));
    }
    return pending;
  });
  return (await Promise.all(operations)).some(Boolean);
}
