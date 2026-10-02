import { type Context, type Elysia, ElysiaStatus, StatusMap, Validator } from "elysia";
import {
  appendPendingInvalidationHeader,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { peekPendingInvalidations } from "../cache/invalidation.ts";
import { getLogger } from "../context-logger.ts";
import type {
  AtomicMutationResult,
  MutationLease,
  SyncInvalidation,
  TransactionalSyncAdapter,
} from "./adapter.ts";
import {
  appendQueryInvalidations,
  resolveSyncInvalidations,
  type SyncInvalidationSelector,
} from "./queries.ts";
import {
  mergeStoredResponseHeaders,
  type StoreResponseResult,
  storeResponse,
  storeResponseSync,
} from "./response.ts";
import type { ResolvedSyncRuntime } from "./runtime.ts";

const TRAILING_SLASH_PATTERN = /\/$/;

class RejectedMutation {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

type CommittedMutation = Extract<AtomicMutationResult<unknown>, { kind: "committed" }>;
type ResponseSchemaMap = NonNullable<
  NonNullable<Parameters<typeof Validator.response>[1]>["schemas"]
>[number];
interface Execution<Tx> {
  adapter: TransactionalSyncAdapter<Tx, "async" | "sync">;
  app: Elysia;
  context: Context;
  invalidate: SyncInvalidationSelector | undefined;
  lease: MutationLease;
  onCommit: (result: CommittedMutation) => void;
  resolvedInvalidate?: InvalidationInput;
  runtime: ResolvedSyncRuntime;
}

function responseStatus(context: Context, value: unknown): number {
  if (value instanceof Response && value.status !== 200) {
    return value.status;
  }
  if (value instanceof ElysiaStatus) {
    return value.status;
  }
  if (typeof context.set.status === "string") {
    return StatusMap[context.set.status];
  }
  return context.set.status ?? 200;
}

function withStatus(original: unknown, value: unknown): unknown {
  return original instanceof ElysiaStatus
    ? new ElysiaStatus(original.status, value, original.headers)
    : value;
}

function validateResult<Tx>(execution: Execution<Tx>, value: unknown): unknown {
  if (value instanceof Error) {
    throw value;
  }
  if (value instanceof Response) {
    return value;
  }
  const { app, context, adapter } = execution;
  const registeredPath = context.route ?? context.path;
  const strictPath = app["~config"]?.strictPath === true;
  const [match] = app.routes
    .toReversed()
    .filter((entry) => entry.method === context.request.method || entry.method === "*")
    .map((candidate) => {
      const paths = [candidate.path, encodeURI(candidate.path)];
      const exact = paths.includes(registeredPath);
      const loose =
        !strictPath &&
        paths.some(
          (path) =>
            path.replace(TRAILING_SLASH_PATTERN, "") ===
            registeredPath.replace(TRAILING_SLASH_PATTERN, "")
        );
      return { route: candidate, priority: exact ? 2 : Number(loose) };
    })
    .filter((entry) => entry.priority > 0)
    .sort(
      (left, right) =>
        Number(right.route.method === context.request.method) -
          Number(left.route.method === context.request.method) || right.priority - left.priority
    );
  if (!match) {
    throw new Error(
      "[furin] Could not resolve the effective mutation route for response validation."
    );
  }
  const { route } = match;
  const validators = Validator.response(route?.hooks.response, {
    models: app["~ext"]?.models,
    normalize: app["~config"]?.normalize,
    sanitize: app["~config"]?.sanitize,
    schemas: route?.hooks.schemas?.flatMap((schema: { response?: ResponseSchemaMap }) =>
      schema.response ? [schema.response] : []
    ),
  });
  const validator = validators?.[responseStatus(context, value)];
  if (!validator) {
    return value;
  }
  const body = value instanceof ElysiaStatus ? value.response : value;
  const encoder = validator as Validator & {
    EncodeFrom?: (body: unknown, type: string) => unknown;
  };
  const encoded = validator.mayReturnPromise
    ? validator.From?.(body, "response", adapter.transactionMode !== "sync")
    : encoder.EncodeFrom?.(body, "response");
  if (!(encoded instanceof Promise)) {
    return withStatus(value, encoded);
  }
  if (adapter.transactionMode === "sync") {
    throw new Error("[furin] Bun SQLite mutations require synchronous response validation.");
  }
  return encoded.then((result) => withStatus(value, result));
}

function prepare<Tx>(execution: Execution<Tx>, value: unknown, original: unknown) {
  const { context } = execution;
  const status = responseStatus(context, value);
  if (status < 200 || status >= 400) {
    throw new RejectedMutation(original);
  }
  const invalidate = resolveSyncInvalidations(execution.invalidate, context, original);
  execution.resolvedInvalidate = invalidate;
  appendQueryInvalidations(invalidate, context);
  const invalidations = [
    ...normalizedInvalidations(invalidate),
    ...pendingPathInvalidations(peekPendingInvalidations()),
  ];
  if (invalidations.length > 0) {
    context.set.headers["x-furin-sync"] = "1";
  }
  const paths = invalidations
    .filter((entry): entry is Extract<SyncInvalidation, { kind: "path" }> => entry.kind === "path")
    .map((entry) => (entry.type === "layout" ? `${entry.path}:layout` : entry.path));
  if (paths.length > 0) {
    context.set.headers["x-furin-revalidate"] = paths.join(",");
  }
  const finish = (stored: StoreResponseResult) => {
    if (stored.kind === "unreplayable") {
      throw new Error(
        "[furin] Atomic mutation responses must be bounded JSON, text or bodyless responses."
      );
    }
    let { headers } = context.set;
    if (value instanceof ElysiaStatus) {
      headers = { ...headers, ...value.headers };
    } else if (value instanceof Response) {
      headers = { ...headers, ...Object.fromEntries(value.headers) };
    }
    return {
      invalidations,
      response: mergeStoredResponseHeaders({ ...stored.response, status }, headers),
      value: original,
    };
  };
  return execution.adapter.transactionMode === "sync"
    ? finish(storeResponseSync(value, context.set))
    : storeResponse(value, context.set).then(finish);
}

function assertSynchronous(mode: "async" | "sync", value: unknown): void {
  if (
    mode === "sync" &&
    (value instanceof Promise || Object.prototype.toString.call(value) === "[object AsyncFunction]")
  ) {
    throw new Error("[furin] Bun SQLite mutation callbacks must be synchronous.");
  }
}

function invoke<Tx>(execution: Execution<Tx>, callback: (tx: Tx) => unknown, tx: Tx) {
  assertSynchronous(execution.adapter.transactionMode, callback);
  const value = callback(tx);
  assertSynchronous(execution.adapter.transactionMode, value);
  if (value instanceof Promise) {
    return value.then(async (original) =>
      prepare(execution, await validateResult(execution, original), original)
    );
  }
  const encoded = validateResult(execution, value);
  return encoded instanceof Promise
    ? encoded.then((result) => prepare(execution, result, value))
    : prepare(execution, encoded, value);
}

async function afterCommit<Tx>(execution: Execution<Tx>, result: CommittedMutation): Promise<void> {
  execution.onCommit(result);
  if (execution.resolvedInvalidate) {
    await runInvalidationRules(execution.resolvedInvalidate).catch(() =>
      getLogger().warn(
        "Sync cache invalidation failed after mutation; preserving the idempotent result"
      )
    );
    appendPendingInvalidationHeader(execution.context.set);
  }
  const { notifier } = execution.runtime;
  if (result.cursor !== undefined) {
    notifier.publish(result.cursor).catch(() => undefined);
  }
}

export async function executeAtomicMutation<Tx>(
  execution: Execution<Tx>,
  callback: (tx: Tx) => unknown
): Promise<unknown> {
  const { context } = execution;
  const previousSyncHeader = context.set.headers["x-furin-sync"];
  const previousPathHeader = context.set.headers["x-furin-revalidate"];
  const previousQueryHeader = context.set.headers["x-furin-queries"];
  let committed = false;
  try {
    const result = await execution.adapter.executeMutation(execution.lease, (tx) =>
      invoke(execution, callback, tx)
    );
    committed = true;
    await afterCommit(execution, result);
    return result.value;
  } catch (error) {
    if (!committed) {
      restoreHeader(context, "x-furin-sync", previousSyncHeader);
      restoreHeader(context, "x-furin-revalidate", previousPathHeader);
      restoreHeader(context, "x-furin-queries", previousQueryHeader);
    }
    if (error instanceof RejectedMutation) {
      return error.value;
    }
    throw error;
  }
}

function restoreHeader(
  context: Context,
  key: string,
  value: Context["set"]["headers"][string] | undefined
): void {
  if (value === undefined) {
    delete context.set.headers[key];
  } else {
    context.set.headers[key] = value;
  }
}

export function conflictResponse(reason: "in-progress" | "payload-mismatch"): Response {
  const inProgress = reason === "in-progress";
  return Response.json(
    {
      code: inProgress ? "FURIN_MUTATION_IN_PROGRESS" : "FURIN_IDEMPOTENCY_MISMATCH",
      message: inProgress
        ? "A mutation with this Idempotency-Key is still running."
        : "The Idempotency-Key was already used with a different request.",
    },
    {
      headers: inProgress ? { "retry-after": "1" } : undefined,
      status: 409,
    }
  );
}

export function normalizedInvalidations(input: InvalidationInput | undefined): SyncInvalidation[] {
  if (!input) {
    return [];
  }
  const rules = Array.isArray(input) ? input : [input];
  const invalidations: SyncInvalidation[] = [];
  for (const rule of rules) {
    if ("path" in rule && rule.path) {
      invalidations.push({ kind: "path", path: rule.path, type: rule.type });
    }
    if (rule.tags && rule.tags.length > 0) {
      invalidations.push({ kind: "tags", tags: [...rule.tags] });
    }
  }
  return invalidations;
}

export function pendingPathInvalidations(
  entries: readonly string[]
): Extract<SyncInvalidation, { kind: "path" }>[] {
  return entries.map((entry) =>
    entry.endsWith(":layout")
      ? { kind: "path" as const, path: entry.slice(0, -":layout".length), type: "layout" }
      : { kind: "path" as const, path: entry, type: "page" }
  );
}
