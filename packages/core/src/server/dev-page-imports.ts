/**
 * Import rewriting for development modules served from a virtual namespace:
 * pins React packages to one on-disk instance, injects the JSX helper imports
 * Bun.Transpiler leaves implicit, resolves relative and bare specifiers from
 * the source file, and restores import attributes the transpiler drops.
 */

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import type { Node, NodeOfType } from "yuku-parser";
import { parseSource } from "../shared/parser.ts";
import { walkAST } from "../shared/utils/ast-walk.ts";
import { rewriteModuleSpecifiers } from "./dev/rewrite-module-specifiers.ts";
import { routeModuleSourceVersion } from "./router/source-version.ts";

export const WORKSPACE_SOURCE_FILTER =
  /^(?!.*(?:[\\/]node_modules[\\/]|[\\/]\.bun[\\/]))(?!.*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$).*\.(?:m?[jt]s|[jt]sx)$/;

const IMPORT_ATTRIBUTES_RE = /\b(?:with|assert)\s*\{/;

export type SourceLoader = "js" | "jsx" | "ts" | "tsx";

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
export function rewriteSingletonImports(source: string): string {
  const result = new MagicString(source);
  for (const statement of parseSource(source, "tsx").program.body) {
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
      lines.push(`import { ${specifiers} } from ${JSON.stringify(absPath)};`);
    }
  }

  if (prodRuntime.size > 0) {
    const absPath = SINGLETON_PATHS.get("react/jsx-runtime");
    if (absPath) {
      const specifiers = [...prodRuntime.entries()]
        .map(([varName, exportName]) => `${exportName} as ${varName}`)
        .join(", ");
      lines.push(`import { ${specifiers} } from ${JSON.stringify(absPath)};`);
    }
  }

  if (lines.length === 0) {
    return transpiled;
  }
  return `${lines.join("\n")}\n${transpiled}`;
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
export function rewriteBareImports(transpiled: string, dir: string): string {
  const output = new MagicString(transpiled);
  walkAST(parseSource(transpiled, "js").program, (node) => {
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

type SourceDeclaration = NodeOfType<
  "ExportAllDeclaration" | "ExportNamedDeclaration" | "ImportDeclaration"
>;

function isSourceDeclaration(node: Node): node is SourceDeclaration {
  return (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration"
  );
}

function isTypeOnly(declaration: SourceDeclaration): boolean {
  if (
    (declaration.type === "ImportDeclaration" ? declaration.importKind : declaration.exportKind) ===
    "type"
  ) {
    return true;
  }
  const specifiers = declaration.type === "ExportAllDeclaration" ? [] : declaration.specifiers;
  return (
    specifiers.length > 0 &&
    specifiers.every(
      (specifier) =>
        (specifier.type === "ImportSpecifier" && specifier.importKind === "type") ||
        (specifier.type === "ExportSpecifier" && specifier.exportKind === "type")
    )
  );
}

// Bun.Transpiler drops static import attributes, turning text imports into file paths.
export function restoreImportAttributes(
  source: string,
  transpiled: string,
  loader: SourceLoader
): string {
  if (!IMPORT_ATTRIBUTES_RE.test(source)) {
    return transpiled;
  }

  const declarations = parseSource(source, loader).program.body.filter(isSourceDeclaration);
  const output = new MagicString(transpiled);
  const emitted = parseSource(transpiled, "js").program.body.filter(isSourceDeclaration);
  const matched = new Set<SourceDeclaration>();
  for (const declaration of declarations) {
    if (isTypeOnly(declaration)) {
      continue;
    }
    const sourcePath = declaration.source?.value;
    if (sourcePath === undefined) {
      continue;
    }
    const target = emitted.find(
      (node) =>
        !matched.has(node) && node.type === declaration.type && node.source?.value === sourcePath
    );
    if (!target) {
      continue;
    }
    matched.add(target);
    const { attributes } = declaration;
    if (!attributes.length || target.attributes.length) {
      continue;
    }
    const [first] = attributes;
    const last = attributes.at(-1);
    const imported = target.source;
    if (first && last && imported) {
      output.appendLeft(imported.end, ` with { ${source.slice(first.start, last.end)} }`);
    }
  }
  return output.toString();
}
