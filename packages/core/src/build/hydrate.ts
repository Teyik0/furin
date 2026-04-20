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
 * @param basePath - Optional sub-path prefix for static deployments (e.g. "/furin").
 *   When set, the generated code strips the prefix from `window.location.pathname`
 *   before matching routes, and passes `basePath` to `RouterProvider` so SPA
 *   navigation uses the correct physical URLs.
 */
export function generateHydrateEntry(
  routes: ResolvedRoute[],
  rootLayout: string,
  basePath: string
): string {
  // Deduplicate convention-file paths across all routes so each physical file
  // produces ONE static import, even when shared by many routes (e.g. the
  // pages-dir-level error.tsx covers every page at depth 0).
  const conventionIdents = new Map<string, string>();
  const getIdent = (filePath: string | undefined): string | undefined => {
    if (!filePath) {
      return;
    }
    const existing = conventionIdents.get(filePath);
    if (existing) {
      return existing;
    }
    const ident = `__furin_bnd_${conventionIdents.size}`;
    conventionIdents.set(filePath, ident);
    return ident;
  };

  const routeEntries: string[] = [];

  for (const route of routes) {
    const resolvedPage = route.path.replace(/\\/g, "/");
    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    // Emit one boundary literal per segment that actually carries a convention
    // file — segments that only declare one of the two are emitted with the
    // missing field omitted entirely (keeps the generated JS tidy).
    const boundaryLiterals: string[] = [];
    for (const seg of route.segmentBoundaries ?? []) {
      const errorIdent = getIdent(seg.errorPath);
      const notFoundIdent = getIdent(seg.notFoundPath);
      if (!(errorIdent || notFoundIdent)) {
        continue;
      }
      const parts = [`depth: ${seg.depth}`];
      if (errorIdent) {
        parts.push(`error: ${errorIdent}`);
      }
      if (notFoundIdent) {
        parts.push(`notFound: ${notFoundIdent}`);
      }
      boundaryLiterals.push(`{ ${parts.join(", ")} }`);
    }
    const boundariesField =
      boundaryLiterals.length > 0 ? `, segmentBoundaries: [${boundaryLiterals.join(", ")}]` : "";

    routeEntries.push(
      ` { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), load: () => import("${resolvedPage}")${boundariesField} }`
    );
  }

  // Collect all deduplicated convention-file imports. Emitted BEFORE the
  // route array so the idents are in scope when the array literal is built.
  const conventionImportLines = [...conventionIdents.entries()]
    .map(([filePath, ident]) => `import ${ident} from "${filePath.replace(/\\/g, "/")}";`)
    .join("\n");

  // basePath stripping: when deployed to a sub-path (e.g. /furin), strip the
  // prefix before route matching so patterns like /docs/routing still work.
  const basePathLiteral = JSON.stringify(basePath);
  // Strip basePath only when it matches on a path boundary (prevents "/furin" from
  // matching "/furinity/foo"). The boundary holds when the pathname ends exactly
  // at the prefix length OR the next character is "/".
  const pathnameExpr = basePath
    ? `(() => { const p = window.location.pathname; const b = ${basePathLiteral}; return (p.startsWith(b) && (p.length === b.length || p[b.length] === "/")) ? p.slice(b.length) || "/" : p; })()`
    : "window.location.pathname";

  // Log drain endpoint: prepend basePath so the request goes to the correct origin path.
  const logEndpoint = basePath
    ? `${JSON.stringify(basePath)} + "/_furin/ingest"`
    : `"/_furin/ingest"`;

  // RouterProvider receives basePath so navigate() / Link push physical paths.
  const basePathProp = basePath ? `\n      basePath: ${basePathLiteral},` : "";

  const conventionImportsBlock = conventionImportLines ? `\n${conventionImportLines}` : "";

  return `import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";
import { initLogger, log } from "evlog";
import { createHttpLogDrain } from "evlog/http";
import { RouterProvider } from "@teyik0/furin/link";
import { route as root } from "${rootLayout.replace(/\\/g, "/")}";${conventionImportsBlock}

initLogger({ drain: createHttpLogDrain({ drain: { endpoint: ${logEndpoint} } }) });

const routes = [
${routeEntries.join(",\n")}
];

const pathname = ${pathnameExpr};
const _match = routes.find((r) => r.regex.test(pathname));

// Parse the server-embedded loader payload up front. It carries:
//   - normal loader props under arbitrary keys,
//   - __furinError.digest when SSR caught an error,
//   - __furinStatus: 404 when the server rendered the catch-all not-found
//     (direct load to an unknown URL, emitted by renderRootNotFound) OR when
//     a matched loader threw notFound(). The latter still has a _match; the
//     former does not — so the two cases fork on _match below.
const dataEl = document.getElementById("__FURIN_DATA__");
const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
const rootEl = document.getElementById("root") as HTMLElement;

// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
// Wrapped in an async IIFE to avoid top-level await, which causes Bun's HTML
// bundler to misidentify which chunk to reference as the entry in index.html.
(async () => {
  let app;
  if (_match) {
    const _mod = await _match.load();
    const match = { ..._match, component: _mod.default.component, pageRoute: _mod.default._route };

    app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: match,
      initialData: loaderData,
      initialDigest: loaderData.__furinError?.digest,
      initialNotFound: undefined,${basePathProp}
    } as any);
    log.info({ action: "hydrate_complete", pathname });
  } else if (loaderData.__furinStatus === 404) {
    // Direct load to an unknown URL. The server sent the root not-found UI
    // already rendered into the DOM. Mount RouterProvider with a null match
    // so the provider boots into its not-found branch, hydrating that exact
    // tree INSIDE a live RouterContext. Without this, Links in the 404 UI
    // (e.g. the default screen's "Go Home" button) hit the useRouter()
    // fallback that does a full window.location assignment — a jarring reload.
    // Strip the server-only signal keys before handing data to components.
    const { __furinStatus: _s, __furinNotFound: _n, ...cleanData } = loaderData;
    app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: null,
      initialData: cleanData,
      initialDigest: loaderData.__furinError?.digest,
      initialNotFound: loaderData.__furinNotFound ?? {},${basePathProp}
    } as any);
    log.info({ action: "hydrate_not_found", pathname });
  } else {
    // No match and no 404 signal — either the client bundle is out of sync
    // with the server (stale deploy) or the server returned something we
    // don't know how to hydrate. Bail loudly; the page stays static.
    log.error({ action: "hydrate_no_match", pathname });
    return;
  }

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
})().catch((err: unknown) => {
  log.error({ action: "hydrate_failed", pathname, error: String(err) });
});
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
  { outDir, rootLayout, basePath }: BuildClientOptions,
  projectRoot: string
): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout, basePath);
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

  console.log(
    "[furin] Dev files written (.furin/_hydrate.tsx + .furin/index.html + furin-env.d.ts)"
  );
}
