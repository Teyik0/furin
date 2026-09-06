import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import {
  DEVTOOLS_PROTOCOL_VERSION,
  type DevtoolsCacheEntry,
  type DevtoolsRoute,
  type DevtoolsSnapshot,
} from "../../devtools/protocol.ts";
import {
  type DevLoaderCacheEntry,
  getAllDevISRLoaderEntries,
  getAllDevSSGLoaderEntries,
  isDevLoaderCacheFresh,
  urlPathFromCacheKey,
} from "../cache/dev-loader.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, ResolvedRoutesSource } from "../router/types.ts";
import { devtoolsEventsSnapshot, devtoolsInstanceId, subscribeDevtoolsEventsAfter } from "./hub.ts";

let clientSource: string | undefined;
const MAX_EVENT_STREAMS = 8;

function toRelativePath(path: string): string {
  const projected = relative(process.cwd(), path).replaceAll("\\", "/");
  return projected === ".." || projected.startsWith("../") ? basename(path) : projected;
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function forbiddenDevtoolsRequest(
  request: Request,
  server: Bun.Server<unknown> | null
): Response | undefined {
  if (server !== null) {
    const peer = server.requestIP(request);
    if (peer === null || !isLoopbackAddress(peer.address)) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${host}`));
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    return new Response("Forbidden", { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== requestUrl.origin) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Forbidden", { status: 403 });
  }
}

function routeSnapshot(route: ResolvedRoute): DevtoolsRoute {
  return {
    file: toRelativePath(route.path),
    hasLoader: route.page.loader !== undefined || route.routeChain.some((item) => item.loader),
    hasRequestLoader: route.routeChain.some((item) => item.requestLoader),
    mode: route.mode,
    pattern: route.pattern,
    tags: route.tags ?? [],
  };
}

function cacheSnapshot(key: string, entry: DevLoaderCacheEntry): DevtoolsCacheEntry | null {
  const path = urlPathFromCacheKey(key);
  if (path === null) {
    return null;
  }
  return {
    ageMs: Math.max(0, Date.now() - entry.generatedAt),
    dependencies: entry.dependencies.map(toRelativePath),
    fieldNames: Object.keys(entry.loaderData),
    id: Bun.hash(key).toString(16),
    isFresh: isDevLoaderCacheFresh(entry),
    mode: entry.mode,
    path,
    revalidateSeconds: Number.isFinite(entry.revalidate) ? entry.revalidate : null,
  };
}

function cacheSnapshots(): DevtoolsCacheEntry[] {
  const entries = [...getAllDevISRLoaderEntries(), ...getAllDevSSGLoaderEntries()];
  const snapshots: DevtoolsCacheEntry[] = [];
  for (const [key, entry] of entries) {
    const snapshot = cacheSnapshot(key, entry);
    if (snapshot !== null) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function buildClient(): string {
  clientSource ??= readFileSync(
    resolve(import.meta.dir, "../../devtools/devtools-element.js"),
    "utf8"
  );
  return clientSource;
}

function eventCursor(request: Request): number {
  const url = new URL(request.url);
  const candidate = url.searchParams.get("after") ?? request.headers.get("last-event-id");
  if (candidate === null) {
    return 0;
  }
  const parsed = Number.parseInt(candidate, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function serializeEvent(event: DevtoolsSnapshot["events"][number]): string {
  return `id: ${event.id}\nevent: furin.devtools\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createDevtoolsPlugin(
  routesSource: ResolvedRoutesSource,
  syncStreamPath: string | undefined
): AnyElysia {
  let activeEventStreams = 0;
  return new Elysia({ name: "furin-devtools" })
    .get("/_furin/devtools/client.js", ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      try {
        return new Response(buildClient(), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("DevTools client build failed", { status: 500 });
      }
    })
    .get("/_furin/devtools/events", ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      if (activeEventStreams >= MAX_EVENT_STREAMS) {
        return new Response("Too many DevTools event streams", { status: 429 });
      }
      activeEventStreams += 1;
      const cursor = eventCursor(request);
      const encoder = new TextEncoder();
      let stop: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let released = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const release = (close: boolean): void => {
        if (released) {
          return;
        }
        released = true;
        activeEventStreams -= 1;
        stop?.();
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        request.signal.removeEventListener("abort", abort);
        if (close) {
          try {
            streamController?.close();
          } catch {
            // The peer may already have closed the stream.
          }
        }
      };
      const abort = (): void => release(true);
      const stream = new ReadableStream<Uint8Array>(
        {
          cancel() {
            release(false);
          },
          start(controller) {
            streamController = controller;
            request.signal.addEventListener("abort", abort, { once: true });
            controller.enqueue(encoder.encode(": connected\nretry: 1000\n\n"));
            const subscription = subscribeDevtoolsEventsAfter(cursor, (event) => {
              try {
                controller.enqueue(encoder.encode(serializeEvent(event)));
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                  release(true);
                }
              } catch {
                release(false);
              }
            });
            stop = subscription.unsubscribe;
            for (const event of subscription.replay) {
              if (released) {
                break;
              }
              controller.enqueue(encoder.encode(serializeEvent(event)));
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                release(true);
              }
            }
            if (!released) {
              heartbeat = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                    release(true);
                  }
                } catch {
                  release(false);
                }
              }, 15_000);
            }
          },
        },
        new CountQueuingStrategy({ highWaterMark: 128 })
      );
      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        },
      });
    })
    .get("/_furin/devtools/snapshot", ({ request, server, set }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      set.headers["cache-control"] = "no-store";
      const instance = currentInstance();
      const eventSnapshot = devtoolsEventsSnapshot();
      const snapshot: DevtoolsSnapshot = {
        caches: cacheSnapshots(),
        events: eventSnapshot.events,
        instance: {
          id: devtoolsInstanceId(),
          prefix: instance.prefix,
        },
        lastEventId: eventSnapshot.lastEventId,
        routes: (typeof routesSource === "function" ? routesSource() : routesSource).map(
          routeSnapshot
        ),
        sync: {
          enabled: syncStreamPath !== undefined,
          streamPath: syncStreamPath ?? null,
        },
        version: DEVTOOLS_PROTOCOL_VERSION,
      };
      return snapshot;
    });
}
