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
 *
 * ## Bare specifier rewriting
 *
 * When `onLoad` returns `loader: "js"`, Bun resolves bare specifiers
 * (e.g. `@teyik0/furin/link`, `shiki`) from the process CWD — not from the
 * page file's directory.  On a cold start the CWD and the file's directory
 * often agree, but after `bun --hot` re-evaluates the server the module
 * cache for project-local packages (like `packages/core/src/link.tsx`) may
 * be cleared and re-loaded with a fresh React instance that diverges from the
 * one already cached by `react-dom/server`.  The result is the classic
 * "two React copies" crash: `dispatcher.useState === null`.
 *
 * Fix: after transpilation, resolve every bare specifier from the page
 * file's directory via `Bun.resolveSync` and replace it with the
 * canonical on-disk path.  This pins each import to exactly the same
 * file-system location that Bun's native module resolver would choose,
 * guaranteeing a single shared React instance regardless of CWD or
 * hot-reload state.
 *
 * All import/re-export occurrences of each quoted specifier are replaced using
 * a context-aware regex (requires a preceding `from` or `import` keyword) so
 * that modules which both import and re-export from the same package are fully
 * rewritten while string literals in non-import positions are left untouched.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Matches ?furin-server with an optional &t=<ms> cache-buster.
const FURIN_SERVER_FILTER = /\?furin-server(?:&t=\d+)?$/;
const ANY_FILTER = /.*/;
const WORKSPACE_SOURCE_FILTER =
  /^(?!.*(?:\/node_modules\/|\/\.bun\/))(?!.*\.(?:test|spec)\.[jt]sx?$).*\.[jt]sx?$/;
const T_PARAM_RE = /&t=(\d+)/;
const STRIP_FURIN_SERVER_RE = /\?furin-server.*$/;
const STRIP_T_PARAM_RE = /\?t=\d+$/;

type SourceLoader = "js" | "jsx" | "ts" | "tsx";

// ── Singleton package resolution ───────────────────────────────────────────────
//
// React (and react-dom) must be singletons: every module in the render graph
// must import the EXACT same object instance so that ReactSharedInternals.H
// (the hooks dispatcher) is shared between react-dom/server and the page.
//
// We resolve the absolute on-disk path once at module-evaluation time and
// rewrite every explicit import in the transpiled source to use that path.
// The auto-injected jsx-dev-runtime import (added by Bun.Transpiler AFTER the
// source is transformed) is handled by injectJsxHelperImports below.

/** React packages that must share a single instance across the module graph. */
const SINGLETON_PKGS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/server",
  "react-dom/client",
] as const;

/** package specifier → absolute file path, resolved once at plugin registration time. */
const SINGLETON_PATHS = new Map<string, string>();
for (const pkg of SINGLETON_PKGS) {
  try {
    SINGLETON_PATHS.set(pkg, fileURLToPath(import.meta.resolve(pkg)));
  } catch {
    // Package not installed — skip (e.g. react-dom/client in a server-only env)
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites bare React/react-dom singleton imports in source text to their
 * absolute resolved paths. Handles explicit static import / re-export forms:
 *
 *   import { useState } from "react"          → import { useState } from "/abs/…"
 *   import type { FC }  from "react"
 *   export { x }        from "react"
 *   import               "react/jsx-dev-runtime"
 *
 * Does NOT touch dynamic `import("react")` or `require("react")`.
 *
 * @internal exported for testing
 */
export function rewriteSingletonImports(source: string): string {
  let result = source;
  for (const [pkg, absPath] of SINGLETON_PATHS) {
    const re = new RegExp(`((?:from|import(?:\\s+type)?)\\s+)["']${escapeRegExp(pkg)}["']`, "g");
    result = result.replace(re, (_, g1: string) => `${g1}"${absPath}"`);
  }
  return result;
}

/**
 * `Bun.Transpiler.transformSync` converts JSX syntax to function calls using
 * mangled helper names (e.g. `jsxDEV_7x81h0kn`, `Fragment_8vg9x3sq`) but does
 * NOT emit the corresponding import statement — it expects Bun's full bundler
 * pipeline to inject it later.
 *
 * When we return pre-transpiled JS from `onLoad`, that pipeline step never
 * runs, leaving the helpers as undefined free variables.  This function scans
 * the transpiled source, detects which mangled helper names are used, and
 * prepends the correct import statements using absolute on-disk paths from
 * `SINGLETON_PATHS`.
 *
 * Helper → package mapping:
 *   jsxDEV_*   → `{ jsxDEV  as … }` from react/jsx-dev-runtime
 *   Fragment_*  → `{ Fragment as … }` from react/jsx-dev-runtime
 *   jsx_*       → `{ jsx    as … }` from react/jsx-runtime  (prod only)
 *   jsxs_*      → `{ jsxs   as … }` from react/jsx-runtime  (prod only)
 *
 * @internal exported for testing
 */
export function injectJsxHelperImports(transpiled: string): string {
  // Match mangled JSX helper names. Alternation order matters: try longer
  // prefixes first so "jsxDEV_xxx" isn't partially matched as "jsx_xxx".
  const JSX_HELPER_RE = /\b(jsxDEV|jsxs|jsx|Fragment)_([0-9a-z]{8})\b/g;

  // Package → Map<varName, exportName>
  const devRuntime = new Map<string, string>(); // react/jsx-dev-runtime
  const prodRuntime = new Map<string, string>(); // react/jsx-runtime

  for (const [, base, hash] of transpiled.matchAll(JSX_HELPER_RE)) {
    if (!(base && hash)) {
      continue;
    }
    const varName = `${base}_${hash}`;
    if (base === "jsxDEV" || base === "Fragment") {
      devRuntime.set(varName, base);
    } else {
      prodRuntime.set(varName, base);
    }
  }

  const lines: string[] = [];

  if (devRuntime.size > 0) {
    const absPath = SINGLETON_PATHS.get("react/jsx-dev-runtime");
    if (absPath) {
      const specifiers = [...devRuntime.entries()]
        .map(([varName, exportName]) => `${exportName} as ${varName}`)
        .join(", ");
      lines.push(`import { ${specifiers} } from "${absPath}";`);
    }
  }

  if (prodRuntime.size > 0) {
    const absPath = SINGLETON_PATHS.get("react/jsx-runtime");
    if (absPath) {
      const specifiers = [...prodRuntime.entries()]
        .map(([varName, exportName]) => `${exportName} as ${varName}`)
        .join(", ");
      lines.push(`import { ${specifiers} } from "${absPath}";`);
    }
  }

  if (lines.length === 0) {
    return transpiled;
  }
  return `${lines.join("\n")}\n${transpiled}`;
}

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
  return source.replace(RELATIVE_SPECIFIER_RE, (match, relPath, offset) => {
    // Skip matches that appear on a comment line (// ...)
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    const linePrefix = source.slice(lineStart, offset).trimStart();
    if (linePrefix.startsWith("//") || linePrefix.startsWith("*")) {
      return match;
    }
    const absPath = resolve(dir, relPath);
    const keyword = match.startsWith("import") ? "import" : "from";
    return `${keyword} "${absPath}"`;
  });
}

/**
 * Rewrites all remaining bare specifiers in the transpiled JS to absolute
 * on-disk paths resolved from `dir` (the page file's directory).
 *
 * Uses `Bun.Transpiler.scan()` on the original source to get the authoritative
 * list of *actual* import specifiers (parsing correctly handles template
 * literals, comments, etc.).  For each bare specifier that is not already
 * handled by `rewriteSingletonImports`, it calls `Bun.resolveSync` and
 * replaces **every** import/re-export occurrence of the quoted specifier using
 * a context-aware regex with the `g` flag — mirroring the approach used by
 * `rewriteSingletonImports`.  This correctly handles modules that both import
 * and re-export from the same package without leaving any bare specifier
 * behind.  String literals that happen to contain the same text (inside
 * template literals, JSX props, etc.) are not touched because the regex
 * requires a preceding `from` or `import` keyword.
 *
 * @internal exported for testing
 */
export function rewriteBareImports(source: string, transpiled: string, dir: string): string {
  const scanner = new Bun.Transpiler({ loader: "tsx" });
  let { imports } = scanner.scan(source);
  // Deduplicate: scan() may return the same specifier multiple times if it
  // appears in both `import` and `export ... from` positions.
  const seen = new Set<string>();
  imports = imports.filter((imp) => {
    if (seen.has(imp.path)) {
      return false;
    }
    seen.add(imp.path);
    return true;
  });

  let result = transpiled;
  for (const imp of imports) {
    const spec = imp.path;
    // Skip relative paths (already rewritten by rewriteRelativeImports before transpilation)
    // and already-absolute paths.
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) {
      continue;
    }
    // Skip React singletons — already handled by rewriteSingletonImports.
    if (SINGLETON_PATHS.has(spec)) {
      continue;
    }

    let resolved: string;
    try {
      resolved = Bun.resolveSync(spec, dir);
    } catch {
      // Not resolvable from the file's directory — leave as a bare specifier
      // so Bun falls back to CWD-relative resolution (adequate for most cases).
      continue;
    }

    // Replace ALL import/re-export occurrences of the bare specifier using a
    // context-aware regex with the `g` flag. This correctly handles modules
    // that both import and re-export from the same package. The regex only
    // matches when the specifier is preceded by `from` or `import` so string
    // literals in non-import positions are left untouched.
    const re = new RegExp(`((?:from|import(?:\\s+type)?)\\s+)["']${escapeRegExp(spec)}["']`, "g");
    result = result.replace(re, (_, g1: string) => `${g1}"${resolved}"`);
  }
  return result;
}

function getSourceLoader(filePath: string): SourceLoader | null {
  if (filePath.endsWith(".tsx")) {
    return "tsx";
  }
  if (filePath.endsWith(".ts")) {
    return "ts";
  }
  if (filePath.endsWith(".jsx")) {
    return "jsx";
  }
  if (filePath.endsWith(".js")) {
    return "js";
  }
  return null;
}

function shouldSkipWorkspaceTransform(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.furin/");
}

function transformDevSource(
  raw: string,
  filePath: string,
  options: { rewriteBareImports: boolean; rewriteRelativeImports: boolean }
): string {
  const loader = getSourceLoader(filePath);
  if (!loader) {
    throw new Error(`[furin] Unsupported source loader for ${filePath}`);
  }

  const dir = dirname(filePath);
  const sourceForTranspile = options.rewriteRelativeImports
    ? rewriteRelativeImports(raw, dir)
    : raw;
  const transpiler = new Bun.Transpiler({ loader });
  const transpiled = transpiler.transformSync(sourceForTranspile, loader);

  let result = transpiled;
  if (options.rewriteBareImports) {
    result = rewriteBareImports(raw, result, dir);
  }

  result = rewriteSingletonImports(result);
  return injectJsxHelperImports(result);
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
       * Workspace source files (root.tsx, _route.tsx, local components, core
       * packages, etc.) still load through Bun's normal file namespace in dev.
       *
       * After bun --hot re-evaluates part of that graph, those modules can
       * re-import React through a different logical path than react-dom/server,
       * which recreates the classic "dispatcher is null" invalid hook crash.
       *
       * Pre-transpile those files and rewrite only the React singleton imports
       * so every SSR module observes the exact same React instance, while still
       * keeping the files in Bun's watched graph for root.tsx HMR.
       */
      build.onLoad({ filter: WORKSPACE_SOURCE_FILTER }, async (args) => {
        const raw = await Bun.file(args.path).text();
        const loader = getSourceLoader(args.path);
        if (!loader) {
          throw new Error(`[furin] Unsupported source loader for ${args.path}`);
        }

        if (shouldSkipWorkspaceTransform(args.path)) {
          return {
            contents: raw,
            loader,
          };
        }

        const contents = transformDevSource(raw, args.path, {
          rewriteBareImports: false,
          rewriteRelativeImports: false,
        });

        return {
          contents,
          loader: "js",
        };
      });

      /**
       * Read the page file fresh from disk.  The `?t=...` suffix guarantees
       * this handler is called on every request; strip it before file I/O.
       *
       * ## Why we pre-transpile with Bun.Transpiler
       *
       * Bun's runtime plugin system (used by `bun --hot`) does NOT route
       * sub-imports from virtual-namespace modules through `onResolve` hooks —
       * the `namespace` filter on `onResolve` only works in the bundler context
       * (`Bun.build()`), not in the runtime module loader.  This means two
       * classes of specifiers inside a `furin-dev-page` module cannot be
       * intercepted after the fact:
       *
       *  1. **Relative imports** (`./root`, `../utils`) — no real directory
       *     context in the virtual namespace → Bun fails to resolve them.
       *  2. **Auto-injected JSX runtime** — `import { jsx } from
       *     "react/jsx-dev-runtime"` added by Bun's TSX transpiler AFTER
       *     `onLoad` returns → cannot be rewritten in the source text.
       *
       * Solution: pre-transpile the source with `Bun.Transpiler` ourselves,
       * then rewrite all specifiers in the resulting JS text before returning
       * it with `loader: "js"` (which Bun loads as-is, with no further
       * transpilation or automatic import injection):
       *
       *  • `rewriteRelativeImports` → converts `./root` to `/abs/path/root`
       *  • `rewriteBareImports` → resolves ALL bare specifiers (including
       *    `@teyik0/furin/link`, `shiki`, etc.) to canonical absolute paths
       *    from the page file's directory, preventing "two React copies" after
       *    bun --hot re-evaluation.
       *  • `rewriteSingletonImports` → belt-and-suspenders for react singletons
       *    (covered by rewriteBareImports but kept for safety).
       *  • `injectJsxHelperImports` → adds the JSX helper imports that
       *    `Bun.Transpiler` emits as free variables without corresponding imports.
       */
      build.onLoad({ namespace: "furin-dev-page", filter: ANY_FILTER }, async (args) => {
        const filePath = args.path.replace(STRIP_T_PARAM_RE, "");
        const raw = await Bun.file(filePath).text();
        const contents = transformDevSource(raw, filePath, {
          rewriteBareImports: true,
          rewriteRelativeImports: true,
        });

        return {
          contents,
          loader: "js", // Already fully transpiled — skip Bun's own TSX step.
        };
      });
    },
  });
}
