import { Elysia } from "elysia";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncAdapter, SyncChange, SyncSubscription } from "./adapter.ts";
import type { FurinSyncOptions } from "./config.ts";
import { syncRuntimeOptions } from "./config.ts";
import { type ResolvedSyncRuntime, resolveSyncRuntime } from "./runtime.ts";

export type { ChangePage as SyncChangePage, SyncChange } from "./adapter.ts";

const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const MAX_STREAM_CLIENTS = 100;
const MAX_CURSOR_LENGTH = 128;
const SAFETY_POLL_INTERVAL_MS = IS_DEV ? 250 : 15_000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const defaultStreamPath = "/_furin/sync";
const encoder = new TextEncoder();
const noOpSubscription: SyncSubscription = {
  unsubscribe: () => Promise.resolve(),
};

interface StreamState {
  clients: Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReturnType<typeof setInterval> | undefined
  >;
  cursor: string | undefined;
  safetyPoll: ReturnType<typeof setInterval> | undefined;
  subscription: SyncSubscription;
}

const streams = new Map<SyncAdapter, Promise<StreamState>>();
const resolvedStates = new Set<StreamState>();

function encodeSseCursor(cursor: string): Uint8Array {
  return encoder.encode(
    `id: ${cursor}\nevent: furin.sync\nretry: 3000\ndata: ${JSON.stringify({ cursor })}\n\n`
  );
}

function closeClient(
  state: StreamState,
  client: ReadableStreamDefaultController<Uint8Array>
): void {
  const heartbeat = state.clients.get(client);
  state.clients.delete(client);
  if (heartbeat) {
    clearInterval(heartbeat);
  }
  try {
    client.close();
  } catch {
    // already closed
  }
}

function notifyState(state: StreamState, cursor: string): void {
  if (state.cursor === cursor) {
    return;
  }
  state.cursor = cursor;
  const chunk = encodeSseCursor(cursor);
  for (const client of state.clients.keys()) {
    if (client.desiredSize === null || client.desiredSize <= 0) {
      closeClient(state, client);
      continue;
    }
    try {
      client.enqueue(chunk);
    } catch {
      closeClient(state, client);
    }
  }
}

async function createStreamState(runtime: ResolvedSyncRuntime): Promise<StreamState> {
  const state = {} as StreamState;
  state.clients = new Map();
  state.cursor = await runtime.adapter.currentCursor();
  if (runtime.notifier.recovery !== "self") {
    state.safetyPoll = setInterval(() => {
      runtime.adapter
        .currentCursor()
        .then((cursor) => notifyState(state, cursor))
        .catch(() => undefined);
    }, SAFETY_POLL_INTERVAL_MS);
    state.safetyPoll.unref?.();
  }
  state.subscription = await runtime.notifier
    .subscribe((cursor) => notifyState(state, cursor))
    .catch(() => noOpSubscription);
  resolvedStates.add(state);
  return state;
}

function getStreamState(runtime: ResolvedSyncRuntime): Promise<StreamState> {
  const existing = streams.get(runtime.adapter);
  if (existing) {
    return existing;
  }
  const state = createStreamState(runtime);
  streams.set(runtime.adapter, state);
  state.catch(() => {
    if (streams.get(runtime.adapter) === state) {
      streams.delete(runtime.adapter);
    }
  });
  return state;
}

function parseChangeQuery(
  request: Request
): { after: string | undefined; limit: number } | { error: Response } {
  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? undefined;
  if (after !== undefined && (after.length === 0 || after.length > MAX_CURSOR_LENGTH)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_CURSOR" }, { status: 400 }) };
  }
  const limitValue = url.searchParams.get("limit");
  if (limitValue !== null && !UNSIGNED_INTEGER_PATTERN.test(limitValue)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  const limit = limitValue === null ? DEFAULT_CHANGE_LIMIT : Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  return { after, limit };
}

function clientInvalidations(change: SyncChange): string[] {
  const entries = new Set<string>();
  for (const invalidation of change.invalidations) {
    if (invalidation.kind === "tags") {
      entries.add("/:layout");
    } else {
      entries.add(
        invalidation.type === "layout" ? `${invalidation.path}:layout` : invalidation.path
      );
    }
  }
  return [...entries];
}

export function createSyncStreamPlugin(options: FurinSyncOptions) {
  const streamPath = options.streamPath ?? defaultStreamPath;
  const runtime = resolveSyncRuntime(syncRuntimeOptions(options));
  return new Elysia({ name: `furin-sync-stream-${streamPath}` })
    .get(`${streamPath}/changes`, async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const query = parseChangeQuery(request);
      if ("error" in query) {
        return query.error;
      }
      const page = await runtime.adapter.readChanges(query);
      return {
        ...page,
        changes: page.changes.map((change) => ({
          cursor: change.cursor,
          invalidations: clientInvalidations(change),
        })),
      };
    })
    .get(streamPath, async () => {
      const state = await getStreamState(runtime);
      if (state.clients.size >= MAX_STREAM_CLIENTS) {
        return Response.json({ code: "FURIN_SYNC_STREAM_CAPACITY" }, { status: 503 });
      }
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          if (controllerRef) {
            closeClient(state, controllerRef);
          }
          if (heartbeat) {
            clearInterval(heartbeat);
          }
        },
        start(controller) {
          controllerRef = controller;
          controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));
          state.clients.set(controller, undefined);
          heartbeat = setInterval(() => {
            if (controller.desiredSize === null || controller.desiredSize <= 0) {
              closeClient(state, controller);
              return;
            }
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              closeClient(state, controller);
            }
          }, 15_000);
          heartbeat.unref?.();
          state.clients.set(controller, heartbeat);
        },
      });

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    });
}

/** @internal — closes process-local stream state between tests. */
export function __resetSyncState(): void {
  for (const state of resolvedStates) {
    state.subscription.unsubscribe().catch(() => undefined);
    if (state.safetyPoll) {
      clearInterval(state.safetyPoll);
    }
    for (const client of state.clients.keys()) {
      closeClient(state, client);
    }
  }
  streams.clear();
  resolvedStates.clear();
}
