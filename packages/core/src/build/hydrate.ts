import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIndexHtml } from "../server/render/shell.ts";
import {
  buildRouteRegex,
  compareRouteSpecificity,
} from "../server/router/patterns.ts";
import { mergeRouteSchemas } from "../server/router/schema-merge.ts";
import type { ResolvedRoute } from "../server/router/types.ts";
import { collectSearchDefaults } from "../shared/search-params.ts";
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
  basePath: string,
  clientLogging: boolean
): string {
  const getBoundaryIdent = (idents: Map<string, string>, filePath: string | undefined) => {
    if (!filePath) {
      return;
    }
    const existing = idents.get(filePath);
    if (existing) {
      return existing;
    }
    const ident = `__furin_bnd_${idents.size}`;
    idents.set(filePath, ident);
    return ident;
  };

  const routeEntries: string[] = [];

  const clientRoutes = [...routes].sort((a, b) =>
    compareRouteSpecificity(b.pattern, a.pattern),
  );

  for (const route of clientRoutes) {
    const resolvedPage = route.path.replace(/\\/g, "/");
    const regexPattern = buildRouteRegex(route.pattern).regex.source;
    const searchDefaults = collectSearchDefaults(
      mergeRouteSchemas(route.routeChain ?? [], "query")
    );
    const boundaryIdents = new Map<string, string>();
    const layoutPaths = (route.routeChain ?? [])
      .slice(1)
      .filter((entry) => entry.layout && entry.sourcePath)
      .map((entry) => entry.sourcePath as string);
    const layoutIdents = layoutPaths.map((_, index) => `__furin_layout_${index}`);

    // Emit one boundary literal per segment that actually carries a convention
    // file — segments that only declare one of the two are emitted with the
    // missing field omitted entirely (keeps the generated JS tidy).
    const boundaryLiterals: string[] = [];
    for (const seg of route.segmentBoundaries ?? []) {
      const errorIdent = getBoundaryIdent(boundaryIdents, seg.errorPath);
      const notFoundIdent = getBoundaryIdent(boundaryIdents, seg.notFoundPath);
      if (!(errorIdent || notFoundIdent)) {
        continue;
      }
      const parts = [`depth: ${seg.depth}`];
      if (errorIdent) {
        parts.push(`error: ${errorIdent}.default`);
      }
      if (notFoundIdent) {
        parts.push(`notFound: ${notFoundIdent}.default`);
      }
      boundaryLiterals.push(`{ ${parts.join(", ")} }`);
    }

    const lazyImports = [
      `import("${resolvedPage}")`,
      ...layoutPaths.map((filePath) => `import("${filePath.replace(/\\/g, "/")}")`),
      ...[...boundaryIdents.keys()].map((filePath) => `import("${filePath.replace(/\\/g, "/")}")`),
    ];
    const importIdents = ["__furin_page", ...layoutIdents, ...boundaryIdents.values()];
    const layoutAssignments = layoutPaths
      .map((filePath, index) => {
        const ident = layoutIdents[index];
        const componentKey = JSON.stringify(`layout:${filePath.replace(/\\/g, "/")}`);
        return `const __furin_layout_route_${index} = ${ident}.route; __furin_parent = { __type: "FURIN_ROUTE", layout: hotComponent(${componentKey}, __furin_layout_route_${index}.component), parent: __furin_parent };`;
      })
      .join(" ");
    const boundaryResult =
      boundaryLiterals.length > 0
        ? `, segmentBoundaries: [${boundaryLiterals.join(", ")}]`
        : "";
    const pageComponentKey = JSON.stringify(`page:${resolvedPage}`);
    const loadBody = `Promise.all([${lazyImports.join(", ")}]).then(([${importIdents.join(", ")}]) => { const __furin_page_route = __furin_page.route; let __furin_parent = root; ${layoutAssignments} return { default: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", parent: __furin_parent }, component: hotComponent(${pageComponentKey}, __furin_page_route.component) }${boundaryResult} }; })`;

    const searchDefaultsEntry = searchDefaults
      ? `, searchDefaults: ${JSON.stringify(searchDefaults)}`
      : "";
    routeEntries.push(
      ` { pattern: "${route.pattern}", regex: new RegExp(${JSON.stringify(regexPattern)}), load: () => ${loadBody}${searchDefaultsEntry} }`
    );
  }

  // basePath stripping: when deployed to a sub-path (e.g. /furin), strip the
  // prefix before route matching so patterns like /docs/routing still work.
  const basePathLiteral = JSON.stringify(basePath);
  // Strip basePath only when it matches on a path boundary (prevents "/furin" from
  // matching "/furinity/foo"). The boundary holds when the pathname ends exactly
  // at the prefix length OR the next character is "/".
  // Trailing slashes are also stripped so "/docs/routing/" matches the route
  // pattern "/docs/routing" — GitHub Pages and many static hosts append them.
  const pathnameExpr = basePath
    ? `(() => { const p = window.location.pathname; const b = ${basePathLiteral}; const stripped = (p.startsWith(b) && (p.length === b.length || p[b.length] === "/")) ? p.slice(b.length) || "/" : p; return stripped === "/" ? "/" : stripped.replace(/\\/+$/, ""); })()`
    : `window.location.pathname.replace(/\\/+$/, "") || "/"`;

  // Log drain endpoint: prepend basePath so the request goes to the correct origin path.
  const logEndpoint = basePath
    ? `${JSON.stringify(basePath)} + "/_furin/ingest"`
    : `"/_furin/ingest"`;

  // Client-side HTTP draining is opt-in (config `clientLogging`). When disabled
  // we emit neither the hydrate-entry evlog imports nor initLogger, and define a
  // no-op `log` shim so the hydration body's log.* calls stay valid.
  const loggingImports = clientLogging
    ? 'import { initLogger, log } from "evlog";\nimport { createHttpLogDrain } from "evlog/http";\n'
    : "";
  const loggerSetup = clientLogging
    ? `initLogger({ drain: createHttpLogDrain({ drain: { endpoint: ${logEndpoint} } }) });`
    : "const log = { error() {}, info() {} };";

  // RouterProvider receives basePath so navigate() / Link push physical paths.
  const routerProviderDefaults = `\n      autoRefresh: true,\n      basePath: ${basePathLiteral},\n      defaultPreload: "intent",\n      defaultPreloadDelay: 50,\n      defaultPreloadStaleTime: 30000,\n      prefetchCacheSize: 50,\n      syncStream,`;

  const resolvedRootLayout = rootLayout.replace(/\\/g, "/");
  const rootComponentKey = JSON.stringify(`root:${resolvedRootLayout}`);

  return `import { hydrateRoot } from "react-dom/client";
import { createElement, type ReactNode } from "react";
${loggingImports}import { DocumentProvider, type DocumentState, type HotComponentRegistry, updateHotComponent } from "@teyik0/furin/client";
import { RouterProvider } from "@teyik0/furin/link";
import { fromCrossJSON, parseDeferredNdjson } from "@teyik0/furin/link";
import type { SerovalNode } from "seroval";
import { route as __furin_root_route } from "${resolvedRootLayout}";

${loggerSetup}

const hotComponentRegistry = ((window as unknown as {
  __FURIN_HOT_COMPONENTS__?: HotComponentRegistry;
}).__FURIN_HOT_COMPONENTS__ ??= new Map());
const hotComponent = <Props,>(key: string, component: (props: Props) => ReactNode) =>
  import.meta.hot ? updateHotComponent(hotComponentRegistry, key, component) : component;
const __furin_root_component = hotComponent(${rootComponentKey}, __furin_root_route.component);
const root = {
  ...__furin_root_route,
  component: __furin_root_component,
  layout: __furin_root_component,
};

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
let loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
const syncEl = document.getElementById("__FURIN_SYNC__");
const syncConfig = syncEl ? JSON.parse(syncEl.textContent || "{}") : {};
const syncStream = typeof syncConfig.stream === "string" ? syncConfig.stream : undefined;
const headEl = document.getElementById("__FURIN_HEAD__");
const head = headEl ? JSON.parse(headEl.textContent || "{}") : {};
const entryEl = document.querySelector("script[type=module][src]") as HTMLScriptElement | null;
const buildId = document.querySelector('meta[name="furin-build-id"]')?.getAttribute("content") ?? undefined;
const faviconHref = document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? undefined;
const documentState: DocumentState = {
  assets: {
    buildId,
    entryModule: entryEl?.getAttribute("src") ?? undefined,
    faviconHref,
    staticMode: document.querySelector('meta[name="furin-mode"][content="static"]') !== null,
    stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((link) => link.getAttribute("href") ?? "")
      .filter(Boolean),
  },
  dataJson: dataEl?.textContent ?? undefined,
  head,
  syncJson: syncEl?.textContent ?? undefined,
};

// ── Deferred data hydration ─────────────────────────────────────────────────
// window.__FURIN_DEFERRED__ is injected by the server when a loader returns
// defer(). It carries:
//   - _chunks: raw CrossJSON chunks keyed by field name (from late <script> tags)
// We deserialise each chunk with fromCrossJSON and create a Promise so <Await>
// components receive a proper resolved Promise instead of the raw CrossJSON node.
// Sync loader fields live exclusively in __FURIN_DATA__ (read above).
interface FurinDeferredRegistry {
  _chunks: Record<string, { a: 0 | 1; v: SerovalNode }>;
  _deferredKeys: string[];
  _resolvers: Record<string, {
    promise: Promise<unknown>;
    reject: (reason: unknown) => void;
    resolve: (value: unknown) => void;
  }>;
  getPromise: (key: string) => Promise<unknown>;
  reject: (key: string, chunk: SerovalNode) => void;
  resolve: (key: string, chunk: SerovalNode) => void;
}
interface FurinRouteFrameStream {
  stream: (initial: string) => ReadableStream<Uint8Array>;
}
const __deferred = (window as unknown as { __FURIN_DEFERRED__?: FurinDeferredRegistry })
  .__FURIN_DEFERRED__;
const deferredData: Record<string, Promise<unknown>> = {};
if (__deferred && __deferred._chunks) {
  // Patch resolve/reject so any chunks that arrive AFTER this entry has run
  // settle immediately. The previous version stored late chunks in _chunks
  // when no resolver was registered yet, but the drain loop below only runs
  // ONCE at hydrate time — so any chunk landing after the drain would stay
  // orphaned and the corresponding Await would hang forever. Eagerly creating
  // the resolver via getPromise() fixes the race.
  __deferred.resolve = (key: string, chunk: SerovalNode) => {
    __deferred.getPromise(key);
    __deferred._resolvers[key].resolve(fromCrossJSON(chunk, {}));
  };
  __deferred.reject = (key: string, chunk: SerovalNode) => {
    __deferred.getPromise(key);
    __deferred._resolvers[key].reject(fromCrossJSON(chunk, {}));
  };
    for (const key of Object.keys(__deferred._chunks)) {
      const entry = __deferred._chunks[key] as { a: 0 | 1; v: SerovalNode };
      const p = __deferred.getPromise(key) as Promise<unknown>;
      const resolver = __deferred._resolvers[key];
      const value = fromCrossJSON(entry.v, {});
      if (entry.a === 0) {
        resolver.resolve(value);
      } else {
        resolver.reject(value);
      }
      deferredData[key] = p;
    }
    for (const key of __deferred._deferredKeys ?? []) {
      if (!(key in deferredData)) {
        deferredData[key] = __deferred.getPromise(key) as Promise<unknown>;
      }
    }
    // Keys that have a resolver (getPromise was called by <Await>) but no
    // chunk yet (the late <script> hasn't arrived) still need a Promise entry
    // so the hydration data record is complete.
    for (const key of Object.keys(__deferred._resolvers ?? {})) {
      if (!(key in deferredData)) {
        deferredData[key] = __deferred.getPromise(key) as Promise<unknown>;
      }
    }
  }
// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
// Wrapped in an async IIFE to avoid top-level await, which causes Bun's HTML
// bundler to misidentify which chunk to reference as the entry in index.html.
(async () => {
  const frameTemplate = document.getElementById("__FURIN_ROUTE_FRAMES__") as HTMLTemplateElement | null;
  if (frameTemplate) {
    const payload = frameTemplate.content.textContent || "";
    const routeFrameStream = (window as unknown as { __FURIN_ROUTE_FRAME_STREAM__?: FurinRouteFrameStream })
      .__FURIN_ROUTE_FRAME_STREAM__;
    const parsed = await parseDeferredNdjson(
      routeFrameStream ? routeFrameStream.stream(payload) : new Blob([payload]).stream(),
      undefined
    );
    loaderData = { ...parsed.syncData, ...parsed.deferredPromises };
  }
  let app;
  if (_match) {
    const _mod = await _match.load();
    const match = {
      ..._match,
      component: _mod.default.component,
      pageRoute: _mod.default._route,
      segmentBoundaries: _mod.segmentBoundaries ?? _match.segmentBoundaries,
    };

    const isNotFound = loaderData.__furinStatus === 404;

    app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: match,
      initialData: { ...loaderData, ...deferredData },
      initialDigest: loaderData.__furinError?.digest,
      initialNotFound: isNotFound ? (loaderData.__furinNotFound ?? loaderData) : undefined,${routerProviderDefaults}
    } as any);
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
      initialNotFound: loaderData.__furinNotFound ?? {},${routerProviderDefaults}
    } as any);
  } else {
    // No match and no 404 signal — either the client bundle is out of sync
    // with the server (stale deploy) or the server returned something we
    // don't know how to hydrate. Bail loudly; the page stays static.
    log.error({ action: "hydrate_no_match", pathname });
    return;
  }
  app = createElement(DocumentProvider, { value: documentState }, app);

  if (import.meta.hot) {
    // Dev mode — preserve root across HMR using a window global.
    // window is the only object that survives Bun's module re-evaluation.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only HMR global
    const existingRoot = (window as any).__FURIN_ROOT__;
    const hmrWindow = window as unknown as {
      __FURIN_HMR_UPDATE__?: (
        sourcePath: string,
        component: (props: never) => ReactNode
      ) => void;
    };
    hmrWindow.__FURIN_HMR_UPDATE__ = (sourcePath, component) => {
      const componentKeySuffix = ":" + sourcePath;
      for (const key of hotComponentRegistry.keys()) {
        if (key.endsWith(componentKeySuffix)) {
          updateHotComponent(hotComponentRegistry, key, component);
        }
      }
      (window as any).__FURIN_ROOT__?.render(app);
      const refresh = (window as any).__FURIN_HMR_REFRESH__;
      if (refresh) {
        requestAnimationFrame(() => refresh());
      }
    };
    if (existingRoot) {
      // Already mounted — reconciliation, NOT hydration. React Fast Refresh
      // patched the component in-place, now re-render with the new module.
      existingRoot.render(app);
      // The initialData embedded in the DOM is stale (from the original SSR).
      // Trigger a loader-data refresh so the component renders with fresh
      // server state, avoiding hydration mismatches after a _route.tsx edit.
      const hmrRefresh = (window as any).__FURIN_HMR_REFRESH__;
      if (hmrRefresh) {
        requestAnimationFrame(() => hmrRefresh());
      }
    } else {
      // First load — the root layout owns the server-rendered document.
      const root = hydrateRoot(document, app);
      // biome-ignore lint/suspicious/noExplicitAny: dev-only HMR global
      (window as any).__FURIN_ROOT__ = root;
    }
  } else {
    hydrateRoot(document, app);
  }

  log.info({ action: "hydrate_complete", pathname });
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
  { outDir, rootLayout, basePath, clientLogging, skipRouteTypes }: BuildClientOptions,
  projectRoot: string
): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout, basePath, clientLogging);
  const hydratePath = join(outDir, "_hydrate.tsx");
  const existingHydrate = existsSync(hydratePath) ? readFileSync(hydratePath, "utf8") : "";
  let changed = false;
  if (hydrateCode !== existingHydrate) {
    writeFileSync(hydratePath, hydrateCode);
    changed = true;
  }

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (indexHtml !== existingIndex) {
    writeFileSync(indexPath, indexHtml);
    changed = true;
  }

  if (!skipRouteTypes) {
    changed = writeRouteTypes(routes, projectRoot) || changed;
  }

  if (changed) {
    console.log(
      "[furin] Dev files written (.furin/_hydrate.tsx + .furin/index.html + furin-env.d.ts)"
    );
  }
}
