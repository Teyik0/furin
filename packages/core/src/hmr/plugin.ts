import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type AsyncSubscription, subscribe } from "@parcel/watcher";
import { Elysia, t } from "elysia";
import { getCachedCss, getCssConfig, invalidateCssCache } from "../css";
import { REFRESH_SETUP_CODE } from "./refresh-setup";
import {
  broadcastMessage,
  getAffectedModules,
  getHmrClients,
  getTransformedModule,
  invalidateModuleCache,
} from "./watcher";

// ─── Module-level watcher state ──────────────────────────────────────────────
// Watchers are owned at module scope so import.meta.hot.dispose() can tear
// them down cleanly before a hot reload re-establishes them.

let _pagesWatcher: AsyncSubscription | null = null;
let _cssWatcher: AsyncSubscription | null = null;

// Safely access import.meta.hot — may be undefined outside bun --hot.
const hot = typeof import.meta.hot !== "undefined" ? import.meta.hot : null;
const hmrData: Record<string, unknown> = hot?.data ?? {};

// Config is persisted across hot reloads so watchers can be restarted
// automatically when this module itself is hot-replaced.
let _pagesDir: string | null = (hmrData.pagesDir ??= null) as string | null;
let _cssInputPath: string | undefined = hmrData.cssInputPath as string | undefined;

async function stopWatchers(): Promise<void> {
  await _pagesWatcher?.unsubscribe();
  _pagesWatcher = null;
  await _cssWatcher?.unsubscribe();
  _cssWatcher = null;
}

async function startWatchers(pagesDir: string, cssInputPath?: string): Promise<void> {
  await stopWatchers();

  const normalizedPagesDir = realpathSync(pagesDir);

  // The basename of pagesDir relative to srcDir (e.g. "pages", "routes").
  // Used to build module URLs that match the /_modules/src/* route.
  const pagesDirName = basename(pagesDir);

  // @parcel/watcher delivers batched, deduplicated events with absolute paths.
  // No manual debounce needed — the native backend (inotify/FSEvents) handles it.
  _pagesWatcher = await subscribe(pagesDir, (err, events) => {
    if (err) {
      console.error("[hmr] Watcher error:", err);
      return;
    }

    for (const event of events) {
      const filename = event.path;
      if (![".tsx", ".ts", ".jsx", ".js"].some((ext) => filename.endsWith(ext))) {
        continue;
      }

      console.log(`[hmr] File ${event.type}: ${filename}`);

      // Invalidate the per-file module version so the next SSR request
      // imports the new file content instead of the stale cached module.
      invalidateModuleCache(filename);

      // Invalidate CSS cache since Tailwind classes might have changed
      const cssConfig = getCssConfig();
      if (cssConfig) {
        invalidateCssCache(resolve(process.cwd(), cssConfig.input));
      }

      // event.path is absolute — derive the relative path from pagesDir.
      const relative = filename.slice(pagesDir.length + 1).replace(/\\/g, "/");
      const modulePath = `/src/${pagesDirName}/${relative}`;

      // Expand modules array to include all pages that transitively import the changed file.
      // Filters to files inside pagesDir since only those can be re-imported by the browser.
      const affectedRaw = getAffectedModules(filename);
      const affectedModulePaths = affectedRaw
        .filter((p) => p.startsWith(`${normalizedPagesDir}/`))
        .map(
          (p) =>
            `/src/${pagesDirName}/${p.slice(normalizedPagesDir.length + 1).replace(/\\/g, "/")}`
        );

      broadcastMessage(
        JSON.stringify({
          type: "update",
          path: modulePath,
          modules: [modulePath, ...affectedModulePaths],
          cssUpdate: true,
        })
      );

      console.log(`[hmr] Broadcast update to ${getHmrClients().size} client(s)`);
    }
  });

  console.log("[hmr] File watcher started for pages");

  if (cssInputPath) {
    const absoluteCssPath = resolve(process.cwd(), cssInputPath);
    const cssDir = dirname(absoluteCssPath);

    _cssWatcher = await subscribe(cssDir, (err, events) => {
      if (err) {
        console.error("[hmr] CSS watcher error:", err);
        return;
      }

      for (const event of events) {
        if (event.path !== absoluteCssPath && !event.path.endsWith(".css")) {
          continue;
        }
        console.log(`[hmr] CSS file ${event.type}: ${event.path}`);
        invalidateCssCache(absoluteCssPath);
        broadcastMessage(JSON.stringify({ type: "css-update", path: event.path }));
        console.log(`[hmr] Broadcast css-update to ${getHmrClients().size} client(s)`);
      }
    });

    console.log("[hmr] CSS watcher started");
  }
}

// Restart watchers automatically when this module is hot-reloaded
if (_pagesDir) {
  startWatchers(_pagesDir, _cssInputPath);
}

export function createHmrPlugin(pagesDir: string, cssInputPath?: string) {
  // Persist config so it survives a hot reload of this module
  _pagesDir = pagesDir;
  _cssInputPath = cssInputPath;

  startWatchers(pagesDir, cssInputPath);

  const srcDir = dirname(pagesDir);

  return new Elysia({ name: "elysion-hmr" })
    .ws("/__elysion/hmr", {
      body: t.Any(),
      open(ws) {
        getHmrClients().add(ws.raw);
        console.log(`[hmr] Client connected (${getHmrClients().size} total)`);
        ws.send(JSON.stringify({ type: "connected" }));
      },
      close(ws) {
        getHmrClients().delete(ws.raw);
        console.log(`[hmr] Client disconnected (${getHmrClients().size} remaining)`);
      },
      message(_ws, message) {
        console.log("[hmr] Client message:", message);
      },
    })
    .get("/__refresh-setup.js", ({ set }) => {
      set.headers["content-type"] = "application/javascript";
      set.headers["cache-control"] = "no-cache";
      return REFRESH_SETUP_CODE;
    })
    .get("/_modules/src/*", async ({ path, set, status }) => {
      const relativePath = decodeURIComponent(path.replace("/_modules/src/", ""));
      let fullPath = resolve(srcDir, relativePath);

      if (!fullPath.startsWith(srcDir)) {
        return status("Forbidden", `File does not exist at: ${fullPath}`);
      }

      // Try with extensions if file doesn't exist
      const extensions = [".tsx", ".ts", ".jsx", ".js"];
      const file = Bun.file(fullPath);
      if (!(await file.exists())) {
        for (const ext of extensions) {
          const pathWithExt = fullPath + ext;
          const fileWithExt = Bun.file(pathWithExt);
          if (await fileWithExt.exists()) {
            fullPath = pathWithExt;
            break;
          }
        }
      }

      set.headers["content-type"] = "application/javascript";
      set.headers["cache-control"] = "no-cache";
      try {
        const code = await getTransformedModule(fullPath, srcDir, pagesDir);
        return status(200, code);
      } catch (error) {
        console.error("[hmr] Module transform error:", error);
        return status(500, `// Error: ${error}`);
      }
    })
    .get("/__elysion/css", async ({ set, status }) => {
      const config = getCssConfig();
      set.headers["content-type"] = "text/css";
      if (!config) {
        return status("Not Found", "CSS Not Configured");
      }

      set.headers["cache-control"] = "no-cache";

      try {
        const absolutePath = resolve(process.cwd(), config.input);
        invalidateCssCache(absolutePath);

        const result = await getCachedCss(process.cwd());
        return result?.code;
      } catch (error: unknown) {
        console.error("[hmr] CSS processing error:", error);
        return status("Internal Server Error", `CSS Error: ${error}`);
      }
    });
}

// ─── HMR lifecycle ────────────────────────────────────────────────────────────
// Stop file watchers before this module is replaced; persist config so the
// incoming version can restart them without being called by elysion() again.
hot?.dispose(async (data) => {
  data.pagesDir = _pagesDir;
  data.cssInputPath = _cssInputPath;
  await stopWatchers();
});
