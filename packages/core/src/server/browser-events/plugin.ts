import { type AnyElysia, type Context, Elysia } from "elysia";
import { websocket } from "elysia/websocket";
import {
  browserEventsClientSource,
  browserEventsSseClientSource,
} from "../../client/browser-events-runtime.ts";
import {
  BROWSER_EVENT_PROTOCOL_VERSION,
  type BrowserEventEnvelope,
} from "../../shared/browser-events.ts";
import { forbiddenDevelopmentRequest } from "../dev/request-security.ts";
import type { FurinSyncOptions } from "../sync/config.ts";
import { subscribeSyncCursor } from "../sync/stream.ts";
import { registerBrowserEventConnection, unregisterBrowserEventConnection } from "./shutdown.ts";
import type { BrowserEventSource, BrowserEventSubscription } from "./types.ts";

const CLIENT_PATH = "/_furin/events/client.js";
const SOCKET_PATH = "/_furin/events";
const HEARTBEAT_INTERVAL_MS = 30_000;
const SSE_CONNECTION_LIFETIME_MS = 60_000;
const MAX_BROWSER_EVENT_CONNECTIONS = 100;
const MAX_BROWSER_EVENT_CONNECTIONS_PER_PEER = 10;
const CLIENT_SOURCE = browserEventsClientSource();
const SSE_CLIENT_SOURCE = browserEventsSseClientSource();
const SSE_ENCODER = new TextEncoder();

interface BrowserEventsPluginOptions {
  /** Mode of the runtime serving these events. */
  development: boolean;
  sources?: readonly BrowserEventSource[];
  sync?: FurinSyncOptions;
}

interface ConnectionState {
  close: () => void;
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval>;
  release: () => void;
  server: Bun.Server<unknown>;
  subscriptions: BrowserEventSubscription[];
}

/** Who holds a connection: a verified principal, or the peer address without one. */
interface BrowserEventPeer {
  key: string;
  sync: boolean;
}

/** Bounds connections globally and per peer so one client cannot take the whole capacity. */
function createConnectionCapacity() {
  const peers = new Map<string, number>();
  let total = 0;
  return {
    full: (key: string): boolean =>
      total >= MAX_BROWSER_EVENT_CONNECTIONS ||
      (peers.get(key) ?? 0) >= MAX_BROWSER_EVENT_CONNECTIONS_PER_PEER,
    acquire(key: string): () => void {
      total += 1;
      peers.set(key, (peers.get(key) ?? 0) + 1);
      let held = true;
      return () => {
        if (!held) {
          return;
        }
        held = false;
        total -= 1;
        const remaining = (peers.get(key) ?? 1) - 1;
        if (remaining === 0) {
          peers.delete(key);
        } else {
          peers.set(key, remaining);
        }
      };
    },
  };
}

/** Resolves the Sync principal; a throwing or empty resolver means the caller is unauthenticated. */
async function verifiedPrincipal(
  sync: FurinSyncOptions,
  context: Context
): Promise<string | undefined> {
  try {
    const principal = await sync.principal(context);
    return principal.length > 0 ? principal : undefined;
  } catch {
    // Resolvers reject signed-out requests by throwing, as `requireUser` does in the docs.
  }
}

function peerAddressKey(request: Request, server: Bun.Server<unknown> | null | undefined): string {
  return `address:${server?.requestIP(request)?.address ?? "unknown"}`;
}

function releaseConnection(state: ConnectionState): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  state.release();
  unregisterBrowserEventConnection(state.server, state.close);
  clearInterval(state.heartbeat);
  for (const subscription of state.subscriptions) {
    subscription.unsubscribe();
  }
  state.subscriptions.length = 0;
}

function forbiddenBrowserRequest(
  request: Request,
  server: Bun.Server<unknown> | null | undefined,
  development: boolean
): Response | undefined {
  if (development) {
    return forbiddenDevelopmentRequest(request, server ?? null);
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 });
  }
}

function serialized(event: BrowserEventEnvelope): string {
  return JSON.stringify(event);
}

export function createBrowserEventsPlugin(options: BrowserEventsPluginOptions): AnyElysia {
  const connections = new Map<string, ConnectionState>();
  const capacity = createConnectionCapacity();
  const peers = new WeakMap<Request, BrowserEventPeer>();
  const { development, sources = [], sync } = options;
  return new Elysia({ name: "furin-browser-events" })
    .use(websocket())
    .get(CLIENT_PATH, ({ request, server }) => {
      const forbidden = forbiddenBrowserRequest(request, server, development);
      if (forbidden) {
        return forbidden;
      }
      return new Response(CLIENT_SOURCE, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .ws(SOCKET_PATH, {
      async beforeHandle(context) {
        const { request, server } = context;
        const forbidden = forbiddenBrowserRequest(request, server, development);
        if (forbidden) {
          return forbidden;
        }
        const principal = sync && (await verifiedPrincipal(sync, context as Context));
        // Development sources stay available to signed-out pages; their Sync cursor does not.
        if (sync && principal === undefined && sources.length === 0) {
          return new Response("Unauthorized", { status: 401 });
        }
        const peer: BrowserEventPeer = principal
          ? { key: `principal:${principal}`, sync: true }
          : { key: peerAddressKey(request, server), sync: false };
        if (capacity.full(peer.key)) {
          return Response.json({ code: "FURIN_BROWSER_EVENTS_CAPACITY" }, { status: 503 });
        }
        peers.set(request, peer);
      },
      close(ws) {
        const state = connections.get(ws.id);
        if (!state) {
          return;
        }
        releaseConnection(state);
        connections.delete(ws.id);
      },
      message(ws) {
        ws.close(1008, "Furin browser events are server-to-client only");
      },
      async open(ws) {
        const peer = peers.get(ws.request);
        if (!peer) {
          ws.close(1008, "Furin browser events require an authorized upgrade");
          return;
        }
        if (capacity.full(peer.key)) {
          ws.close(1013, "Furin browser event capacity reached");
          return;
        }
        const send = (event: BrowserEventEnvelope): void => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialized(event));
          }
        };
        const state: ConnectionState = {
          close: () => ws.close(1001, "Server shutting down"),
          closed: false,
          heartbeat: setInterval(
            () => (ws as unknown as { ping: () => number }).ping(),
            HEARTBEAT_INTERVAL_MS
          ),
          release: capacity.acquire(peer.key),
          server: ws.server as Bun.Server<unknown>,
          subscriptions: [],
        };
        state.heartbeat.unref?.();
        connections.set(ws.id, state);
        registerBrowserEventConnection(state.server, state.close);
        const keep = (subscription: BrowserEventSubscription): void => {
          if (state.closed) {
            subscription.unsubscribe();
          } else {
            state.subscriptions.push(subscription);
          }
        };

        try {
          if (sync !== undefined && peer.sync) {
            const subscription = await subscribeSyncCursor(sync, development, (cursor) =>
              send({
                channel: "sync",
                data: { cursor },
                version: BROWSER_EVENT_PROTOCOL_VERSION,
              })
            );
            keep(subscription);
          }
          const sourceSubscriptions = await Promise.allSettled(
            sources.map((source) => source.subscribe(send))
          );
          let sourceFailed = false;
          for (const result of sourceSubscriptions) {
            if (result.status === "fulfilled") {
              keep(result.value);
            } else {
              sourceFailed = true;
            }
          }
          if (sourceFailed) {
            throw new Error("Furin browser event source subscription failed");
          }
        } catch {
          releaseConnection(state);
          connections.delete(ws.id);
          ws.close(1011, "Furin browser event subscription failed");
        }
      },
    });
}

export function createSseBrowserEventsPlugin({
  development,
  sync,
}: {
  development: boolean;
  sync: FurinSyncOptions;
}): AnyElysia {
  const capacity = createConnectionCapacity();
  return new Elysia({ name: "furin-browser-events-sse" })
    .get(CLIENT_PATH, ({ request, server }) => {
      const forbidden = forbiddenBrowserRequest(request, server, development);
      if (forbidden) {
        return forbidden;
      }
      return new Response(SSE_CLIENT_SOURCE, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .get(SOCKET_PATH, async (context) => {
      const { request, server } = context;
      const forbidden = forbiddenBrowserRequest(request, server, development);
      if (forbidden) {
        return forbidden;
      }
      const principal = await verifiedPrincipal(sync, context as Context);
      if (principal === undefined) {
        return new Response("Unauthorized", { status: 401 });
      }
      const key = `principal:${principal}`;
      if (capacity.full(key)) {
        return new Response("retry: 5000\n\n", {
          headers: {
            "cache-control": "no-cache, no-transform",
            "content-type": "text/event-stream; charset=utf-8",
          },
        });
      }

      let release = (): void => undefined;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          release();
        },
        start(controller) {
          let closed = false;
          let subscription: BrowserEventSubscription | undefined;
          let lifetime: ReturnType<typeof setTimeout> | undefined;
          const send = (event: BrowserEventEnvelope): void => {
            if (!closed) {
              controller.enqueue(SSE_ENCODER.encode(`data: ${serialized(event)}\n\n`));
            }
          };
          const heartbeat = setInterval(() => {
            if (!closed) {
              controller.enqueue(SSE_ENCODER.encode(": ping\n\n"));
            }
          }, HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          const finish = (): void => {
            if (closed) {
              return;
            }
            release();
            controller.close();
          };
          const onAbort = finish;
          const releaseCapacity = capacity.acquire(key);
          release = () => {
            if (closed) {
              return;
            }
            closed = true;
            clearInterval(heartbeat);
            if (lifetime) {
              clearTimeout(lifetime);
            }
            request.signal.removeEventListener("abort", onAbort);
            subscription?.unsubscribe();
            releaseCapacity();
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) {
            finish();
            return;
          }
          // Platforms invoking app.handle() may not expose request cancellation; bound the subscription.
          lifetime = setTimeout(finish, SSE_CONNECTION_LIFETIME_MS);
          lifetime.unref?.();
          controller.enqueue(SSE_ENCODER.encode(": connected\n\n"));
          subscribeSyncCursor(sync, development, (cursor) =>
            send({ channel: "sync", data: { cursor }, version: BROWSER_EVENT_PROTOCOL_VERSION })
          )
            .then((next) => {
              if (closed) {
                next.unsubscribe();
              } else {
                subscription = next;
              }
            })
            .catch(() => {
              finish();
            });
        },
      });
      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    });
}

export function browserEventsClientScript(basePath: string): string {
  return `<script data-furin-framework-module="" type="module" src="${basePath}${CLIENT_PATH}"></script>`;
}

export function injectBrowserEventsClient(html: string, basePath: string): string {
  const script = browserEventsClientScript(basePath);
  if (html.includes(script)) {
    return html;
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}
