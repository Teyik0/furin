/**
 * Import rewriting for development modules served from a virtual namespace:
 * pins React packages and the JSX runtime to one on-disk instance and resolves
 * relative and bare specifiers from the source file. Each edit stays on its
 * line, so Bun's own transpiler reports source line numbers in stack traces.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MagicString from "magic-string";
import { parseSource } from "../shared/parser.ts";
import { walkAST } from "../shared/utils/ast-walk.ts";
import { rewriteModuleSpecifiers } from "./dev/rewrite-module-specifiers.ts";
import { routeModuleSourceVersion } from "./router/source-version.ts";

export const WORKSPACE_SOURCE_FILTER =
  /^(?!.*(?:[\\/]node_modules[\\/]|[\\/]\.bun[\\/]))(?!.*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$).*\.(?:m?[jt]s|[jt]sx)$/;

export type SourceLoader = "js" | "jsx" | "ts" | "tsx";

// ── Singleton package resolution ───────────────────────────────────────────────
//
// React (and react-dom) must be singletons: every module in the render graph
// must import the EXACT same object instance so that ReactSharedInternals.H
// (the hooks dispatcher) is shared between react-dom/server and the page.
//
// We resolve the absolute on-disk path once at module-evaluation time and
// rewrite every explicit import in the source to use that path. The JSX
// runtime import that Bun's transpiler adds is pinned by pinJsxRuntime below.

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
    SINGLETON_PATHS.set(pkg, toImportSpecifier(fileURLToPath(import.meta.resolve(pkg))));
  } catch {
    // Package not installed — skip (e.g. react-dom/client in a server-only env)
  }
}

/** Converts a native absolute path to Bun's cross-platform import format. */
export function toImportSpecifier(filePath: string): string {
  return filePath.replaceAll("\\", "/");
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
export function rewriteSingletonImports(source: string, loader: SourceLoader): string {
  const result = new MagicString(source);
  for (const statement of parseSource(source, loader).program.body) {
    if (
      statement.type !== "ImportDeclaration" &&
      statement.type !== "ExportNamedDeclaration" &&
      statement.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    const specifier = statement.source;
    if (!specifier) {
      continue;
    }
    const path = SINGLETON_PATHS.get(specifier.value);
    if (path) {
      result.overwrite(specifier.start, specifier.end, JSON.stringify(path));
    }
  }
  return result.toString();
}

/**
 * Bun's transpiler imports the JSX runtime by its bare specifier, which a
 * virtual-namespace module resolves from the process CWD rather than from the
 * page. A leading `@jsxImportSource` pragma pins it to the React instance of
 * `react-dom/server`. The pragma is a file URL because it ends at whitespace,
 * and it shares the first line so every source line keeps its number.
 */
export function pinJsxRuntime(source: string, loader: SourceLoader): string {
  const runtime = SINGLETON_PATHS.get("react/jsx-dev-runtime");
  if (!runtime || loader === "ts") {
    return source;
  }
  const pragma = `/** @jsxImportSource ${pathToFileURL(dirname(runtime)).href} */ `;
  // A shebang must stay first: pin on line 2 so no source line moves.
  const shebangEnd = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  return shebangEnd > 0
    ? `${source.slice(0, shebangEnd)}${pragma}${source.slice(shebangEnd)}`
    : `${pragma}${source}`;
}

/** @internal exported for testing */
export function rewriteRelativeImports(source: string, dir: string): string {
  return rewriteModuleSpecifiers({
    code: source,
    filePath: resolve(dir, "__furin_entry.tsx"),
    versioned: false,
  });
}

export function rewriteRelativeImportsWithVersion(
  source: string,
  filePath: string,
  versioned: boolean
): string {
  return rewriteModuleSpecifiers({
    code: source,
    filePath,
    versioned,
  });
}

/**
 * Resolves static imports, re-exports, and literal dynamic imports from the
 * page file's directory, including tsconfig aliases in virtual modules.
 *
 * @internal exported for testing
 */
export function rewriteBareImports(source: string, dir: string, loader: SourceLoader): string {
  const output = new MagicString(source);
  walkAST(parseSource(source, loader).program, (node) => {
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration" &&
      node.type !== "ImportExpression"
    ) {
      return;
    }
    const literal = node.source;
    if (literal?.type !== "Literal") {
      return;
    }
    const specifier = literal.value;
    if (
      typeof specifier !== "string" ||
      specifier.startsWith(".") ||
      isAbsolute(specifier) ||
      specifier.startsWith("file:") ||
      SINGLETON_PATHS.has(specifier)
    ) {
      return;
    }

    let resolved: string;
    try {
      resolved = toImportSpecifier(Bun.resolveSync(specifier, dir));
    } catch {
      // Leave unresolved imports to Bun's native resolution and diagnostics.
      return;
    }
    if (
      WORKSPACE_SOURCE_FILTER.test(resolved) &&
      specifier !== "furin" &&
      !specifier.startsWith("furin/") &&
      specifier !== "@teyik0/furin" &&
      !specifier.startsWith("@teyik0/furin/")
    ) {
      resolved = `${resolved}?furin-server&t=${routeModuleSourceVersion(resolved)}`;
    }
    output.update(literal.start, literal.end, JSON.stringify(resolved));
  });
  return output.toString();
}
