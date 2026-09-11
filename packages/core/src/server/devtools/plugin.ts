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
import { forbiddenDevelopmentRequest } from "../dev/request-security.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, ResolvedRoutesSource } from "../router/types.ts";
import { devtoolsEventsSnapshot, devtoolsInstanceId } from "./hub.ts";

let clientSource: string | undefined;

function toRelativePath(path: string): string {
  const projected = relative(process.cwd(), path).replaceAll("\\", "/");
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

function buildClient(): string {
  clientSource ??= readFileSync(
    resolve(import.meta.dir, "../../devtools/devtools-element.js"),
    "utf8"
  );
  return clientSource;
}

export function createDevtoolsPlugin(
  routesSource: ResolvedRoutesSource,
  syncPath: string | undefined
): AnyElysia {
  return new Elysia({ name: "furin-devtools" })
    .get("/_furin/devtools/client.js", ({ request, server }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
    .get("/_furin/devtools/snapshot", ({ request, server, set }) => {
      const forbidden = forbiddenDevelopmentRequest(request, server);
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
          changesPath: syncPath === undefined ? null : `${syncPath}/changes`,
          enabled: syncPath !== undefined,
        },
        version: DEVTOOLS_PROTOCOL_VERSION,
      };
      return snapshot;
    });
}
