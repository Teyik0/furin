import { type Context, Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { peekPendingInvalidations } from "../cache/invalidation.ts";
import type { MutationLease, SyncInvalidation, SyncRuntimeOptions } from "./adapter.ts";
import { createMutationFingerprint } from "./fingerprint.ts";
import { mergeStoredResponseHeaders, replayResponse, storeResponse } from "./response.ts";
import { resolveSyncRuntime } from "./runtime.ts";

export type SyncRouteOption =
  | false
  | InvalidationInput
  | {
      invalidate: InvalidationInput;
    };

/** @deprecated Use SyncRouteOption. */
export type SyncInput = Exclude<SyncRouteOption, false>;

interface RouteSyncMetadata {
  disabled: boolean;
  invalidate?: InvalidationInput;
}

interface ActiveMutation {
  lease: MutationLease;
  renewal: ReturnType<typeof setTimeout> | undefined;
}

interface MutationContext {
  body?: unknown;
  headers: {
    "idempotency-key"?: string | undefined;
  };
  request: Request;
}

type TransportHook<TContext> = (context: TContext) => Promise<void>;

type CompletionContext = MutationContext &
  Pick<Context, "set"> & {
    response?: unknown;
    responseValue?: unknown;
  };
type PathInvalidation = Extract<SyncInvalidation, { kind: "path" }>;

const routeMetadata = new WeakMap<Request, RouteSyncMetadata>();
const activeMutations = new WeakMap<Request, ActiveMutation>();

function hideTransportResponse<TContext>(
  hook: (context: TContext) => Promise<Response | undefined>
): TransportHook<TContext> {
  // Sync responses short-circuit Elysia at runtime; they are not route success payloads for Eden.
  return hook as TransportHook<TContext>;
}

function invalidationInputFromSync(input: Exclude<SyncRouteOption, false>): InvalidationInput {
  if (input && typeof input === "object" && "invalidate" in input) {
    return input.invalidate;
  }
  return input;
}

function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function getIdempotencyKey(ctx: MutationContext): string | undefined {
  const fromCtxHeaders = ctx.headers["idempotency-key"];
  if (typeof fromCtxHeaders === "string" && fromCtxHeaders.length > 0) {
    return fromCtxHeaders;
  }
  const fromRequest = ctx.request.headers.get("Idempotency-Key");
  return fromRequest || undefined;
}

function supportsReplayBody(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  const mediaType = contentType?.split(";", 1)[0]?.trim();
  return (
    contentType === undefined ||
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json")) ||
    contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("text/")
  );
}

function conflictResponse(reason: "in-progress" | "payload-mismatch"): Response {
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

function leaseLostResponse(): Response {
  return Response.json(
    {
      code: "FURIN_SYNC_LEASE_LOST",
      message: "The mutation lease was lost before its response could be committed.",
    },
    { status: 503 }
  );
}

function normalizedInvalidations(input: InvalidationInput | undefined): SyncInvalidation[] {
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

function pendingPathInvalidations(entries: readonly string[]): PathInvalidation[] {
  return entries.map((entry) =>
    entry.endsWith(":layout")
      ? { kind: "path" as const, path: entry.slice(0, -":layout".length), type: "layout" }
      : { kind: "path" as const, path: entry, type: "page" }
  );
}

export function furinSync(options: SyncRuntimeOptions) {
  const runtime = resolveSyncRuntime(options);

  async function beginMutation(ctx: MutationContext): Promise<Response | undefined> {
    if (!isMutationMethod(ctx.request.method) || routeMetadata.get(ctx.request)?.disabled) {
      return;
    }
    const idempotencyKey = getIdempotencyKey(ctx);
    if (!idempotencyKey) {
      return new Response("Missing Idempotency-Key header", {
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 428,
      });
    }
    if (!supportsReplayBody(ctx.request)) {
      return Response.json(
        {
          code: "FURIN_UNSUPPORTED_SYNC_BODY",
          message: "This request body cannot be replayed. Set sync: false on the route.",
        },
        { status: 415 }
      );
    }

    const url = new URL(ctx.request.url);
    const principal = await options.principal(ctx as Context);
    if (principal.length === 0) {
      throw new Error("[furin] Sync principal must not be empty.");
    }
    const key = `${ctx.request.method}:${url.pathname}:${idempotencyKey}`;
    const fingerprint = createMutationFingerprint({ body: ctx.body, request: ctx.request });
    const result = await runtime.adapter.beginMutation({ fingerprint, key, principal });
    if (result.kind === "replay") {
      return replayResponse(result.response);
    }
    if (result.kind === "conflict") {
      return conflictResponse(result.reason);
    }
    const active: ActiveMutation = { lease: result.lease, renewal: undefined };
    const renewAfter = Math.max(1000, Math.floor(result.lease.leaseMs / 3));
    const scheduleRenewal = () => {
      active.renewal = setTimeout(async () => {
        if (activeMutations.get(ctx.request) === active) {
          scheduleRenewal();
        }
        await runtime.adapter.renewMutation(result.lease).catch(() => undefined);
      }, renewAfter);
      active.renewal.unref?.();
    };
    activeMutations.set(ctx.request, active);
    scheduleRenewal();
  }

  async function abortMutation(request: Request): Promise<void> {
    const active = activeMutations.get(request);
    if (!active) {
      return;
    }
    activeMutations.delete(request);
    if (active.renewal) {
      clearTimeout(active.renewal);
    }
    await runtime.adapter.abortMutation(active.lease);
  }

  async function persistMutation(
    ctx: CompletionContext,
    active: ActiveMutation
  ): Promise<Response | undefined> {
    const result = await storeResponse(ctx.responseValue, ctx.set);
    const manualPending = peekPendingInvalidations();
    const invalidate = routeMetadata.get(ctx.request)?.invalidate;
    if (invalidate) {
      runInvalidationRules(invalidate);
    }
    const pending = appendPendingInvalidationHeader(ctx.set);
    if (pending.length > 0) {
      ctx.set.headers["x-furin-sync"] = "1";
    }
    const response = mergeStoredResponseHeaders(result.response, ctx.set.headers);
    const semanticInvalidations = normalizedInvalidations(invalidate);
    const invalidations = [...semanticInvalidations];
    for (const manual of pendingPathInvalidations(manualPending)) {
      const duplicated = semanticInvalidations.some(
        (semantic) =>
          semantic.kind === "path" && semantic.path === manual.path && semantic.type === manual.type
      );
      if (!duplicated) {
        invalidations.push(manual);
      }
    }
    const completion = await runtime.adapter.completeMutation({
      invalidations,
      lease: active.lease,
      response,
    });
    if (completion.kind === "lost") {
      return leaseLostResponse();
    }
    const notificationAlreadyPublished =
      runtime.adapter.notificationChannel !== undefined &&
      runtime.adapter.notificationChannel === runtime.notifier.notificationChannel;
    if (completion.cursor !== undefined && !notificationAlreadyPublished) {
      runtime.notifier.publish(completion.cursor).catch(() => undefined);
    }
    if (result.kind === "unreplayable") {
      return replayResponse(response);
    }
  }

  async function finishMutation(ctx: CompletionContext): Promise<Response | undefined> {
    const active = activeMutations.get(ctx.request);
    if (!active) {
      return;
    }
    try {
      if (!isSuccessfulMutationResponse(ctx)) {
        await runtime.adapter.abortMutation(active.lease);
        return;
      }
      return await persistMutation(ctx, active);
    } catch (error) {
      await runtime.adapter.abortMutation(active.lease).catch(() => undefined);
      throw error;
    } finally {
      activeMutations.delete(ctx.request);
      if (active.renewal) {
        clearTimeout(active.renewal);
      }
    }
  }

  const beginMutationHook = hideTransportResponse(beginMutation);
  const finishMutationHook = hideTransportResponse(finishMutation);

  return new Elysia({ name: "furin-sync" })
    .macro({
      sync(input: SyncRouteOption) {
        return {
          transform({ request }) {
            routeMetadata.set(
              request,
              input === false
                ? { disabled: true }
                : { disabled: false, invalidate: invalidationInputFromSync(input) }
            );
          },
        };
      },
    })
    .onBeforeHandle({ as: "global" }, beginMutationHook)
    .onAfterHandle({ as: "global" }, finishMutationHook)
    .onError({ as: "global" }, ({ request }) => abortMutation(request));
}
