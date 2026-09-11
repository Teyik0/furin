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
import { forbiddenDevelopmentRequest } from "../dev/request-security.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, ResolvedRoutesSource } from "../router/types.ts";
import { appendDevtoolsEvent, devtoolsEventsSnapshot, devtoolsInstanceId } from "./hub.ts";

let clientSource: Promise<string> | undefined;
let dashboardSource: Promise<string> | undefined;
let dashboardStyles: string | undefined;
const MAX_BROWSER_EVENT_BYTES = 256 * 1024;

function toRelativePath(path: string): string {
  const sourcePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const projected = relative(process.cwd(), sourcePath).replaceAll("\\", "/");
  return projected === ".." || projected.startsWith("../") ? basename(path) : projected;
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

export function renderDevtoolsDashboardHtml(prefix: string): string {
  const escapedPrefix = prefix
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const base = `${escapedPrefix}/_furin/devtools`;
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
    <script type="module" src="${escapedPrefix}/_furin/events/client.js"></script>
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
  syncPath: string | undefined
): AnyElysia {
  return new Elysia({ name: "furin-devtools" })
    .get("/_furin/devtools", ({ request, server }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
    .get("/_furin/devtools/snapshot", ({ request, server, set }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
          changesPath: syncPath === undefined ? null : `${syncPath}/changes`,
          enabled: syncPath !== undefined,
        },
        version: DEVTOOLS_PROTOCOL_VERSION,
      };
      return snapshot;
    });
}
