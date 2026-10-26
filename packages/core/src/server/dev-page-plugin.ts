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
 * Solution: the caller appends `?furin-server&t=<source-version>` to the import
 * specifier. `onResolve` preserves the `?t=...` fragment in the resolved path,
 * so Bun calls `onLoad` again after an edit without allocating a new permanent
 * ESM registry entry for every request.
 *
 * ## Relative import rewriting
 *
 * Modules in a virtual namespace cannot resolve relative specifiers on their
 * own (there is no real directory context).  We rewrite every `./` / `../`
 * path to an absolute one before returning the source. Local JS/TS dependencies
 * use the same source-version rule as routes, so refreshing a route does not
 * retain an old helper module. Shared dependencies keep one identity per version.
 *
 * ## Bare specifier rewriting
 *
 * In a virtual namespace, Bun resolves bare specifiers
 * (e.g. `@teyik0/furin/link`, `shiki`) from the process CWD — not from the
 * page file's directory.  On a cold start the CWD and the file's directory
 * often agree, but after `bun --hot` re-evaluates the server the module
 * cache for project-local packages (like `packages/core/src/link.tsx`) may
 * be cleared and re-loaded with a fresh React instance that diverges from the
 * one already cached by `react-dom/server`.  The result is the classic
 * "two React copies" crash: `dispatcher.useState === null`.
 *
 * Fix: before returning the source, resolve every bare specifier from the page
 * file's directory via `Bun.resolveSync` and replace it with the
 * canonical on-disk path.  This pins each import to exactly the same
 * file-system location that Bun's native module resolver would choose,
 * guaranteeing a single shared React instance regardless of CWD or
 * hot-reload state.
 *
 * Static imports, re-exports, and literal dynamic imports are rewritten from
 * the parsed module, leaving ordinary strings and comments untouched.
 */

import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseModule, removeRange } from "../plugin/module-transform.ts";
import { splitDevPage } from "../plugin/transform-dev-page.ts";
import { transformIsomorphicFunctions } from "../plugin/transform-isomorphic.ts";
import { invalidateDevLoaderCacheBySource } from "./cache/dev-loader.ts";
import { publishDevError } from "./dev/error.ts";
import { developmentGraphs, resolveDevSourceImports } from "./dev/graph.ts";
import { DevTransformFailure } from "./dev/transform-failure.ts";
import {
  pinJsxRuntime,
  rewriteBareImports,
  rewriteRelativeImportsWithVersion,
  rewriteSingletonImports,
  type SourceLoader,
  toImportSpecifier,
  WORKSPACE_SOURCE_FILTER,
} from "./dev-page-imports.ts";
import { detectLoaderFromPath, SCRIPT_FILE_FILTER } from "./lang-detect.ts";
import { routeModuleSourceVersion } from "./router/source-version.ts";

// Matches ?furin-server with an optional &t=<ms> cache-buster.
const FURIN_SERVER_FILTER = /\?furin-server(?:&t=\d+)?$/;
const FURIN_RENDER_FILTER = /\?furin-render&t=\d+$/;
const COMMONJS_FILE_RE = /\.c[jt]s$/;
const ANY_FILTER = /.*/;
const T_PARAM_RE = /&t=(\d+)/;
const STRIP_FURIN_SERVER_RE = /\?furin-server.*$/;
const STRIP_T_PARAM_RE = /\?t=\d+$/;
const DELETED_DEV_PAGE_CONTENTS = "export const route = undefined;";
const CSS_IMPORT = /\.css(?:\?.*)?$/;

let _pluginRegistered = false;
const pluginSourceStamps = new Map<string, string>();

interface CachedDevPageContents {
  contents: string;
  moduleIdentity: string;
}

function getSourceLoader(filePath: string): SourceLoader | null {
  return SCRIPT_FILE_FILTER.test(filePath) ? detectLoaderFromPath(filePath) : null;
}

function shouldSkipWorkspaceTransform(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.furin/");
}

function recordDevImports(source: string, filePath: string): void {
  const { imports } = resolveDevSourceImports(source, filePath, getSourceLoader(filePath) ?? "tsx");
  for (const path of imports) {
    if (!isAbsolute(path) || getSourceLoader(path)) {
      continue;
    }
    // Plugin loaders match the original extension (e.g. .mdx), so a query
    // suffix cannot version these modules. Evict only an edited source.
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    const stamp = `${stats.mtimeNs}:${stats.size}`;
    const previous = pluginSourceStamps.get(path);
    if (previous !== undefined && previous !== stamp) {
      Reflect.deleteProperty(require.cache, path);
      for (const cachedPath of Object.keys(require.cache)) {
        if (toImportSpecifier(cachedPath) === toImportSpecifier(path)) {
          Reflect.deleteProperty(require.cache, cachedPath);
        }
      }
    }
    pluginSourceStamps.set(path, stamp);
  }
  for (const graph of developmentGraphs()) {
    graph.recordImports(toImportSpecifier(filePath), imports);
  }
}

function rethrowWithSourcePath(error: unknown, filePath: string): never {
  const position =
    typeof error === "object" && error !== null && "position" in error
      ? (error as { position?: { column?: unknown; line?: unknown } }).position
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const sourcePosition = {
    column: typeof position?.column === "number" ? position.column : null,
    file: filePath,
    line: typeof position?.line === "number" ? position.line : null,
  };
  const sourced = new Error(message, { cause: error });
  if (error instanceof Error && error.stack) {
    sourced.stack = error.stack;
  }
  Reflect.set(sourced, "furinPosition", sourcePosition);
  for (const graph of developmentGraphs()) {
    graph.recordSourceError(message, sourcePosition);
    const route = graph.snapshot?.routes.find((candidate) =>
      graph.dependsOn(candidate.path, filePath)
    );
    if (!route && graph.snapshot?.root.path !== filePath) {
      continue;
    }
    publishDevError(graph, sourced, {
      entryPath: route?.path ?? filePath,
      phase: "transform",
      route: route?.pattern ?? "*",
    });
  }
  throw sourced;
}

export function transformDevSource(
  raw: string,
  filePath: string,
  options: {
    renderFragment?: boolean;
    rewriteBareImports: boolean;
    rewriteRelativeImports: boolean;
  }
): string {
  const loader = getSourceLoader(filePath);
  if (!loader) {
    throw new Error(`[furin] Unsupported source loader for ${filePath}`);
  }

  for (const graph of developmentGraphs()) {
    graph.clearSourceErrors(filePath);
  }
  try {
    if (!options.renderFragment) {
      recordDevImports(raw, filePath);
    }
    // CSS belongs to Bun's browser graph; importing it here also registers it with --hot.
    const server = parseModule(raw, filePath);
    for (const statement of server.program.body) {
      if (
        statement.type === "ImportDeclaration" &&
        statement.specifiers.length === 0 &&
        CSS_IMPORT.test(statement.source.value)
      ) {
        removeRange(server, statement.start, statement.end);
      }
    }
    const isomorphicSource = transformIsomorphicFunctions(
      server.source.toString(),
      filePath,
      "server"
    ).code;
    const split = options.renderFragment
      ? undefined
      : splitDevPage(
          isomorphicSource,
          filePath,
          `${filePath}?furin-render&t=${routeModuleSourceVersion(filePath)}`
        );
    const serverSource = split?.contract ?? isomorphicSource;
    let result = options.rewriteRelativeImports
      ? rewriteRelativeImportsWithVersion(serverSource, filePath, true)
      : serverSource;
    if (options.rewriteBareImports) {
      result = rewriteBareImports(result, dirname(filePath), loader);
    }

    result = rewriteSingletonImports(result, loader);
    return pinJsxRuntime(result, loader);
  } catch (error) {
    return rethrowWithSourcePath(error, filePath);
  }
}

function isMissingSourceFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** @internal exported for testing */
export async function loadDevPageContents(
  filePath: string,
  moduleIdentity: string,
  transformedSourceCache: Map<string, CachedDevPageContents>
): Promise<string> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (error) {
    if (isMissingSourceFile(error)) {
      const cached = transformedSourceCache.get(filePath);
      transformedSourceCache.delete(filePath);
      return cached?.moduleIdentity === moduleIdentity
        ? cached.contents
        : DELETED_DEV_PAGE_CONTENTS;
    }
    throw error;
  }

  let contents: string;
  try {
    contents = transformDevSource(raw, filePath, {
      rewriteBareImports: true,
      rewriteRelativeImports: true,
    });
  } catch (error) {
    throw new DevTransformFailure(error, { cause: error });
  }
  transformedSourceCache.set(filePath, { contents, moduleIdentity });
  return contents;
}

export function registerDevPagePlugin(): void {
  if (_pluginRegistered) {
    return;
  }
  _pluginRegistered = true;
  Bun.plugin({
    name: "furin-dev-page-loader",
    setup(build) {
      build.onResolve({ filter: FURIN_RENDER_FILTER }, (args) => ({
        namespace: "furin-dev-render",
        path: args.path,
      }));
      build.onLoad({ filter: ANY_FILTER, namespace: "furin-dev-render" }, async (args) => {
        const filePath = args.path.slice(0, args.path.indexOf("?furin-render"));
        const raw = await Bun.file(filePath).text();
        const source = transformIsomorphicFunctions(raw, filePath, "server").code;
        const split = splitDevPage(source, filePath, args.path);
        if (!split) {
          throw new Error(`[furin] Page changed while loading its render module: ${filePath}`);
        }
        return {
          contents: transformDevSource(split.render, filePath, {
            renderFragment: true,
            rewriteBareImports: true,
            rewriteRelativeImports: true,
          }),
          loader: detectLoaderFromPath(filePath),
        };
      });
      // Keep an already-loaded module generation usable if its source is
      // deleted while Bun finishes that same generation. A later generation
      // receives a tombstone instead of reviving the removed route.
      const transformedSourceCache = new Map<string, CachedDevPageContents>();

      /**
       * Strip `?furin-server` but keep `?t=<source-version>` in the resolved
       * path so each edited version gets a new module identity.
       */
      build.onResolve({ filter: FURIN_SERVER_FILTER }, (args) => {
        const tMatch = T_PARAM_RE.exec(args.path);
        const filePath = args.path.replace(STRIP_FURIN_SERVER_RE, "");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the timestamp query is optional.
        const resolvedPath = tMatch ? `${filePath}?t=${tMatch[1]}` : filePath;
        return {
          namespace: COMMONJS_FILE_RE.test(filePath) ? "file" : "furin-dev-page",
          path: resolvedPath,
        };
      });

      /**
       * Workspace source files imported by plain path (local components, core
       * packages, etc.) still load through Bun's normal file namespace in dev.
       *
       * After bun --hot re-evaluates part of that graph, those modules can
       * re-import React through a different logical path than react-dom/server,
       * which recreates the classic "dispatcher is null" invalid hook crash.
       *
       * Rewrite only the React singleton imports and the JSX runtime so every
       * SSR module observes the exact same React instance, while still keeping
       * the files in Bun's watched graph.
       */
      build.onLoad({ filter: WORKSPACE_SOURCE_FILTER }, async (args) => {
        const raw = await Bun.file(args.path).text();
        const loader = getSourceLoader(args.path);
        if (!loader) {
          throw new Error(`[furin] Unsupported source loader for ${args.path}`);
        }

        // Every re-evaluation of a workspace source in dev is either the
        // initial load (cache empty → no-op) or a post-edit HMR re-read.
        // Both are correct moments to drop dependent dev loader cache
        // entries — they will be re-populated on the next request.
        invalidateDevLoaderCacheBySource(args.path);

        if (shouldSkipWorkspaceTransform(args.path)) {
          return {
            contents: raw,
            loader,
          };
        }

        let contents: string;
        try {
          contents = transformDevSource(raw, args.path, {
            rewriteBareImports: false,
            rewriteRelativeImports: false,
          });
        } catch (error) {
          throw new DevTransformFailure(error, { cause: error });
        }

        return {
          contents,
          loader,
        };
      });

      /**
       * Read the page file fresh from disk. The `?t=...` suffix guarantees
       * this handler is called for each edited source version; strip it before
       * file I/O.
       *
       * ## Why specifiers are rewritten in the source
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
       *  2. **Auto-injected JSX runtime** — `import { jsxDEV } from
       *     "react/jsx-dev-runtime"` added by Bun's TSX transpiler AFTER
       *     `onLoad` returns, resolved from the process CWD.
       *
       * Solution: rewrite the specifiers in the TS/TSX source and return it
       * with its own loader. Bun transpiles it and maps stack frames to the
       * returned text (it ignores an `onLoad` sourcemap), so every rewrite
       * stays on its line:
       *
       *  • `rewriteRelativeImports` → converts `./root` to `/abs/path/root`
       *  • `rewriteBareImports` → resolves ALL bare specifiers (including
       *    `@teyik0/furin/link`, `shiki`, etc.) to canonical absolute paths
       *    from the page file's directory, preventing "two React copies" after
       *    bun --hot re-evaluation.
       *  • `rewriteSingletonImports` → belt-and-suspenders for react singletons
       *    (covered by rewriteBareImports but kept for safety).
       *  • `pinJsxRuntime` → points the auto-injected JSX runtime import at the
       *    same React package with an `@jsxImportSource` pragma.
       */
      build.onLoad({ filter: ANY_FILTER, namespace: "furin-dev-page" }, async (args) => {
        const filePath = args.path.replace(STRIP_T_PARAM_RE, "");
        const contents = await loadDevPageContents(filePath, args.path, transformedSourceCache);

        return {
          contents,
          loader: detectLoaderFromPath(filePath),
        };
      });
    },
  });
}
