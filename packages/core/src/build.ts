import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ResolvedRoute } from "./router";

/**
 * Build the client-side hydration bundle using Bun.build.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  { outDir = "./.elysion", dev = false }: { outDir?: string; dev?: boolean } = {}
): Promise<void> {
  const buildDir = outDir;
  const clientDir = join(outDir, "client");

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  const hydrateCode = dev ? generateDevHydrateEntry(routes) : generateHydrateEntry(routes);
  const hydratePath = join(buildDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  console.log(`[elysion] Building client bundle (${dev ? "dev" : "production"})...`);

  const result = await Bun.build({
    entrypoints: [hydratePath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: !dev,
    minify: !dev,
    naming: "[name].[ext]",
    define: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    },
  });

  if (!result.success) {
    console.error("[elysion] Client build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Client build failed");
  }

  for (const output of result.outputs) {
    console.log(`[elysion]   ${output.path} (${(output.size / 1024).toFixed(1)}KB)`);
  }

  console.log("[elysion] Client build complete");
}

/**
 * Production hydrate entry: static imports, simple hydrateRoot.
 */
function generateHydrateEntry(routes: ResolvedRoute[]): string {
  const imports: string[] = [];
  const routeEntries: string[] = [];

  const routeFileImports = new Map<string, string>();
  let routeImportCounter = 0;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as ResolvedRoute;
    const pageName = `Page${i}`;

    imports.push(`import ${pageName} from "${route.path.replace(/\\/g, "/")}";`);

    const layoutNames: string[] = [];
    for (let j = 0; j < route.routeChain.length; j++) {
      const ancestor = route.routeChain[j];
      const filePath = route.routeFilePaths[j];

      if (ancestor?.layout && filePath) {
        const normalizedPath = filePath.replace(/\\/g, "/");
        let importName = routeFileImports.get(normalizedPath);
        if (!importName) {
          importName = `Route${routeImportCounter++}`;
          routeFileImports.set(normalizedPath, importName);
          imports.push(`import { route as ${importName} } from "${normalizedPath}";`);
        }
        layoutNames.push(`${importName}.layout`);
      }
    }

    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    routeEntries.push(
      `  { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), component: ${pageName}.component, layouts: [${layoutNames.join(", ")}] }`
    );
  }

  return `import { hydrateRoot } from "react-dom/client";
import { createElement } from "react";

${imports.join("\n")}

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const match = routes.find(r => r.regex.test(pathname));

if (match) {
  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const root = document.getElementById("root");
  if (root) {
    let element = createElement(match.component, loaderData);
    for (let i = match.layouts.length - 1; i >= 0; i--) {
      const Layout = match.layouts[i];
      if (Layout) {
        element = createElement(Layout, { ...loaderData, children: element });
      }
    }
    hydrateRoot(root, element);
  }
} else {
  console.warn("[elysion] No matching route for", pathname);
}
`;
}

/**
 * Dev hydrate entry: includes React Refresh, HMR WebSocket client, dynamic module loading.
 */
function generateDevHydrateEntry(routes: ResolvedRoute[]): string {
  // Build route map for client-side matching
  const routeEntries: string[] = [];
  for (const route of routes) {
    const pagesDir = findPagesDir(route.pagePath, route.pattern);
    const relativePath = relative(pagesDir, route.pagePath).replace(/\\/g, "/");
    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    routeEntries.push(
      `  { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), modulePath: "/pages/${relativePath}" }`
    );
  }

  // Resolve absolute paths so Bun.build can find modules regardless of CWD
  const clientModulePath = new URL("./client.ts", import.meta.url).pathname;
  const refreshRuntimePath = require.resolve("react-refresh/runtime");

  return `import React from "react";
import { createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import * as RefreshRuntime from "${refreshRuntimePath}";
import { createRoute } from "${clientModulePath}";

// Expose globals for transformed page modules
window.React = React;
window.__ELYSION__ = { createRoute };
window.__REFRESH_RUNTIME__ = RefreshRuntime;

// Initialize React Refresh
RefreshRuntime.injectIntoGlobalHook(window);

window.$RefreshReg$ = (type, id) => {
  const fullId = window.__CURRENT_MODULE__ + " " + id;
  RefreshRuntime.register(type, fullId);
};
window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;

console.log("[hmr] React Refresh initialized");

// Route map (generated at build time)
const routes = [
${routeEntries.join(",\n")}
];

// Global state
let reactRoot = null;
let hmrUpdateId = 0;

// --- HMR WebSocket Client ---
(function() {
  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/__elysion/hmr");

    ws.onopen = () => {
      console.log("[hmr] Connected");
      reconnectAttempts = 0;
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await handleMessage(data);
      } catch (err) {
        console.error("[hmr] Error handling message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[hmr] Disconnected");
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        setTimeout(connect, 1000 * reconnectAttempts);
      }
    };

    ws.onerror = (err) => {
      console.error("[hmr] WebSocket error:", err);
    };
  }

  let refreshTimeout = null;

  function scheduleRefresh() {
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      performRefresh();
    }, 50);
  }

  function performRefresh() {
    try {
      const result = RefreshRuntime.performReactRefresh();
      if (result) {
        console.log("[hmr] React Fast Refresh complete");
      } else {
        console.log("[hmr] No React Refresh update, re-rendering manually");
        reRenderCurrentPage();
      }
    } catch (err) {
      console.error("[hmr] Fast Refresh failed, re-rendering:", err);
      reRenderCurrentPage();
    }
  }

  async function handleMessage(data) {
    if (data.type === "update") {
      console.log("[hmr] Update received:", data.path);

      hmrUpdateId++;
      for (const mod of data.modules || []) {
        // Stable module ID for React Refresh (no query param)
        const moduleId = "/_modules" + mod;
        // Cache-busted URL for browser ES module cache
        const url = "/_modules" + mod + "?hmr=" + hmrUpdateId;
        console.log("[hmr] Re-importing:", url);

        window.__CURRENT_MODULE__ = moduleId;
        try {
          const newModule = await import(url);
          window.__LATEST_PAGE_MODULE__ = newModule.default;
        } catch (err) {
          console.error("[hmr] Module import failed:", err);
          location.reload();
          return;
        }
      }

      scheduleRefresh();
    } else if (data.type === "reload") {
      location.reload();
    }
  }

  connect();
})();

// --- Fallback re-render ---
function reRenderCurrentPage() {
  const pageModule = window.__LATEST_PAGE_MODULE__;
  if (!pageModule) return;

  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

  const Component = pageModule.component;
  const element = createElement(Component, loaderData);

  if (reactRoot) {
    reactRoot.unmount();
  }
  reactRoot = createRoot(rootEl);
  reactRoot.render(element);
  console.log("[hmr] Manual re-render complete (full remount)");
}

// --- Initial Hydration ---
async function hydrate() {
  const pathname = window.location.pathname;
  const match = routes.find(r => r.regex.test(pathname));

  if (!match) {
    console.warn("[hmr] No matching route for", pathname);
    return;
  }

  const modulePath = "/_modules" + match.modulePath;
  window.__CURRENT_MODULE__ = modulePath;

  try {
    // Use stable URL - server returns fresh content with no-cache headers
    const mod = await import(modulePath);
    const pageModule = mod.default;
    window.__LATEST_PAGE_MODULE__ = pageModule;

    const Component = pageModule.component;

    const dataEl = document.getElementById("__ELYSION_DATA__");
    const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

    const rootEl = document.getElementById("root");
    if (!rootEl) {
      console.error("[hmr] Root element not found");
      return;
    }

    const element = createElement(Component, loaderData);
    reactRoot = hydrateRoot(rootEl, element);
    console.log("[hmr] Hydrated successfully for route:", match.pattern);
  } catch (err) {
    console.error("[hmr] Hydration failed:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrate);
} else {
  hydrate();
}
`;
}

/**
 * Infer pagesDir from a page's absolute path and its route pattern.
 * e.g., pagePath="/abs/src/pages/blog/index.tsx", pattern="/blog" → "/abs/src/pages"
 */
function findPagesDir(pagePath: string, _pattern: string): string {
  // The pagePath contains the pagesDir as a prefix. We find it by looking for /pages/
  const pagesIdx = pagePath.lastIndexOf("/pages/");
  if (pagesIdx !== -1) {
    return pagePath.substring(0, pagesIdx + "/pages".length);
  }
  // Fallback: use dirname of the path
  return pagePath.substring(0, pagePath.lastIndexOf("/"));
}
