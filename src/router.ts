import { parse } from "node:path";
import { Glob } from "bun";
import { isPageModule, type PageModule, type PageOptions } from "./page";

export interface ResolvedRoute {
  pattern: string; // URL pattern e.g. /blog/:slug
  path: string;
  module: PageModule;
  mode: NonNullable<PageOptions["mode"]>;

  /** ISR cache entry if applicable */
  isrCache?: {
    html: string;
    generatedAt: number;
    revalidate: number;
  };

  /** Pre-rendered HTML for SSG pages */
  ssgHtml?: string;
}

/**
 * Scan the pages directory and resolve all routes.
 *
 * @param pagesDir - Absolute path to the pages directory
 * @returns Array of resolved routes with patterns, modules, and modes
 *
 * @example
 * File-based routing conventions:
 * ```
 * index.tsx        → /
 * about.tsx        → /about
 * blog/index.tsx   → /blog
 * blog/[slug].tsx  → /blog/:slug
 * [...catch].tsx   → /* (catch-all)
 * _hidden.tsx      → ignored (underscore prefix)
 * ```
 */
export const scanPages = async (pagesDir: string) => {
  const routes: ResolvedRoute[] = [];

  const glob = new Glob("**/*.tsx");
  for await (const absolutePath of glob.scan({
    cwd: pagesDir,
    absolute: true,
  })) {
    if (
      ![".tsx", ".ts", ".jsx", ".js"].some((ext) => absolutePath.endsWith(ext))
    ) {
      continue;
    }
    if (absolutePath.startsWith("_")) {
      continue;
    }

    const page = (await import(absolutePath)).default;
    if (!isPageModule(page)) {
      console.warn(
        `[elysion] Skipping ${absolutePath}: no valid page() export found`
      );
      continue;
    }
    const relativePath = absolutePath.replace(`${pagesDir}/`, "");

    routes.push({
      pattern: filePathToPattern(relativePath),
      module: page,
      path: absolutePath,
      mode: resolveMode(page),
    });
  }

  return routes;
};

function resolveMode(pageModule: PageModule) {
  const { options } = pageModule;

  // Validate: explicit mode conflicts with revalidate
  if (
    options?.mode !== "isr" &&
    options?.revalidate &&
    options.revalidate > 0
  ) {
    throw new Error(
      `[elysion] Invalid config: cannot set both 'mode' and 'revalidate'. Use 'mode: "isr"' with 'revalidate' or remove 'mode'.`
    );
  }

  // Explicit mode always wins
  if (options?.mode) {
    return options.mode;
  }

  // No loader → static
  if (!options?.loader) {
    return "ssg";
  }

  // Has revalidate → ISR
  if (options?.revalidate && options?.revalidate > 0) {
    return "isr";
  }

  // Has loader → SSR
  return "ssr";
}

function filePathToPattern(path: string): string {
  const parts = path.split("/");
  const segments: string[] = [];

  for (const part of parts) {
    const name = parse(part).name;

    if (name === "index") {
      // index files map to the parent directory
      continue;
    }

    // [slug] → :slug
    if (name.startsWith("[") && name.endsWith("]")) {
      const inner = name.slice(1, -1);

      // [...catch] → * (catch-all)
      if (inner.startsWith("...")) {
        segments.push("*");
        continue;
      }

      segments.push(`:${inner}`);
      continue;
    }

    segments.push(name);
  }

  return `/${segments.join("/")}`;
}
