import { watch } from "node:fs";
import { relative, resolve } from "node:path";
import { transformForReactRefresh } from "./transform";

// Global state (survives bun --hot reloads)
declare global {
  var __elysionHmrClients: Set<WebSocket>;
  var __elysionHmrWatchers: ReturnType<typeof watch>[];
  var __elysionModuleCache: Map<string, { code: string; timestamp: number }>;
  var __elysionModuleVersions: Map<string, number>;
}

globalThis.__elysionHmrClients ??= new Set();
globalThis.__elysionHmrWatchers ??= [];
// Reset module cache on hot reload so transform changes take effect
globalThis.__elysionModuleCache = new Map();
// Module versions for SSR cache-busting (persists across hot reloads)
globalThis.__elysionModuleVersions ??= new Map();

export function getHmrClients(): Set<WebSocket> {
  return globalThis.__elysionHmrClients;
}

export function getModuleVersion(fullPath: string): number {
  return globalThis.__elysionModuleVersions.get(fullPath) ?? 0;
}

export function setupHmrWatcher(pagesDir: string) {
  // Close existing watchers
  for (const w of globalThis.__elysionHmrWatchers) {
    try {
      w.close();
    } catch {
      // Watcher may already be closed
    }
  }
  globalThis.__elysionHmrWatchers = [];

  const recentlyBroadcast = new Map<string, number>();

  const watcher = watch(pagesDir, { recursive: true }, (event, filename) => {
    if (!filename) {
      return;
    }
    if (!(filename.endsWith(".tsx") || filename.endsWith(".ts"))) {
      return;
    }

    // Debounce: fs.watch on macOS fires duplicate events
    const now = Date.now();
    const last = recentlyBroadcast.get(filename) || 0;
    if (now - last < 100) {
      return;
    }
    recentlyBroadcast.set(filename, now);

    const fullPath = resolve(pagesDir, filename);
    console.log(`[hmr] File ${event}: ${filename}`);

    // Invalidate module cache
    globalThis.__elysionModuleCache.delete(fullPath);

    // Increment version for SSR cache-busting
    const currentVersion = globalThis.__elysionModuleVersions.get(fullPath) ?? 0;
    globalThis.__elysionModuleVersions.set(fullPath, currentVersion + 1);

    // Determine if this is a route file change (full reload) or page change (HMR)
    const isRouteFile = filename.endsWith("route.tsx") || filename.endsWith("route.ts");
    const messageType = isRouteFile ? "reload" : "update";

    const message = JSON.stringify({
      type: messageType,
      path: `/pages/${filename}`,
      modules: [`/pages/${filename}`],
    });

    for (const client of globalThis.__elysionHmrClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }

    console.log(
      `[hmr] Broadcast ${messageType} to ${globalThis.__elysionHmrClients.size} client(s)`
    );
  });

  globalThis.__elysionHmrWatchers.push(watcher);
  console.log("[hmr] File watcher started");
}

export async function getTransformedModule(fullPath: string, pagesDir: string): Promise<string> {
  const cached = globalThis.__elysionModuleCache.get(fullPath);
  if (cached) {
    return cached.code;
  }

  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const source = await file.text();
  const relativePath = relative(pagesDir, fullPath);
  const moduleId = `/_modules/pages/${relativePath}`;
  const transformed = transformForReactRefresh(source, fullPath, moduleId);

  globalThis.__elysionModuleCache.set(fullPath, {
    code: transformed,
    timestamp: Date.now(),
  });

  return transformed;
}

export function cleanupWatchers() {
  for (const watcher of globalThis.__elysionHmrWatchers) {
    watcher.close();
  }
  globalThis.__elysionHmrWatchers = [];
}
