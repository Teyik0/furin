import type { Context } from "elysia";
import {
  callCachePurger,
  consumePendingInvalidations,
  revalidatePath,
  revalidatePathForInstance,
} from "../cache/invalidation.ts";
import { pathWithoutSearch } from "../cache/route-cache.ts";
import {
  currentInstrumentationRequest,
  emitCacheInvalidated,
} from "../devtools/instrumentation.ts";
import { allInstances, withInstance } from "../instance.ts";
import { IS_DEV } from "../runtime-env.ts";
import { getAutoInvalidateRegistry } from "./registry.ts";
import type { InvalidationInput, InvalidationRule } from "./types.ts";

function toRules(input: InvalidationInput): readonly InvalidationRule[] {
  return Array.isArray(input) ? input : [input as InvalidationRule];
}

function statusFromResponseValue(responseValue: unknown): number | undefined {
  if (responseValue instanceof Response) {
    return responseValue.status;
  }
  if (responseValue && typeof responseValue === "object" && "status" in responseValue) {
    const { status } = responseValue as { status?: unknown };
    if (typeof status === "number") {
      return status;
    }
  }
  if (responseValue && typeof responseValue === "object" && "code" in responseValue) {
    const { code } = responseValue as { code?: unknown };
    if (typeof code === "number") {
      return code;
    }
  }
}

export function isSuccessfulMutationResponse(
  ctx: Pick<Context, "set"> & {
    responseValue?: unknown;
    response?: unknown;
  }
): boolean {
  const responseStatus =
    statusFromResponseValue(ctx.responseValue) ?? statusFromResponseValue(ctx.response);
  if (responseStatus !== undefined) {
    return responseStatus >= 200 && responseStatus < 400;
  }

  const setStatus = ctx.set.status;
  if (typeof setStatus === "number") {
    return setStatus >= 200 && setStatus < 400;
  }
  if (typeof setStatus === "string") {
    // Elysia allows string status codes (e.g. "Not Found"). We cannot map
    // every possible string to its numeric code without the StatusMap, so we
    // treat known client-error (4xx) and server-error (5xx) texts as failures
    // and everything else as success (1xx, 2xx, 3xx, and any unknown string).
    const errorStatusTexts = new Set([
      "Bad Request",
      "Unauthorized",
      "Payment Required",
      "Forbidden",
      "Not Found",
      "Method Not Allowed",
      "Not Acceptable",
      "Proxy Authentication Required",
      "Request Timeout",
      "Conflict",
      "Gone",
      "Length Required",
      "Precondition Failed",
      "Payload Too Large",
      "URI Too Long",
      "Unsupported Media Type",
      "Range Not Satisfiable",
      "Expectation Failed",
      "I'm a teapot",
      "Misdirected Request",
      "Unprocessable Content",
      "Locked",
      "Failed Dependency",
      "Too Early",
      "Upgrade Required",
      "Precondition Required",
      "Too Many Requests",
      "Enhance Your Calm",
      "Request Header Fields Too Large",
      "Unavailable For Legal Reasons",
      "Internal Server Error",
      "Not Implemented",
      "Bad Gateway",
      "Service Unavailable",
      "Gateway Timeout",
      "HTTP Version Not Supported",
      "Variant Also Negotiates",
      "Insufficient Storage",
      "Loop Detected",
      "Not Extended",
      "Network Authentication Required",
    ]);
    return !errorStatusTexts.has(setStatus);
  }
  // No explicit status was set — default to success (200).
  return true;
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
      ? `${existing},${pending.join(",")}`
      : pending.join(",");
  return pending;
}

export function revalidateTag(tags: string | readonly string[]): boolean {
  const tagList = typeof tags === "string" ? [tags] : [...tags];
  // Tags are cross-app by design: with several mounted furin instances a
  // shared mutation must be able to invalidate pages rendered by any of them.
  // But each instance's tag-registered paths are evicted from THAT instance's
  // caches only — the cross-app fan-out of `revalidatePath` would also evict
  // a sibling app's unrelated page that merely shares the pathname.
  let deleted = false;
  // External caches can associate entries directly with semantic tags. Keep
  // those tags in the purge even when this process has never rendered (and
  // therefore never registered) the matching paths.
  const purgedPaths = new Set<string>(tagList);
  for (const instance of allInstances()) {
    let instanceDeleted = false;
    const instancePurgedPaths = new Set<string>();
    // Registry paths are LOGICAL (unprefixed); the CDN caches the PHYSICAL
    // request URL, so prefix each with the instance's mount prefix before
    // queueing it for purge — otherwise a mounted app's `/admin/x` stays stale.
    for (const path of getAutoInvalidateRegistry(instance).pathsForTags(tagList)) {
      const logicalPath = pathWithoutSearch(path);
      const result = revalidatePathForInstance(instance, logicalPath, "page", false);
      deleted = result.deleted || deleted;
      instanceDeleted = result.deleted || instanceDeleted;
      purgedPaths.add(`${instance.prefix}${logicalPath}`);
      instancePurgedPaths.add(logicalPath);
      for (const purged of result.purgedPaths) {
        purgedPaths.add(`${instance.prefix}${purged}`);
        instancePurgedPaths.add(purged);
      }
    }
    if (IS_DEV) {
      withInstance(instance, () => {
        const request = currentInstrumentationRequest();
        const operationId = request === undefined ? null : request.operationId;
        const requestId = request === undefined ? null : request.requestId;
        emitCacheInvalidated({
          deleted: instanceDeleted,
          operationId,
          purgedPaths: instancePurgedPaths.size,
          reason: "tag",
          requestId,
          target: tagList.join(","),
        });
      });
    }
  }
  // One batched CDN purge — the CDN sits in front of every mounted app, so
  // physical paths from all instances go out together, deduped.
  callCachePurger([...purgedPaths]);
  return deleted;
}

export function runInvalidationRules(input: InvalidationInput): boolean {
  let deleted = false;
  for (const rule of toRules(input)) {
    if ("path" in rule && rule.path) {
      deleted = revalidatePath(rule.path, rule.type) || deleted;
    }
    if (rule.tags && rule.tags.length > 0) {
      deleted = revalidateTag(rule.tags) || deleted;
    }
  }
  return deleted;
}
