import { dirname, relative, resolve } from "node:path";
import type * as Babel from "@babel/core";
import { transformSync } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import {
  blockStatement,
  functionDeclaration,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  isObjectProperty,
  isProgram,
  returnStatement,
} from "@babel/types";

const presetTypescript = require.resolve("@babel/preset-typescript");
const presetReact = require.resolve("@babel/preset-react");
const reactRefreshBabelPlugin = require.resolve("react-refresh/babel");

// ---------------------------------------------------------------------------
// Top-level regex constants (satisfies lint/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------
const RELATIVE_IMPORT_RE = /^(import\b[^'"]*?from\s*)(["'])(\.\.?\/[^"']+)\2/gm;
const IMPORT_LINE_RE = /^import\s+(.+?)\s+from\s*["'][^"']+["'];?\s*$/;
const NAMED_IMPORTS_RE = /^\{([^}]+)\}$/;
const DEFAULT_IMPORT_RE = /^(\w+)(?:\s*,\s*\{([^}]+)\})?$/;
const NAMESPACE_IMPORT_RE = /^\*\s+as\s+(\w+)$/;
const SINGLE_LINE_COMMENT_RE = /\/\/[^\n]*/g;
const MULTI_LINE_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const IMPORT_META_HOT_RE = /if\s*\(import\.meta\.hot\)\s*\{/g;
const AS_SPECIFIER_RE = /\s+as\s+/;

// ---------------------------------------------------------------------------
// Babel AST helpers
// ---------------------------------------------------------------------------

function findObjectProperty(
  obj: Babel.types.ObjectExpression,
  name: string
): Babel.types.ObjectProperty | undefined {
  return obj.properties.find(
    (p): p is Babel.types.ObjectProperty => isObjectProperty(p) && isIdentifier(p.key, { name })
  );
}

function removeServerProperties(obj: Babel.types.ObjectExpression, properties: string[]): boolean {
  let removed = false;
  for (const name of properties) {
    const prop = findObjectProperty(obj, name);
    if (prop) {
      const idx = obj.properties.indexOf(prop);
      if (idx !== -1) {
        obj.properties.splice(idx, 1);
        removed = true;
      }
    }
  }
  return removed;
}

function findComponentProperty(arg: Babel.types.Expression): Babel.types.ObjectProperty | null {
  if (!isObjectExpression(arg)) {
    return null;
  }
  const prop = arg.properties.find(
    (p): p is Babel.types.ObjectProperty =>
      isObjectProperty(p) && isIdentifier(p.key, { name: "component" })
  );
  return prop ?? null;
}

function shouldExtractComponent(value: Babel.types.Node): boolean {
  if (isIdentifier(value)) {
    return false;
  }
  return isArrowFunctionExpression(value) || isFunctionExpression(value);
}

function createNamedFunctionFromArrow(
  params: Babel.types.ArrowFunctionExpression["params"],
  body: Babel.types.ArrowFunctionExpression["body"],
  name: Babel.types.Identifier
): Babel.types.FunctionDeclaration {
  const functionBody = isBlockStatement(body) ? body : blockStatement([returnStatement(body)]);
  return functionDeclaration(name, params, functionBody);
}

function insertFunctionBeforeExport(
  path: NodePath<Babel.types.ExportDefaultDeclaration>,
  fn: Babel.types.FunctionDeclaration
): void {
  const program = path.parentPath;
  if (!(program && isProgram(program.node))) {
    return;
  }
  path.insertBefore(fn);
}

const SERVER_ONLY_PROPERTIES = ["loader"];

// ---------------------------------------------------------------------------
// Component extraction from page() calls
// ---------------------------------------------------------------------------

function handlePageCallExtraction(
  path: NodePath<Babel.types.ExportDefaultDeclaration>,
  arg: Babel.types.Expression,
  onExtract: (name: string) => void
): void {
  if (!isObjectExpression(arg)) {
    return;
  }

  removeServerProperties(arg, SERVER_ONLY_PROPERTIES);

  const componentProp = findComponentProperty(arg);
  if (!componentProp) {
    return;
  }

  const componentValue = componentProp.value;
  if (!shouldExtractComponent(componentValue)) {
    return;
  }

  const extractedName = path.scope.generateUidIdentifier("ElysionPage");
  onExtract(extractedName.name);

  if (isArrowFunctionExpression(componentValue) || isFunctionExpression(componentValue)) {
    const namedFunction = createNamedFunctionFromArrow(
      componentValue.params,
      componentValue.body,
      extractedName
    );
    componentProp.value = extractedName;
    insertFunctionBeforeExport(path, namedFunction);
  }
}

function createExtractPlugin(onExtract: (name: string) => void): Babel.PluginObj {
  return {
    name: "extract-page-component",
    visitor: {
      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;

        if (!isCallExpression(decl)) {
          return;
        }

        const arg = decl.arguments[0];
        const callee = decl.callee;

        if (isIdentifier(callee, { name: "page" })) {
          handlePageCallExtraction(path, arg as Babel.types.Expression, onExtract);
          return;
        }

        if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
          return;
        }

        if (isIdentifier(callee, { name: "createRoute" }) && isObjectExpression(arg)) {
          removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
        }
      },

      CallExpression(path) {
        const node = path.node;
        const parent = path.parent;

        if (parent?.type === "ExportDefaultDeclaration") {
          return;
        }

        const callee = node.callee;
        const arg = node.arguments[0];

        if (isIdentifier(callee, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
        } else if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
        } else if (isIdentifier(callee, { name: "createRoute" }) && isObjectExpression(arg)) {
          removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Relative import rewriting
// ---------------------------------------------------------------------------

function rewriteRelativeImports(
  code: string,
  filePath: string,
  srcDir: string,
  _pagesDir: string
): string {
  const fileDir = dirname(filePath);

  return code.replace(RELATIVE_IMPORT_RE, (match, prefix, quote, importPath) => {
    const absoluteImportPath = resolve(fileDir, importPath);

    if (!absoluteImportPath.startsWith(srcDir)) {
      return match;
    }

    const relativeToSrc = relative(srcDir, absoluteImportPath).replace(/\\/g, "/");
    return `${prefix}${quote}/_modules/src/${relativeToSrc}${quote}`;
  });
}

// ---------------------------------------------------------------------------
// Unused import removal — helpers reduce cognitive complexity
// ---------------------------------------------------------------------------

function parseNamedSpecifiers(specStr: string): string[] {
  const namedMatch = specStr.match(NAMED_IMPORTS_RE);
  if (!namedMatch?.[1]) {
    return [];
  }

  const identifiers: string[] = [];
  for (const spec of namedMatch[1].split(",")) {
    const trimmed = spec.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(AS_SPECIFIER_RE);
    const localName = (parts.length > 1 ? parts[1] : parts[0])?.trim();
    if (localName) {
      identifiers.push(localName);
    }
  }
  return identifiers;
}

function parseDefaultAndNamedSpecifiers(specStr: string): string[] {
  const defaultMatch = specStr.match(DEFAULT_IMPORT_RE);
  if (!defaultMatch?.[1]) {
    return [];
  }

  const identifiers: string[] = [defaultMatch[1]];
  if (defaultMatch[2]) {
    for (const spec of defaultMatch[2].split(",")) {
      const trimmed = spec.trim();
      if (!trimmed) {
        continue;
      }
      const parts = trimmed.split(AS_SPECIFIER_RE);
      const localName = (parts.length > 1 ? parts[1] : parts[0])?.trim();
      if (localName) {
        identifiers.push(localName);
      }
    }
  }
  return identifiers;
}

function parseImportLine(line: string): string[] {
  const match = line.match(IMPORT_LINE_RE);
  if (!match?.[1]) {
    return [];
  }

  const specStr = match[1];

  // Named: { a, b as c }
  if (NAMED_IMPORTS_RE.test(specStr)) {
    return parseNamedSpecifiers(specStr);
  }

  // Namespace: * as Foo
  const namespaceMatch = specStr.match(NAMESPACE_IMPORT_RE);
  if (namespaceMatch?.[1]) {
    return [namespaceMatch[1]];
  }

  // Default (with optional named): Foo, { bar }
  return parseDefaultAndNamedSpecifiers(specStr);
}

function isIdentifierUsed(name: string, strippedCode: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escapedName}\\b`, "g");
  const matches = strippedCode.match(regex);
  return matches !== null && matches.length > 0;
}

function removeUnusedImports(code: string): string {
  const lines = code.split("\n");
  const importLines: Map<number, string[]> = new Map();
  const allIdentifiers = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }

    const identifiers = parseImportLine(line);
    if (identifiers.length > 0) {
      importLines.set(i, identifiers);
      for (const id of identifiers) {
        allIdentifiers.add(id);
      }
    }
  }

  const codeWithoutImports = lines.filter((_, i) => !importLines.has(i)).join("\n");

  // Strip comments and string literals so identifiers inside them don't
  // count as "used" (avoids false positives that prevent import removal)
  const strippedCode = codeWithoutImports
    .replace(SINGLE_LINE_COMMENT_RE, "")
    .replace(MULTI_LINE_COMMENT_RE, "")
    .replace(STRING_LITERAL_RE, '""');

  const usedIdentifiers = new Set<string>();
  for (const name of allIdentifiers) {
    if (isIdentifierUsed(name, strippedCode)) {
      usedIdentifiers.add(name);
    }
  }

  for (const [index, identifiers] of importLines) {
    const usedFromThisLine = identifiers.filter((id) => usedIdentifiers.has(id));
    if (usedFromThisLine.length === 0) {
      lines[index] = "";
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main transform entry point
// ---------------------------------------------------------------------------

export function transformForReactRefresh(
  code: string,
  filename: string,
  moduleId: string,
  srcDir: string,
  pagesDir: string
): string {
  try {
    let extractedComponentName: string | null = null;

    // Pass 1: Extract component from page() call
    const extractResult = transformSync(code, {
      filename,
      presets: [[presetTypescript, { isTSX: true, allExtensions: true }]],
      plugins: [
        createExtractPlugin((name) => {
          extractedComponentName = name;
        }),
      ],
      sourceMaps: false,
    });

    if (!extractResult?.code) {
      throw new Error("Extract transform failed");
    }

    // Pass 2: Transform JSX and add React Refresh (TypeScript already stripped in Pass 1)
    const result = transformSync(extractResult.code, {
      filename,
      presets: [[presetReact, { runtime: "classic" }]],
      plugins: [[reactRefreshBabelPlugin, { skipEnvCheck: true }]],
      sourceMaps: "inline",
    });

    if (!result?.code) {
      throw new Error("JSX transform failed");
    }

    let transformedCode = result.code;

    // Add manual registration for extracted component
    if (extractedComponentName) {
      const functionEndPattern = new RegExp(`(_s\\(${extractedComponentName},[^;]+\\);?)`, "g");
      transformedCode = transformedCode.replace(functionEndPattern, (match: string) => {
        return `${match}\n$RefreshReg$(${extractedComponentName}, "${extractedComponentName}");`;
      });
    }

    // Strip React imports
    transformedCode = transformedCode.replace(
      /^import\s+(?:\*\s+as\s+)?React\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']react["'];?\s*$/gm,
      ""
    );
    transformedCode = transformedCode.replace(
      /^import\s+\{[^}]*\}\s*from\s*["']react["'];?\s*$/gm,
      ""
    );
    transformedCode = transformedCode.replace(
      /^import\s+(?:\*\s+as\s+)?React\s+from\s*["']react["'];?\s*$/gm,
      ""
    );

    // Strip elysion/client imports
    transformedCode = transformedCode.replace(
      /^import\s+\{[^}]*\}\s*from\s*["']elysion\/client["'];?\s*$/gm,
      ""
    );

    // Strip elysia imports (server-only)
    transformedCode = transformedCode.replace(
      /^import\s+\{[^}]*\}\s*from\s*["']elysia["'];?\s*$/gm,
      ""
    );

    // Strip CSS imports
    transformedCode = transformedCode.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, "");

    // Remove unused imports (after loader removal)
    transformedCode = removeUnusedImports(transformedCode);

    // Rewrite relative imports to /_modules/src/ absolute URLs so the browser
    // can fetch them through the HMR module server
    transformedCode = rewriteRelativeImports(transformedCode, filename, srcDir, pagesDir);

    // Strip import.meta.hot blocks (handles nested braces)
    transformedCode = stripImportMetaHotBlocks(transformedCode);

    const withGlobals = injectGlobals(transformedCode);
    return wrapWithHMR(withGlobals, moduleId);
  } catch (error) {
    console.error(`[hmr:transform] Error transforming ${filename}:`, error);
    throw error;
  }
}

function injectGlobals(code: string): string {
  const reactDecl = "const React = window.React;";
  const hooksDecl =
    "const { useState, useEffect, useCallback, useMemo, useRef, useContext, useReducer, useLayoutEffect, useImperativeHandle, useDebugValue, useDeferredValue, useTransition, useId, useSyncExternalStore, useInsertionEffect, createElement, Fragment } = window.React;";
  const elysionDecl = "const { createRoute } = window.__ELYSION__;";
  const elysiaStub = "const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });";

  return `${reactDecl}\n${hooksDecl}\n${elysionDecl}\n${elysiaStub}\n${code}`;
}

function stripImportMetaHotBlocks(code: string): string {
  let result = "";
  let lastIndex = 0;

  for (const match of code.matchAll(IMPORT_META_HOT_RE)) {
    const matchIndex = match.index;
    if (matchIndex === undefined) {
      continue;
    }

    result += code.slice(lastIndex, matchIndex);

    let depth = 1;
    const start = matchIndex + match[0].length;
    let end = start;

    for (let i = start; i < code.length; i++) {
      if (code[i] === "{") {
        depth++;
      } else if (code[i] === "}") {
        depth--;
      }
      if (depth === 0) {
        end = i;
        break;
      }
    }

    lastIndex = end + 1;
  }

  return result + code.slice(lastIndex);
}

function wrapWithHMR(code: string, moduleId: string): string {
  return `
// HMR Runtime Setup for ${moduleId}
const prevRefreshReg = window.$RefreshReg$;
const prevRefreshSig = window.$RefreshSig$;

// Use stable module ID from window.__CURRENT_MODULE__ (set before import)
const __hmrModuleId = window.__CURRENT_MODULE__ || ${JSON.stringify(moduleId)};

// Scoped refresh functions for this module
var $RefreshReg$ = (type, id) => {
  const fullId = __hmrModuleId + ' ' + id;
  if (window.__REFRESH_RUNTIME__) {
    window.__REFRESH_RUNTIME__.register(type, fullId);
  }
};

var $RefreshSig$ = window.__REFRESH_RUNTIME__
  ? window.__REFRESH_RUNTIME__.createSignatureFunctionForTransform
  : () => (type) => type;

${code}

window.$RefreshReg$ = prevRefreshReg;
window.$RefreshSig$ = prevRefreshSig;
`;
}
