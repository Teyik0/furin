import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIndexHtml } from "../render/shell";
import type { ResolvedRoute } from "../router";
import { writeRouteTypes } from "./route-types";
import type { BuildClientOptions } from "./types";

/**
 * Generates the client hydration entry.
 *
 * Renders into <div id="root"> (the SSR outlet element) and retains the React
 * root across hot reloads via import.meta.hot.data.root so React Fast Refresh
 * applies in-place instead of remounting.
 *
 * @param routes - Resolved routes to include in the hydration manifest.
 * @param rootLayout - Absolute path to the root layout module.
 */
export function generateHydrateEntry(routes: ResolvedRoute[], rootLayout: string): string {
  const routeEntries: string[] = [];

  for (const route of routes) {
    const resolvedPage = route.path.replace(/\\/g, "/");
    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    routeEntries.push(
      ` { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), load: () => import("${resolvedPage}") }`
    );
  }

  return `import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";
import { initLogger, log } from "evlog";
import { createBrowserLogDrain } from "evlog/browser";
import { RouterProvider } from "@teyik0/furin/link";
import { route as root } from "${rootLayout.replace(/\\/g, "/")}";

initLogger({ drain: createBrowserLogDrain({ drain: { endpoint: "/_furin/ingest" } }) });

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const _match = routes.find((r) => r.regex.test(pathname));

// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
// Wrapped in an async IIFE to avoid top-level await, which causes Bun's HTML
// bundler to misidentify which chunk to reference as the entry in index.html.
(async () => {
  if (_match) {
    const _mod = await _match.load();
    const match = { ..._match, component: _mod.default.component, pageRoute: _mod.default._route };

    const dataEl = document.getElementById("__FURIN_DATA__");
    const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    const rootEl = document.getElementById("root") as HTMLElement;

    const app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: match,
      initialData: loaderData,
    } as any);

    if (import.meta.hot) {
      if (import.meta.hot.data.root) {
        // HMR re-render — update in place without remounting
        import.meta.hot.data.root.render(app);
      } else if (rootEl.innerHTML.trim()) {
        // First load with SSR content — hydrateRoot renders on construction
        import.meta.hot.data.root = hydrateRoot(rootEl, app);
      } else {
        // First load without SSR content — createRoot requires explicit .render()
        const freshRoot = createRoot(rootEl);
        freshRoot.render(app);
        import.meta.hot.data.root = freshRoot;
      }
    } else if (rootEl.innerHTML.trim()) {
      hydrateRoot(rootEl, app);
    } else {
      createRoot(rootEl).render(app);
    }
    log.info({ action: "hydrate_complete", pathname });
  } else {
    log.error({ action: "hydrate_no_match", pathname });
  }
})();
`;
}

/**
 * Writes _hydrate.tsx + index.html to outDir for dev (Bun HMR) mode.
 *
 * Only rewrites a file when its content has actually changed so Bun's --hot
 * watcher does not trigger a spurious reload on every server restart.
 */
export function writeDevFiles(
  routes: ResolvedRoute[],
  { outDir, rootLayout }: BuildClientOptions,
  projectRoot: string,
): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout);
  const hydratePath = join(outDir, "_hydrate.tsx");
  const existingHydrate = existsSync(hydratePath) ? readFileSync(hydratePath, "utf8") : "";
  if (hydrateCode !== existingHydrate) {
    writeFileSync(hydratePath, hydrateCode);
  }

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (indexHtml !== existingIndex) {
    writeFileSync(indexPath, indexHtml);
  }

  writeRouteTypes(routes, projectRoot);

  console.log("[furin] Dev files written (.furin/_hydrate.tsx + .furin/index.html + furin-env.d.ts)");
}
