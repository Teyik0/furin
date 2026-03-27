/**
 * Bun.plugin that loads page modules into a virtual namespace so they stay
 * out of `--hot`'s file watcher.
 *
 * `--hot` re-evaluates every real source file in the module graph when any
 * tracked file changes.  By resolving page imports to a virtual namespace
 * (`furin-dev-page`), the actual `.tsx` files are never registered as
 * watched sources — edits trigger only the client-side dev bundler (React
 * Fast Refresh) without a full server restart.
 *
 * ## Cache-busting (prevents hydration mismatches)
 *
 * Bun caches every resolved module by its `(namespace, path)` identity.
 * Without cache-busting, the first import of `pages/index.tsx` would be
 * permanently frozen: after a file edit the server would keep returning the
 * stale module while the client received fresh HMR code, causing a React
 * hydration mismatch.
 *
 * Solution: the caller appends `?furin-server&t=<timestamp>` to the import
 * specifier (a new timestamp on every request).  `onResolve` preserves the
 * `?t=...` fragment in the resolved path so each request gets a unique
 * `(namespace, path)` key and Bun always calls `onLoad` fresh.
 *
 * ## Relative import rewriting
 *
 * Modules in a virtual namespace cannot resolve relative specifiers on their
 * own (there is no real directory context).  We rewrite every `./` / `../`
 * path to an absolute one before returning the source.
 */

import { dirname, resolve } from "node:path";

// Matches ?furin-server with an optional &t=<ms> cache-buster.
const FURIN_SERVER_FILTER = /\?furin-server(?:&t=\d+)?$/;
const ANY_FILTER = /.*/;
const T_PARAM_RE = /&t=(\d+)/;
const STRIP_FURIN_SERVER_RE = /\?furin-server.*$/;
const STRIP_T_PARAM_RE = /\?t=\d+$/;

/**
 * Matches relative specifiers in all ESM import / re-export forms:
 *
 *   import { foo }   from "./bar"        ← named import
 *   import foo       from "../baz"       ← default import
 *   import           "./side-effect"     ← side-effect import
 *   export { x }     from "./mod"        ← re-export
 *   export *         from "./mod"        ← namespace re-export
 *   import type { T } from "./types"     ← type import (harmless to rewrite)
 */
const RELATIVE_SPECIFIER_RE = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;

/** @internal exported for testing */
export function rewriteRelativeImports(source: string, dir: string): string {
  return source.replace(RELATIVE_SPECIFIER_RE, (match, relPath) => {
    const absPath = resolve(dir, relPath);
    const keyword = match.startsWith("import") ? "import" : "from";
    return `${keyword} "${absPath}"`;
  });
}

export function registerDevPagePlugin(): void {
  Bun.plugin({
    name: "furin-dev-page-loader",
    setup(build) {
      /**
       * Strip `?furin-server` but keep `?t=<ms>` in the resolved path so
       * each request gets a unique module identity, bypassing Bun's cache.
       */
      build.onResolve({ filter: FURIN_SERVER_FILTER }, (args) => {
        const tMatch = T_PARAM_RE.exec(args.path);
        const filePath = args.path.replace(STRIP_FURIN_SERVER_RE, "");
        const resolvedPath = tMatch ? `${filePath}?t=${tMatch[1]}` : filePath;
        return { path: resolvedPath, namespace: "furin-dev-page" };
      });

      /**
       * Read the page file fresh from disk.  The `?t=...` suffix guarantees
       * this handler is called on every request; strip it before file I/O.
       * Return the raw TypeScript/TSX source — Bun transpiles it correctly
       * (including JSX runtime helpers) when given `loader: "tsx"`.
       */
      build.onLoad({ namespace: "furin-dev-page", filter: ANY_FILTER }, async (args) => {
        const filePath = args.path.replace(STRIP_T_PARAM_RE, "");
        const raw = await Bun.file(filePath).text();
        const contents = rewriteRelativeImports(raw, dirname(filePath));
        return {
          contents,
          loader: filePath.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  });
}
