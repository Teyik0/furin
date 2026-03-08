import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformForClient } from "./adapter/transform-client";
import type { ResolvedRoute } from "./router";

export interface BuildClientOptions {
  dev?: boolean;
  outDir?: string;
  pagesDir?: string;
  rootPath: string;
}

const TS_FILE_FILTER = /\.(tsx|ts)$/;
const REACT_IMPORT_RE = /import\s+React\b/;

// ── Hydrate entry ──────────────────────────────────────────────────────────

/**
 * Generates the client hydration entry.
 *
 * Renders into <div id="root"> (the SSR outlet element) and retains the React
 * root across hot reloads via import.meta.hot.data.root so React Fast Refresh
 * applies in-place instead of remounting.
 *
 * @param clientPaths - Optional map from source abs path → pre-transformed abs path.
 *   When provided, imports reference the browser-safe pre-transformed files in
 *   .elyra/pages/ instead of the TypeScript source files.
 */
function generateHydrateEntry(routes: ResolvedRoute[], rootPath: string): string {
  const routeEntries: string[] = [];

  for (const route of routes) {
    const resolvedRoute = route as ResolvedRoute;
    const resolvedPage = resolvedRoute.path.replace(/\\/g, "/");

    const regexPattern = resolvedRoute.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    routeEntries.push(
      ` { pattern: "${resolvedRoute.pattern}", regex: new RegExp("^${regexPattern}$"), load: () => import("${resolvedPage}") }`
    );
  }

  return `import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";
import { RouterProvider } from "elyra/link";
import { route as root } from "${rootPath.replace(/\\/g, "/")}";

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const _match = routes.find((r) => r.regex.test(pathname));

// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
if (_match) {
  const _mod = await _match.load();
  const match = { ..._match, component: _mod.default.component, pageRoute: _mod.default._route };

  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const rootEl = document.getElementById("root") as HTMLElement;

  const app = createElement(RouterProvider, {
    routes,
    root,
    initialMatch: match,
    initialData: loaderData,
  } as any);

  if (import.meta.hot) {
    // Retain React root across hot reloads so Fast Refresh applies in-place.
    const hotRoot = (import.meta.hot.data.root ??= rootEl.innerHTML.trim()
      ? hydrateRoot(rootEl, app)
      : createRoot(rootEl));
    hotRoot.render(app);
  } else if (rootEl.innerHTML.trim()) {
    hydrateRoot(rootEl, app);
  } else {
    createRoot(rootEl).render(app);
  }
} else {
  console.warn("[elyra] No matching route for", pathname);
}
`;
}

/** @internal Exported for unit testing only. */
export function patternToTypeString(pattern: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — generates TS template literal syntax
  const t = pattern.replace(/:[^/]+/g, "${string}").replace(/\*/g, "${string}");
  return t.includes("${") ? `\`${t}\`` : `"${t}"`;
}

/**
 * Converts a runtime TypeBox/JSON Schema object to a TypeScript type string.
 * Handles the common cases found in Elysia query schemas (string, number, boolean,
 * optional fields, nullable via anyOf).
 *
 * @internal Exported for unit testing only.
 */
export function schemaToTypeString(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }
  const s = schema as Record<string, unknown>;
  if (s.anyOf && Array.isArray(s.anyOf)) {
    const parts = (s.anyOf as unknown[]).map(schemaToTypeString).filter((t) => t !== "null");
    return parts.join(" | ") || "unknown";
  }
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object": {
      if (!s.properties || typeof s.properties !== "object") {
        return "Record<string, unknown>";
      }
      const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
      const props = Object.entries(s.properties as Record<string, unknown>)
        .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${schemaToTypeString(v)}`)
        .join("; ");
      return `{ ${props} }`;
    }
    default:
      return "unknown";
  }
}

/**
 * Generates .elyra/routes.d.ts — augments RouteManifest in elyra/link
 * so that <Link to="..."> has type-safe autocompletion and <Link search={...}>
 * is typed per-route from the route's query schema.
 *
 * Users must add ".elyra/routes.d.ts" to their tsconfig.json "include" array once.
 */
/** @internal Exported for unit testing only. */
export function writeRouteTypes(routes: ResolvedRoute[], outDir: string): void {
  const entries = routes.map((r) => {
    const typeKey = patternToTypeString(r.pattern);
    const isDynamic = typeKey.startsWith("`");
    const querySchema = r.routeChain?.find((rt) => rt.query)?.query;
    const searchType = querySchema ? schemaToTypeString(querySchema) : "never";
    return isDynamic
      ? `    [key: ${typeKey}]: { search?: ${searchType} }`
      : `    ${typeKey}: { search?: ${searchType} }`;
  });

  const content = `// Auto-generated by Elyra. Do not edit manually.
// Add ".elyra/routes.d.ts" to your tsconfig.json "include" array to enable typed navigation.
import "elyra/link";

declare module "elyra/link" {
  interface RouteManifest {
${entries.join(";\n")};
  }
}
`;

  const typesPath = join(outDir, "routes.d.ts");
  const existing = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
  if (content !== existing) {
    writeFileSync(typesPath, content);
  }
}

// ── Dev: write files for Bun's native HTML bundler ────────────────────────

/**
 * The fixed HTML shell used both in dev (for Bun's HTML bundler) and as the
 * base for the production build entrypoint.  This content never changes —
 * commit it to the repository so the static import in server.ts always works.
 *
 * Bun's HTML bundler:
 *  - Replaces `<script src="./_hydrate.tsx">` with content-hashed chunk tags.
 *  - Injects the HMR WebSocket client into <head>.
 *  - Preserves <!--ssr-head--> and <!--ssr-outlet--> comments for SSR injection.
 */
export function generateIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
    <script type="module" src="./_hydrate.tsx"></script>
  </body>
</html>
`;
}

/**
 * Writes _hydrate.tsx + index.html to outDir for dev (Bun HMR) mode.
 *
 * When pagesDir is provided, also pre-transforms all pages-dir files into
 * .elyra/pages/ (browser-safe JS) so that _hydrate.tsx imports server-free
 * modules — preventing "Browser build cannot import Bun builtin" errors that
 * occur when bundlers encounter bun:sqlite or elysia imports from page files.
 *
 * Only rewrites a file when its content has actually changed so Bun's --hot
 * watcher does not trigger a spurious reload on every server restart.
 */
export function writeDevFiles(routes: ResolvedRoute[], options: BuildClientOptions): void {
  const { outDir = "./.elyra", rootPath } = options;

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootPath);
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

  writeRouteTypes(routes, outDir);

  console.log(
    "[elyra] Dev files written (.elyra/_hydrate.tsx + .elyra/index.html + .elyra/routes.d.ts)"
  );
}

// ── Prod: full Bun.build() via HTML entrypoint ────────────────────────────

/**
 * Builds the production client bundle via Bun.build() using the generated
 * index.html as the HTML entrypoint.  Bun produces:
 *   .elyra/client/index.html  — processed template with hashed chunk paths
 *   .elyra/client/chunk-*.js  — code-split bundles
 *   .elyra/client/styles.css  — CSS (if imported)
 *
 * The output index.html is NOT served to browsers directly.  The server reads
 * it as an SSR template, injects the pre-rendered React HTML into
 * <!--ssr-outlet-->, and sends the complete page.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  options: BuildClientOptions
): Promise<void> {
  const { outDir = "./.elyra", rootPath } = options;
  const clientDir = join(outDir, "client");

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootPath);
  const hydratePath = join(outDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  writeFileSync(indexPath, indexHtml);

  writeRouteTypes(routes, outDir);

  console.log("[elyra] Building production client bundle…");

  const transformPlugin: Bun.BunPlugin = {
    name: "elyra-transform-client",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const code = await Bun.file(path).text();
        try {
          const result = transformForClient(code, path);
          let transformed = result.code;

          if (transformed.includes("React.createElement") && !REACT_IMPORT_RE.test(transformed)) {
            transformed = `import React from "react";\n${transformed}`;
          }

          return {
            contents: transformed,
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
          };
        } catch (error) {
          console.error(`[elyra] Transform error for ${path}:`, error);
          return undefined;
        }
      });
    },
  };

  const result = await Bun.build({
    entrypoints: [indexPath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    plugins: [transformPlugin],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    console.error("[elyra] Client build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Client build failed");
  }

  for (const output of result.outputs) {
    console.log(`[elyra]   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  console.log("[elyra] Production client build complete");
}
