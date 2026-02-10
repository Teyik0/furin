import { mkdir as nodeMkdir, rm as nodeRm, watch as nodeWatch } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { file, Glob, write } from "bun";

interface ManifestEntry {
  js?: string;
  css?: string;
}

interface BuildManifest {
  [route: string]: ManifestEntry;
}

const MANIFEST_PATH = resolve(process.cwd(), "dist", "client", "manifest.json");
let manifestCache: BuildManifest | null = null;

/**
 * Generate a unique entry point file for a page that imports:
 * 1. The page component
 * 2. Its CSS modules
 * 3. The hydration logic
 */
function generateClientEntry(_pagePath: string, relativeToRoot: string): string {
  const componentImport = relativeToRoot.replace(/\\/g, "/");

  return `
import { hydrateRoot } from "react-dom/client";
import pageModule from "${componentImport}";

const PageComponent = pageModule.component;

// Import CSS modules if they exist
const styleModules = import.meta.glob("${componentImport.replace(/\.tsx?$/, ".module.css")}", { eager: true });

function init() {
  const dataElement = document.getElementById("__ELYSION_DATA__");
  const data = dataElement ? JSON.parse(dataElement.textContent || "{}") : {};

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("[elysion] Root element not found");
    return;
  }

  hydrateRoot(rootElement, <PageComponent {...data} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;
}

export async function buildPages(pagesDir: string, options: { minify: boolean; sourcemap: boolean }): Promise<BuildManifest> {
  const manifest: BuildManifest = {};

  // Ensure output directory exists
  const outDir = resolve(process.cwd(), "dist", "client");
  await nodeRm(outDir, { recursive: true, force: true });
  await nodeMkdir(outDir, { recursive: true });

  // Find all page files
  const glob = new Glob("**/*.{tsx,jsx}");
  const pageFiles: string[] = [];

  for await (const path of glob.scan({ cwd: pagesDir, absolute: true })) {
    if (!basename(path).startsWith("_")) {
      pageFiles.push(path);
    }
  }

  // Build each page
  for (const pagePath of pageFiles) {
    const relativePath = relative(pagesDir, pagePath);
    const route = filePathToRoute(relativePath);
    const entryCode = generateClientEntry(pagePath, pagePath);

    // Create a temporary entry file
    const entryFile = join(outDir, "__entry__", `${route.replace(/[^a-zA-Z0-9]/g, "_")}.tsx`);
    await nodeMkdir(dirname(entryFile), { recursive: true });
    await write(entryFile, entryCode);

    // Build with Bun
    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: outDir,
      minify: options.minify,
      sourcemap: options.sourcemap ? "inline" : "none",
      splitting: true,
      target: "browser",
      format: "esm",
      naming: {
        entry: "[name]-[hash].js",
        chunk: "_shared/[name]-[hash].js",
        asset: "[name]-[hash][ext]",
      },
      external: ["elysion", "elysion/*", "src/index.ts", "src/build.ts", "src/router.ts", "bun", "node:*"],
    });

    if (!result.success) {
      console.error(`[elysion] Build failed for ${route}:`, result.logs);
      continue;
    }

    // Find the generated JS and CSS files
    const jsFile = result.outputs.find((o) => o.path.endsWith(".js"));
    const cssFile = result.outputs.find((o) => o.path.endsWith(".css"));

    if (jsFile) {
      manifest[route] = {
        js: `/client/${basename(jsFile.path)}`,
        css: cssFile ? `/client/${basename(cssFile.path)}` : undefined,
      };
    }
  }

  // Save manifest
  await nodeMkdir(outDir, { recursive: true });
  await write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  manifestCache = manifest;

  console.log(`[elysion] Built ${Object.keys(manifest).length} client bundles`);

  // Clean up temporary entry files
  const entryDir = join(outDir, "__entry__");
  await nodeRm(entryDir, { recursive: true, force: true });

  return manifest;
}

/**
 * Get client assets for a specific route from the manifest
 */
export async function getClientAssets(route: string): Promise<ManifestEntry | undefined> {
  if (!manifestCache) {
    try {
      const manifestFile = file(MANIFEST_PATH);
      if (await manifestFile.exists()) {
        manifestCache = await manifestFile.json();
      }
    } catch {
      return undefined;
    }
  }

  // Normalize route
  const normalizedRoute = route === "/index" ? "/" : route.replace(/\/?index$/, "");

  return manifestCache?.[normalizedRoute];
}

/**
 * Convert file path to route pattern
 */
function filePathToRoute(filePath: string): string {
  const withoutExt = filePath.replace(/\.(tsx|jsx|ts|js)$/, "");
  const parts = withoutExt.split(/[\\/]/);

  const routeParts: string[] = [];
  for (const part of parts) {
    if (part === "index") {
      continue;
    }
    routeParts.push(part);
  }

  return "/" + routeParts.join("/");
}

/**
 * Clear the manifest cache (useful in dev mode)
 */
export function clearManifestCache(): void {
  manifestCache = null;
}

/**
 * Watch pages directory and rebuild on changes (dev mode)
 */
export async function watchPages(pagesDir: string, onRebuild?: () => void): Promise<void> {
  console.log("[elysion] Watching pages for changes...");

  const watcher = nodeWatch(pagesDir, { recursive: true });

  for await (const event of watcher) {
    if (event.filename?.match(/\.(tsx|jsx|css)$/)) {
      console.log(`[elysion] Change detected: ${event.filename}`);
      clearManifestCache();
      await buildPages(pagesDir, { minify: false, sourcemap: true });
      onRebuild?.();
    }
  }
}
