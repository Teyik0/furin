import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedRoute } from "./router";

const FILE_EXTENSION_REGEX = /\.(tsx?|jsx?)$/;

/**
 * Build the client-side hydration bundle using Bun.build.
 *
 * Generates a single `_hydrate.tsx` entrypoint that imports all page
 * components and layout components, matches the current URL, and calls `hydrateRoot`.
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

  const hydrateCode = generateHydrateEntry(routes);
  const hydratePath = join(buildDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  console.log("[elysion] Building client bundle...");

  const result = await Bun.build({
    entrypoints: [hydratePath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
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
 * Generate the `_hydrate.tsx` entrypoint.
 *
 * Creates a client-side router that:
 * 1. Reads the current URL
 * 2. Finds the matching page component
 * 3. Reads `__ELYSION_DATA__` from the script tag
 * 4. Wraps with layout components (outermost first)
 * 5. Calls `hydrateRoot` with the correct element tree
 */
function generateHydrateEntry(routes: ResolvedRoute[]): string {
  const imports: string[] = [];
  const routeEntries: string[] = [];

  // Track unique route file imports to avoid duplicates
  const routeFileImports = new Map<string, string>();
  let routeImportCounter = 0;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as ResolvedRoute;
    const pageName = `Page${i}`;

    // Import the page file
    imports.push(`import ${pageName} from "${route.path.replace(/\\/g, "/")}";`);

    // Import layout components from route.tsx files
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

    // Convert Elysia :param to regex for client-side matching
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
    // Build element tree: wrap page with layouts (outermost first)
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
 * Watch for page file changes and rebuild the client bundle (dev mode).
 */
export function watchPages(pagesDir: string, routes: ResolvedRoute[]): void {
  console.log("[elysion] Watching pages for changes...");

  watch(pagesDir, { recursive: true }, async (_event, filename) => {
    if (!filename) {
      return;
    }
    if (!FILE_EXTENSION_REGEX.test(filename)) {
      return;
    }

    console.log(`[elysion] File changed: ${filename}, rebuilding...`);

    try {
      await buildClient(routes, { dev: true });
      console.log("[elysion] Rebuild complete");
    } catch (err) {
      console.error("[elysion] Rebuild failed:", err);
    }
  });
}
