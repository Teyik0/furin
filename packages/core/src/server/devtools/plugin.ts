import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import {
  DEVTOOLS_PROTOCOL_VERSION,
  type DevtoolsBrowserEventInput,
  type DevtoolsCacheEntry,
  type DevtoolsRoute,
  type DevtoolsSnapshot,
  isDevtoolsBrowserEventInput,
} from "../../devtools/protocol.ts";
import {
  type DevLoaderCacheEntry,
  getAllDevISRLoaderEntries,
  getAllDevSSGLoaderEntries,
  isDevLoaderCacheFresh,
  urlPathFromCacheKey,
} from "../cache/dev-loader.ts";
import { devGraph } from "../dev/graph.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, ResolvedRoutesSource } from "../router/types.ts";
import {
  appendDevtoolsEvent,
  devtoolsEventsSnapshot,
  devtoolsInstanceId,
  subscribeDevtoolsEventsAfter,
} from "./hub.ts";

let clientSource: Promise<string> | undefined;
let dashboardSource: Promise<string> | undefined;
let dashboardStyles: string | undefined;
const MAX_EVENT_STREAMS = 8;
const MAX_BROWSER_EVENT_BYTES = 256 * 1024;

function toRelativePath(path: string): string {
  const sourcePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const projected = relative(process.cwd(), sourcePath).replaceAll("\\", "/");
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

function devtoolsSourcePath(filename: string): string {
  const sourcePath = [
    resolve(import.meta.dir, `../../devtools/${filename}`),
    resolve(import.meta.dir, `../src/devtools/${filename}`),
  ].find((path) => existsSync(path));
  if (!sourcePath) {
    throw new Error(`[furin] DevTools source is missing: ${filename}`);
  }
  return sourcePath;
}

async function buildBrowserEntry(filename: string): Promise<string> {
  const result = await Bun.build({
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    entrypoints: [devtoolsSourcePath(filename)],
    format: "esm",
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const output = result.outputs.find((candidate) => candidate.path.endsWith(".js"));
  if (!output) {
    throw new Error(`[furin] DevTools build produced no JavaScript for ${filename}`);
  }
  return output.text();
}

function buildClient(): Promise<string> {
  clientSource ??= buildBrowserEntry("collector.ts");
  return clientSource;
}

function buildDashboard(): Promise<string> {
  dashboardSource ??= buildClient().then(() => buildBrowserEntry("dashboard.tsx"));
  return dashboardSource;
}

function dashboardCss(): string {
  dashboardStyles ??= readFileSync(devtoolsSourcePath("dashboard.css"), "utf8");
  return dashboardStyles;
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

export function renderDevtoolsDashboardHtml(prefix: string): string {
  const base = `${prefix}/_furin/devtools`
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Furin DevTools</title>
    <link rel="stylesheet" href="${base}/dashboard.css">
  </head>
  <body>
    <div id="furin-devtools-root"></div>
    <script type="module" src="${base}/dashboard.js"></script>
  </body>
</html>`;
}

async function readBrowserEvent(request: Request): Promise<DevtoolsBrowserEventInput | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_EVENT_BYTES) {
    return null;
  }
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BROWSER_EVENT_BYTES) {
      return null;
    }
    const input: unknown = JSON.parse(body);
    return isDevtoolsBrowserEventInput(input) ? input : null;
  } catch {
    return null;
  }
}

function sanitizeBrowserEvent(event: DevtoolsBrowserEventInput): DevtoolsBrowserEventInput {
  if (event.type !== "hmr.client.phase" || event.module === null) {
    return event;
  }
  return { ...event, module: toRelativePath(event.module) };
}

export function createDevtoolsPlugin(
  routesSource: ResolvedRoutesSource,
  syncStreamPath: string | undefined
): AnyElysia {
  let activeEventStreams = 0;
  return new Elysia({ name: "furin-devtools" })
    .get("/_furin/devtools", ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      return new Response(renderDevtoolsDashboardHtml(currentInstance().prefix), {
        headers: {
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .post("/_furin/devtools/browser-events", async ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      const event = await readBrowserEvent(request);
      if (event === null) {
        return new Response("Invalid DevTools browser event", { status: 400 });
      }
      appendDevtoolsEvent({ ...sanitizeBrowserEvent(event), timestamp: Date.now() });
      return new Response(null, { status: 204 });
    })
    .get("/_furin/devtools/dashboard.js", async ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      try {
        return new Response(await buildDashboard(), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("DevTools dashboard build failed", { status: 500 });
      }
    })
    .get("/_furin/devtools/dashboard.css", ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      try {
        return new Response(dashboardCss(), {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/css; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("DevTools dashboard styles are missing", { status: 500 });
      }
    })
    .get("/_furin/devtools/client.js", async ({ request, server }) => {
      const forbidden = forbiddenDevtoolsRequest(request, server);
      if (forbidden) {
        return forbidden;
      }
      try {
        return new Response(await buildClient(), {
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
      const graphMetrics = devGraph(instance).metrics;
      const memory = process.memoryUsage();
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
        runtime: {
          graph: {
            edges: graphMetrics.edges,
            modules: graphMetrics.trackedModules,
            revision: graphMetrics.revision,
          },
          memory: {
            heapBytes: memory.heapUsed,
            rssBytes: memory.rss,
          },
        },
        sync: {
          enabled: syncStreamPath !== undefined,
          streamPath: syncStreamPath ?? null,
        },
        version: DEVTOOLS_PROTOCOL_VERSION,
      };
      return snapshot;
    });
}
