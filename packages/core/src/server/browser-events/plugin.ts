import { type AnyElysia, Elysia } from "elysia";
import { browserEventsClientSource } from "../../client/browser-events-runtime.ts";
import {
  BROWSER_EVENT_PROTOCOL_VERSION,
  type BrowserEventEnvelope,
} from "../../shared/browser-events.ts";
import { forbiddenDevelopmentRequest } from "../dev/request-security.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { FurinSyncOptions } from "../sync/config.ts";
import { subscribeSyncCursor } from "../sync/stream.ts";
import type { BrowserEventSource, BrowserEventSubscription } from "./types.ts";

const CLIENT_PATH = "/_furin/events/client.js";
const SOCKET_PATH = "/_furin/events";
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_SOURCE = browserEventsClientSource();

interface BrowserEventsPluginOptions {
  sources?: readonly BrowserEventSource[];
  sync?: FurinSyncOptions;
}

interface ConnectionState {
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval>;
  subscriptions: BrowserEventSubscription[];
}

function releaseConnection(state: ConnectionState): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  clearInterval(state.heartbeat);
  for (const subscription of state.subscriptions) {
    subscription.unsubscribe();
  }
  state.subscriptions.length = 0;
}

function forbiddenBrowserRequest(
  request: Request,
  server: Bun.Server<unknown> | null | undefined
): Response | undefined {
  if (IS_DEV) {
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
  const { sources = [], sync } = options;
  return new Elysia({ name: "furin-browser-events" })
    .get(CLIENT_PATH, ({ request, server }) => {
      const forbidden = forbiddenBrowserRequest(request, server);
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
      beforeHandle({ request, server }) {
        return forbiddenBrowserRequest(request, server);
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
        const send = (event: BrowserEventEnvelope): void => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialized(event));
          }
        };
        const state: ConnectionState = {
          closed: false,
          heartbeat: setInterval(() => ws.ping(), HEARTBEAT_INTERVAL_MS),
          subscriptions: [],
        };
        state.heartbeat.unref?.();
        connections.set(ws.id, state);
        const keep = (subscription: BrowserEventSubscription): void => {
          if (state.closed) {
            subscription.unsubscribe();
          } else {
            state.subscriptions.push(subscription);
          }
        };

        try {
          if (sync !== undefined) {
            const subscription = await subscribeSyncCursor(sync, (cursor) =>
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
