import { type Context, Elysia, ElysiaStatus } from "elysia";
import { type QueryReadIdentity, serializeQueryHeader } from "../../shared/sync-query.ts";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import { peekPendingInvalidations } from "../cache/invalidation.ts";
import { getLogger } from "../context-logger.ts";
import { ensureRequestScope } from "../instance.ts";
import { IS_DEV } from "../runtime-env.ts";
import type {
  MutationLease,
  StoredResponse,
  SyncAdapter,
  SyncInvalidation,
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
import { principalHash } from "./principal-journal.ts";
import {
  appendQueryInvalidations,
  isInternalRead,
  isMutationMethod,
  requestInvalidate,
  resolveSyncInvalidations,
  sealInvalidations,
  urlIdentity,
} from "./queries.ts";
import {
  effectiveResponseHeaders,
  mergeStoredResponseHeaders,
  replayResponse,
  storeResponse,
} from "./response.ts";
import { publishCursor, resolveSyncRuntime } from "./runtime.ts";
import { bindSyncValidation, syncValidationApp } from "./validation.ts";

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

const nonIdempotent = new WeakSet<Request>();
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

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function invalidIdempotencyKeyResponse(): Response {
  return Response.json(
    {
      code: "FURIN_INVALID_IDEMPOTENCY_KEY",
      detail: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters.`,
      status: 400,
      title: "Bad Request",
      type: "about:blank",
    },
    { headers: { "content-type": "application/problem+json" }, status: 400 }
  );
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

/** `idempotent: false`: no Idempotency-Key, replay or `mutation()`; invalidations still apply. */
function idempotentRouteMacro(_idempotent: false) {
  return {
    transform({ request }: Pick<Context, "request">) {
      nonIdempotent.add(request);
    },
  };
}

function createSyncPlugin<Adapter extends SyncAdapter>(
  options: SyncRuntimeOptions<Adapter>,
  owner: SyncOwner
) {
  // furinSync() belongs to no Furin runtime: it follows the default mode.
  const runtime = resolveSyncRuntime(options, IS_DEV);
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
            runtime,
            onCommit: (result) => atomicResponses.set(ctx.request, result),
          },
          callback
        );
      } finally {
        sealInvalidations(ctx.request);
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
    // Without a client key the mutation still runs and syncs; it is just not deduplicated.
    const idempotencyKey = getIdempotencyKey(ctx) ?? crypto.randomUUID();
    if (
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      !PRINTABLE_ASCII.test(idempotencyKey)
    ) {
      return invalidIdempotencyKeyResponse();
    }
    if (!supportsReplayBody(ctx.request)) {
      return Response.json(
        {
          code: "FURIN_UNSUPPORTED_SYNC_BODY",
          message: "This request body cannot be replayed. Set idempotent: false on the route.",
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

  /** Purges caches, reports the invalidations to the caller and returns them for the journal. */
  async function applyInvalidations(ctx: CompletionContext): Promise<SyncInvalidation[]> {
    const manualPending = peekPendingInvalidations();
    const invalidate = resolveSyncInvalidations(ctx as Context);
    appendQueryInvalidations(invalidate, ctx);
    try {
      await runInvalidationRules(invalidate);
    } catch {
      getLogger().warn("Sync cache invalidation failed after mutation; preserving its result");
    }
    appendPendingInvalidationHeader(ctx.set);
    ctx.set.headers["x-furin-sync"] = "1";
    const semanticInvalidations = normalizedInvalidations(invalidate);
    return [
      ...semanticInvalidations,
      ...pendingPathInvalidations(manualPending).filter(
        (manual) =>
          !semanticInvalidations.some(
            (semantic) =>
              semantic.kind === "path" &&
              semantic.path === manual.path &&
              semantic.type === manual.type
          )
      ),
    ];
  }

  async function persistMutation(
    ctx: CompletionContext,
    active: ActiveMutation
  ): Promise<Response | undefined> {
    const result = await storeResponse(ctx.responseValue, ctx.set);
    const invalidations = await applyInvalidations(ctx);
    const response = mergeStoredResponseHeaders(
      result.response,
      result.kind === "unreplayable"
        ? ctx.set.headers
        : effectiveResponseHeaders(ctx.responseValue, ctx.set)
    );
    const completion = await runtime.adapter.completeMutation({
      invalidations,
      lease: active.lease,
      response,
    });
    if (completion.kind === "lost") {
      return leaseLostResponse();
    }
    if (completion.cursor !== undefined) {
      publishCursor(runtime, completion.cursor);
    }
    if (result.kind === "unreplayable") {
      return replayResponse(response);
    }
  }

  /** A non-idempotent mutation already ran: a journal failure must not turn it into an error. */
  async function journalMutation(ctx: CompletionContext): Promise<undefined> {
    if (!(isMutationMethod(ctx.request.method) && isSuccessfulMutationResponse(ctx))) {
      return;
    }
    const invalidations = await applyInvalidations(ctx);
    try {
      publishCursor(runtime, await runtime.adapter.appendInvalidations(invalidations));
    } catch {
      getLogger().warn("Sync journal append failed after a non-idempotent mutation");
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
    .wrap(
      (fetch) =>
        (request, ...rest) =>
          ensureRequestScope(() => fetch(request, ...rest))
    )
    .derive("global", (ctx) => ({
      mutation: (requestOwners.get(ctx.request) ?? owner).mutationFor(ctx) as SyncMutation<Adapter>,
      invalidate: requestInvalidate(ctx.request),
    }))
    .onBeforeHandle("global", (context) => {
      if (
        requestOwners.get(context.request) === owner &&
        isMutationMethod(context.request.method) &&
        !nonIdempotent.has(context.request)
      ) {
        prepareMutationHandler(context, () => beginMutation(context));
      }
    })
    .onAfterHandle(
      "global",
      hideTransportResponse((context: CompletionContext) => {
        if (requestOwners.get(context.request) !== owner) {
          return Promise.resolve(undefined);
        }
        return nonIdempotent.has(context.request)
          ? journalMutation(context)
          : finishMutation(context);
      })
    )
    .onAfterHandle("global", async (ctx) => {
      if (requestOwners.get(ctx.request) !== owner) {
        return;
      }
      // Data GETs only: a raw Response (a Furin page, a file, a stream) is no live query.
      if (
        ctx.request.method !== "GET" ||
        isInternalRead(ctx.request) ||
        ctx.responseValue instanceof Response ||
        !isSuccessfulMutationResponse({
          set: ctx.set,
          responseValue: ctx.responseValue instanceof ElysiaStatus ? ctx.responseValue : undefined,
        })
      ) {
        return;
      }
      const principal = await options.principal(ctx as Context);
      if (principal.length === 0) {
        throw new Error("[furin] Sync principal must not be empty.");
      }
      const identity: QueryReadIdentity = {
        ...urlIdentity(ctx),
        session: principalHash(options.adapter, principal),
      };
      ctx.set.headers["x-furin-query"] = serializeQueryHeader(identity);
    })
    .onError(
      "global",
      MutationLeaseLost,
      hideTransportResponse(({ request }: { request: Request }) =>
        Promise.resolve(requestOwners.get(request) === owner ? leaseLostResponse() : undefined)
      )
    )
    .onError(
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
    .macro({ idempotent: idempotentRouteMacro });
  return plugin;
}

/** Whether a `furinSync()` runtime owns the request's route. */
export function isSyncRequest(request: Request): boolean {
  return requestOwners.has(request);
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
    app.onTransform(({ request }) => {
      requestOwners.set(request, routeOwner);
    });
    installMutationHandlers(app);
    if ("executeMutation" in options.adapter) {
      bindSyncValidation(app);
    }
    return app.use(createSyncPlugin(options, owner));
  };
}
