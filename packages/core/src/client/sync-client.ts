import {
  LIVE_QUERY,
  type LiveQuery,
  QueryStore,
  type ReadReference,
  type ReadResult,
} from "./query-store.ts";
import { createSyncCatchUp, type SyncChangePagePayload } from "./sync-catch-up.ts";

const LEADING_SLASH = /^\//;

interface SyncSocketEvents {
  close: { code: number };
  error: unknown;
  message: { data: unknown };
}

/** The common event API implemented by native WebSocket and runtime socket adapters. */
export interface SyncSocket {
  addEventListener: <Event extends keyof SyncSocketEvents>(
    type: Event,
    listener: (event: SyncSocketEvents[Event]) => void
  ) => void;
  close: () => void;
  readonly readyState: number;
  removeEventListener: <Event extends keyof SyncSocketEvents>(
    type: Event,
    listener: (event: SyncSocketEvents[Event]) => void
  ) => void;
}

// Entrypoints bundle Eden separately, so constructor identity cannot identify its errors.
function isEdenError(error: unknown): error is Error & { status: number; value: unknown } {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    "value" in error
  );
}

function closeSocket(socket: SyncSocket): void {
  if (socket.readyState === 3) {
    return;
  }
  // Runtime adapters such as ws emit an error when closed during their handshake.
  const onError = () => undefined;
  const onClose = () => {
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
  };
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  socket.close();
}

export class SyncClientError extends Error {
  readonly status: number | undefined;

  // Public server and client entrypoints bundle this class separately.
  static override [Symbol.hasInstance](error: unknown): boolean {
    return error instanceof Error && error.name === "SyncClientError" && "status" in error;
  }

  constructor(message: string, status: number | undefined, cause?: unknown) {
    super(message, { cause });
    this.name = "SyncClientError";
    this.status = status;
  }
}

export interface SyncConnectionState {
  error: SyncClientError | null;
  /** Why a connection is being restarted; absent when idle or connected. */
  reason?: "network" | "credentials" | "context";
  status: "idle" | "connecting" | "connected" | "reconnecting" | "unauthorized" | "closed";
}

export interface SyncClientOptions {
  /** Runtime adapter only: Furin handles envelopes, recovery and reconnection. */
  createWebSocket?: (url: string, headers: Headers) => SyncSocket | Promise<SyncSocket>;
  fetch?: Omit<RequestInit, "headers" | "signal" | "method" | "body">;
  fetcher?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Relative to the application URL. Defaults to _furin/sync. */
  syncPath?: string;
  /** Absolute Furin application URL, including its mount path. */
  url: string;
}

export interface SyncQueryState<Result extends ReadResult> {
  data: NonNullable<Result["data"]> | undefined;
  error: Result["error"] | SyncClientError | null;
  isFetching: boolean;
}

export interface SyncClient {
  close: () => void;
  getConnectionState: () => SyncConnectionState;
  /** Reauthenticate and reevaluate reads; clears snapshots and cursor unless preservation is explicit. */
  reconnect: (options?: SyncReconnectOptions) => void;
  subscribe: <Result extends ReadResult>(
    query: LiveQuery<Result>,
    listener: (state: SyncQueryState<Result>) => void
  ) => () => void;
  subscribeConnection: (listener: (state: SyncConnectionState) => void) => () => void;
}

export interface SyncReconnectOptions {
  /** Only retain snapshots for renewal within the same identity and access scope. */
  preserveCache?: boolean;
}

interface SyncTransportSubscription {
  headers: Headers;
  onContextChange: () => void;
  onCursor: () => void;
  onError: (error: unknown) => void;
  signal: AbortSignal;
}

/** @internal The local and remote adapters share one cache and recovery lifecycle. */
export interface SyncTransport {
  accepts: (reference: ReadReference) => boolean;
  fetchChanges: (
    after: string | undefined,
    headers: Headers,
    signal: AbortSignal
  ) => Promise<Response>;
  subscribe: (options: SyncTransportSubscription) => Promise<() => void>;
}

interface SyncConnection {
  stop?: () => void;
}

/** One server and authentication context, with one socket shared by all subscribers. */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  if (options.headers !== undefined && !options.createWebSocket) {
    throw new SyncClientError(
      "Sync headers require a createWebSocket adapter for this runtime",
      undefined
    );
  }
  const base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
  const changesUrl = new URL(
    `${options.syncPath?.replace(LEADING_SLASH, "") ?? "_furin/sync"}/changes`,
    base
  );
  const eventsUrl = new URL("_furin/events", base);
  eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
  return createSyncClientRuntime(options, {
    accepts: (reference) => new URL(reference.url).origin === base.origin,
    fetchChanges: (after, headers, signal) => {
      const url = new URL(changesUrl);
      url.searchParams.set("after", after ?? "0");
      return (options.fetcher ?? globalThis.fetch)(url, { ...options.fetch, headers, signal });
    },
    subscribe: async ({ headers, onCursor, onContextChange, onError: fail }) => {
      const connection: SyncSocket = options.createWebSocket
        ? await options.createWebSocket(eventsUrl.href, headers)
        : new WebSocket(eventsUrl.href);
      const onMessage = (event: SyncSocketEvents["message"]) => {
        let message: {
          version?: number;
          channel?: string;
          data?: { cursor?: unknown; context?: unknown };
        };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message?.version === 1 && message.channel === "sync") {
          if (message.data?.context === "changed") {
            onContextChange();
          } else if (typeof message.data?.cursor === "string") {
            onCursor();
          }
        }
      };
      const onClose = (event: SyncSocketEvents["close"]) => {
        if (event.code === 4410) {
          onContextChange();
          return;
        }
        let status: number | undefined;
        if (event.code === 1008 || event.code === 4401) {
          status = 401;
        } else if (event.code === 4403) {
          status = 403;
        }
        fail(new SyncClientError("Sync socket closed", status));
      };
      const onError = () => fail(new SyncClientError("Sync socket failed", undefined));
      connection.addEventListener("message", onMessage);
      connection.addEventListener("close", onClose);
      connection.addEventListener("error", onError);
      // An async factory may return after the server's initial cursor notification.
      if (connection.readyState === 1) {
        onCursor();
      } else if (connection.readyState > 1) {
        fail(new SyncClientError("Sync socket closed before subscribing", undefined));
      }
      return () => {
        connection.removeEventListener("message", onMessage);
        connection.removeEventListener("close", onClose);
        connection.removeEventListener("error", onError);
        closeSocket(connection);
      };
    },
  });
}

/** @internal Constructed by the public local and remote factories. */
export function createSyncClientRuntime(
  options: Pick<SyncClientOptions, "headers" | "fetch">,
  transport: SyncTransport
): SyncClient {
  const queries = new QueryStore(undefined);
  const listeners = new Set<(state: SyncConnectionState) => void>();
  const subscriptions = new Map<() => void, string>();
  let state: SyncConnectionState = { status: "idle", error: null };
  let controller = new AbortController();
  let ready = Promise.withResolvers<void>();
  let connection: SyncConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let session: string | undefined;

  const publish = (
    status: SyncConnectionState["status"],
    error: SyncClientError | null,
    reason?: SyncConnectionState["reason"]
  ) => {
    state = { status, error, reason };
    for (const listener of listeners) {
      listener(state);
    }
  };
  const headers = async () =>
    new Headers(typeof options.headers === "function" ? await options.headers() : options.headers);
  const asError = (error: unknown) =>
    error instanceof SyncClientError
      ? error
      : new SyncClientError("Sync connection failed", undefined, error);
  const unauthorized = (error: SyncClientError) => error.status === 401 || error.status === 403;
  const active = () => state.status !== "closed" && state.status !== "unauthorized";

  const createRecovery = () =>
    createSyncCatchUp({
      fetchPage: async (after) => {
        const { signal } = controller;
        const requestHeaders = await headers();
        signal.throwIfAborted();
        const response = await transport.fetchChanges(after, requestHeaders, signal);
        signal.throwIfAborted();
        if (!response.ok) {
          throw new SyncClientError("Sync recovery refused", response.status);
        }
        const page = (await response.json()) as SyncChangePagePayload;
        signal.throwIfAborted();
        const identity = response.headers.get("x-furin-sync-session");
        if (identity !== null) {
          if (session !== undefined && identity !== session) {
            reconnect();
          }
          session = identity;
        }
        return page;
      },
      onInvalidations: (paths) => {
        // Unknown cache tags imply a full refresh in the existing protocol.
        if (paths.includes("/:layout")) {
          queries.invalidateAll();
        }
      },
      onQueries: (identities) => queries.invalidate(identities),
    });
  let recovery = createRecovery();

  const releaseConnection = () => {
    connection?.stop?.();
    connection = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
  const fail = (value: unknown) => {
    if (!active()) {
      return;
    }
    const error = asError(value);
    releaseConnection();
    if (unauthorized(error)) {
      generation += 1;
      const epoch = generation;
      recovery.close();
      state = { status: "unauthorized", error };
      controller.abort();
      ready.resolve();
      queries.clear();
      if (epoch === generation) {
        publish("unauthorized", error);
      }
      return;
    }
    const delay = Math.min(250 * 2 ** attempt, 5000);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
    publish("reconnecting", error, "network");
  };
  const checkAccess = (url: string, status: number | undefined, error: unknown) => {
    if (status === 403) {
      queries.setError(url, error);
    } else if (status === 401) {
      fail(new SyncClientError("Live query access refused", status));
      if (state.status === "unauthorized") {
        queries.setError(url, error);
      }
    }
  };
  const connect = async () => {
    const epoch = generation;
    try {
      // HTTP exposes 401/403 even when the runtime hides WebSocket upgrade status.
      await recovery.catchUp();
      if (epoch !== generation || !active()) {
        return;
      }
      const requestHeaders = await headers();
      if (epoch !== generation || !active()) {
        return;
      }
      const current: SyncConnection = {};
      connection = current;
      const stop = await transport.subscribe({
        headers: requestHeaders,
        signal: controller.signal,
        onContextChange: () => {
          if (epoch === generation && connection === current && active()) {
            reconnect(undefined, true);
          }
        },
        onCursor: () => {
          recovery
            .catchUp()
            .then(() => {
              if (epoch === generation && active() && connection === current) {
                const reconnecting = state.status === "reconnecting";
                attempt = 0;
                ready.resolve();
                publish("connected", null);
                if (reconnecting && epoch === generation && connection === current) {
                  for (const url of subscriptions.values()) {
                    queries.fetch(url);
                  }
                }
              }
            })
            .catch((error: unknown) => {
              if (epoch === generation && connection === current) {
                fail(error);
              }
            });
        },
        onError: (error) => {
          if (epoch === generation && connection === current) {
            fail(error);
          }
        },
      });
      if (epoch !== generation || !active() || connection !== current) {
        stop();
        return;
      }
      current.stop = stop;
    } catch (error) {
      if (epoch === generation) {
        fail(error);
      }
    }
  };

  function reconnect(reconnectOptions?: SyncReconnectOptions, automatic?: boolean): void {
    if (state.status === "closed") {
      return;
    }
    generation += 1;
    const epoch = generation;
    releaseConnection();
    const cursor = reconnectOptions?.preserveCache ? recovery.cursor() : undefined;
    recovery.close();
    controller.abort();
    ready.resolve();
    controller = new AbortController();
    ready = Promise.withResolvers<void>();
    recovery = createRecovery();
    if (cursor === undefined) {
      session = undefined;
    } else {
      recovery.seed(cursor);
    }
    const delay = Math.min(250 * 2 ** attempt, 5000);
    attempt = automatic ? attempt + 1 : 0;
    queries.clear(reconnectOptions?.preserveCache);
    if (epoch !== generation) {
      return;
    }
    publish(
      automatic ? "reconnecting" : "connecting",
      null,
      reconnectOptions?.preserveCache ? "credentials" : "context"
    );
    if (epoch !== generation) {
      return;
    }
    if (automatic) {
      timer = setTimeout(() => {
        timer = undefined;
        connect();
      }, delay);
    } else {
      connect();
    }
    queries.invalidateAll();
  }

  return {
    subscribe(query, listener) {
      if (state.status === "closed") {
        throw new SyncClientError("Sync client is closed", undefined);
      }
      const { reference, options: readOptions } = query[LIVE_QUERY];
      if (!transport.accepts(reference)) {
        throw new SyncClientError("Live query belongs to a different server", undefined);
      }
      const url = queries.readKey(reference, readOptions);
      queries.bind(
        url,
        async () => {
          const { signal } = controller;
          try {
            await ready.promise;
            signal.throwIfAborted();
            const read = readOptions as { fetch?: RequestInit; headers?: unknown } | undefined;
            const fetch = { ...options.fetch, ...read?.fetch };
            fetch.signal = fetch.signal ? AbortSignal.any([signal, fetch.signal]) : signal;
            const result = await reference.load({
              ...read,
              ...(options.headers === undefined
                ? {}
                : { headers: [read?.headers, await headers()] }),
              fetch,
            });
            signal.throwIfAborted();
            checkAccess(url, result.response?.status, result.error);
            return result;
          } catch (error) {
            if (signal.aborted) {
              throw asError(signal.reason);
            }
            if (isEdenError(error)) {
              checkAccess(url, error.status, error);
              return { data: null, error };
            }
            throw asError(error);
          }
        },
        reference.client
      );
      let stopped = false;
      const unlisten = queries.subscribe(url, () => {
        if (!stopped) {
          listener(queries.snapshot(url) as SyncQueryState<Awaited<typeof query>>);
        }
      });
      const stop = () => {
        stopped = true;
        unlisten();
        subscriptions.delete(stop);
      };
      subscriptions.set(stop, url);
      listener(queries.snapshot(url) as SyncQueryState<Awaited<typeof query>>);
      if (!subscriptions.has(stop)) {
        return stop;
      }
      if (state.status === "idle") {
        publish("connecting", null);
        connect();
      }
      queries.fetch(url);
      return stop;
    },
    getConnectionState: () => state,
    subscribeConnection(listener) {
      if (state.status === "closed") {
        listener(state);
        return () => undefined;
      }
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    reconnect,
    close() {
      if (state.status === "closed") {
        return;
      }
      generation += 1;
      publish("closed", null);
      releaseConnection();
      recovery.close();
      controller.abort();
      ready.resolve();
      for (const stop of subscriptions.keys()) {
        stop();
      }
      listeners.clear();
      queries.dispose();
    },
  };
}
