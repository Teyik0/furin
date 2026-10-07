import { type Context, Elysia, ElysiaStatus } from "elysia";
import { queryTag, serializeQueryHeader } from "../../shared/sync-query.ts";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { peekPendingInvalidations } from "../cache/invalidation.ts";
import { getLogger } from "../context-logger.ts";
import type {
  MutationLease,
  StoredResponse,
  SyncAdapter,
  SyncMutation,
  SyncRuntimeOptions,
  SyncTransaction,
  TransactionalSyncAdapter,
} from "./adapter.ts";
import {
  conflictResponse,
  executeAtomicMutation,
  normalizedInvalidations,
  pendingPathInvalidations,
} from "./atomic.ts";
import { MutationLeaseLost } from "./execution-error.ts";
import { createMutationFingerprint } from "./fingerprint.ts";
import { installMutationHandlers, prepareMutationHandler } from "./mutation-handler.ts";
import {
  appendQueryInvalidations,
  resolveSyncInvalidations,
  type SyncInvalidationSelector,
  type SyncReadOption,
} from "./queries.ts";
import {
  effectiveResponseHeaders,
  mergeStoredResponseHeaders,
  replayResponse,
  storeResponse,
} from "./response.ts";
import { resolveSyncRuntime } from "./runtime.ts";
import { bindSyncValidation, syncValidationApp } from "./validation.ts";

export type SyncRouteOption =
  | false
  | InvalidationInput
  | SyncReadOption
  | {
      invalidate: SyncInvalidationSelector;
    };

/** @deprecated Use SyncRouteOption. */
export type SyncInput = Exclude<SyncRouteOption, false>;

interface RouteSyncMetadata {
  disabled: boolean;
  invalidate?: SyncInvalidationSelector;
  read?: SyncReadOption;
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

type CompletionContext = MutationContext & Parameters<typeof isSuccessfulMutationResponse>[0];

const routeMetadata = new WeakMap<Request, RouteSyncMetadata>();
const activeMutations = new WeakMap<Request, ActiveMutation>();
const atomicCalls = new WeakSet<Request>();
const atomicResponses = new WeakMap<Request, { response: StoredResponse; value: unknown }>();
interface SyncOwner {
  id: number;
  mutationFor: (context: MutationContext & Pick<Context, "set">) => unknown;
}
const syncOwners = new WeakMap<SyncRuntimeOptions<SyncAdapter>, SyncOwner>();
const requestOwners = new WeakMap<Request, SyncOwner>();
let ownerId = 0;

function hideTransportResponse<TContext>(
  hook: (context: TContext) => Promise<Response | undefined>
): TransportHook<TContext> {
  // Sync responses short-circuit Elysia at runtime; they are not route success payloads for Eden.
  return hook as TransportHook<TContext>;
}

function invalidationInputFromSync(
  input: Exclude<SyncRouteOption, false>
): SyncInvalidationSelector | undefined {
  if (input && typeof input === "object" && "invalidate" in input) {
    return input.invalidate;
  }
  if ("id" in input) {
    return;
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

function leaseLostResponse(): Response {
  return Response.json(
    {
      code: "FURIN_SYNC_LEASE_LOST",
      message: "The mutation lease was lost before its response could be committed.",
    },
    { status: 503 }
  );
}

function syncRouteMacro(input: SyncRouteOption) {
  return {
    transform({ request }: Pick<Context, "request">) {
      routeMetadata.set(
        request,
        input === false
          ? { disabled: true }
          : {
              disabled: false,
              invalidate: invalidationInputFromSync(input),
              read: "id" in input ? input : undefined,
            }
      );
    },
  };
}

function createSyncPlugin<Adapter extends SyncAdapter>(
  options: SyncRuntimeOptions<Adapter>,
  owner: SyncOwner
) {
  const runtime = resolveSyncRuntime(options);
  const transactional =
    "executeMutation" in options.adapter
      ? (options.adapter as Adapter &
          TransactionalSyncAdapter<SyncTransaction<Adapter>, "async" | "sync">)
      : undefined;

  function mutationFor(ctx: MutationContext & Pick<Context, "set">): SyncMutation<Adapter> {
    const mutation = async (callback: (tx: SyncTransaction<Adapter>) => unknown) => {
      const active = activeMutations.get(ctx.request);
      if (!(transactional && active)) {
        throw new Error(
          "[furin] mutation() requires a transactional sync adapter and an enabled mutation route."
        );
      }
      if (atomicCalls.has(ctx.request)) {
        throw new Error("[furin] Call mutation() once and return its result from the handler.");
      }
      atomicCalls.add(ctx.request);
      try {
        return await executeAtomicMutation(
          {
            adapter: transactional,
            app: syncValidationApp(ctx as Context),
            context: ctx as Context,
            lease: active.lease,
            invalidate: routeMetadata.get(ctx.request)?.invalidate,
            runtime,
            onCommit: (result) => atomicResponses.set(ctx.request, result),
          },
          callback
        );
      } finally {
        if (atomicResponses.has(ctx.request)) {
          releaseMutation(ctx.request);
        } else {
          await abortMutation(ctx.request).catch(() => undefined);
        }
        atomicCalls.delete(ctx.request);
      }
    };
    return mutation as SyncMutation<Adapter>;
  }

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

  function releaseMutation(request: Request): ActiveMutation | undefined {
    const active = activeMutations.get(request);
    activeMutations.delete(request);
    if (active?.renewal) {
      clearTimeout(active.renewal);
    }
    return active;
  }

  async function abortMutation(request: Request): Promise<void> {
    const active = releaseMutation(request);
    if (active) {
      await runtime.adapter.abortMutation(active.lease);
    }
  }

  async function persistMutation(
    ctx: CompletionContext,
    active: ActiveMutation
  ): Promise<Response | undefined> {
    const result = await storeResponse(ctx.responseValue, ctx.set);
    const manualPending = peekPendingInvalidations();
    const invalidate = resolveSyncInvalidations(
      routeMetadata.get(ctx.request)?.invalidate,
      ctx as Context,
      ctx.responseValue
    );
    appendQueryInvalidations(invalidate, ctx);
    const logger = getLogger();
    if (invalidate) {
      try {
        await runInvalidationRules(invalidate);
      } catch {
        logger.warn(
          "Sync cache invalidation failed after mutation; preserving the idempotent result"
        );
      }
    }
    const pending = appendPendingInvalidationHeader(ctx.set);
    if (pending.length > 0) {
      ctx.set.headers["x-furin-sync"] = "1";
    }
    const response = mergeStoredResponseHeaders(
      result.response,
      effectiveResponseHeaders(ctx.responseValue, ctx.set)
    );
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
      runtime.adapter.publishesNotifications !== false &&
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
    const atomic = atomicResponses.get(ctx.request);
    atomicResponses.delete(ctx.request);
    atomicCalls.delete(ctx.request);
    if (atomic && ctx.responseValue === atomic.value) {
      if (atomic.value instanceof Response) {
        return atomic.value;
      }
      if (atomic.value instanceof ElysiaStatus) {
        ctx.set.status = atomic.value.status;
        Object.assign(ctx.set.headers, atomic.value.headers);
      }
      return replayResponse(atomic.response);
    }
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

  owner.mutationFor = mutationFor;
  const plugin = new Elysia({ name: `furin-sync:${owner.id}` })
    .derive("global", (ctx) => ({
      mutation: (requestOwners.get(ctx.request) ?? owner).mutationFor(ctx) as SyncMutation<Adapter>,
    }))
    .beforeHandle("global", (context) => {
      if (
        requestOwners.get(context.request) === owner &&
        isMutationMethod(context.request.method) &&
        !routeMetadata.get(context.request)?.disabled
      ) {
        prepareMutationHandler(context, () => beginMutation(context));
      }
    })
    .afterHandle(
      "global",
      hideTransportResponse((context: CompletionContext) =>
        requestOwners.get(context.request) === owner
          ? finishMutation(context)
          : Promise.resolve(undefined)
      )
    )
    .afterHandle("global", async (ctx) => {
      if (requestOwners.get(ctx.request) !== owner) {
        return;
      }
      const read = routeMetadata.get(ctx.request)?.read;
      if (
        ctx.request.method !== "GET" ||
        !read ||
        !isSuccessfulMutationResponse({
          set: ctx.set,
          responseValue:
            ctx.responseValue instanceof Response || ctx.responseValue instanceof ElysiaStatus
              ? ctx.responseValue
              : undefined,
        })
      ) {
        return;
      }
      const principal = await options.principal(ctx as Context);
      if (principal.length === 0) {
        throw new Error("[furin] Sync principal must not be empty.");
      }
      const identity = {
        id: read.id,
        scope: typeof read.scope === "function" ? read.scope(ctx as Context) : (read.scope ?? {}),
        session: new Bun.CryptoHasher("sha256").update(principal).digest("hex"),
      };
      queryTag(identity);
      ctx.set.headers["x-furin-query"] = serializeQueryHeader(identity);
    })
    .error(
      "global",
      MutationLeaseLost,
      hideTransportResponse(({ request }: { request: Request }) =>
        Promise.resolve(requestOwners.get(request) === owner ? leaseLostResponse() : undefined)
      )
    )
    .error(
      "global",
      hideTransportResponse(async ({ request }: { request: Request }) => {
        if (requestOwners.get(request) !== owner) {
          return;
        }
        atomicResponses.delete(request);
        atomicCalls.delete(request);
        await abortMutation(request);
      })
    )
    .macro({ sync: syncRouteMacro });
  return plugin;
}

export function furinSync<Adapter extends SyncAdapter>(options: SyncRuntimeOptions<Adapter>) {
  return (app: Elysia) => {
    let owner = syncOwners.get(options);
    if (!owner) {
      ownerId += 1;
      owner = { id: ownerId, mutationFor: () => undefined };
      syncOwners.set(options, owner);
    }
    const routeOwner = owner;
    app.transform(({ request }) => {
      requestOwners.set(request, routeOwner);
    });
    installMutationHandlers(app);
    if ("executeMutation" in options.adapter) {
      bindSyncValidation(app);
    }
    return app.use(createSyncPlugin(options, owner));
  };
}
