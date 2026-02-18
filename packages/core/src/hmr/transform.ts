import type * as Babel from "@babel/core";
import { transformSync } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import {
  blockStatement,
  functionDeclaration,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isExportDefaultDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectExpression,
  isObjectProperty,
  isProgram,
  returnStatement,
} from "@babel/types";

const presetTypescript = require.resolve("@babel/preset-typescript");
const presetReact = require.resolve("@babel/preset-react");
const reactRefreshBabelPlugin = require.resolve("react-refresh/babel");

function isPageCallExpression(decl: Babel.types.Node): decl is Babel.types.CallExpression {
  if (!isCallExpression(decl)) {
    return false;
  }
  return isIdentifier(decl.callee, { name: "page" });
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
  const exportIndex = program.node.body.findIndex((node) => isExportDefaultDeclaration(node));
  if (exportIndex !== -1) {
    program.node.body.splice(exportIndex, 0, fn);
  }
}

function createExtractPlugin(onExtract: (name: string) => void): Babel.PluginObj {
  return {
    name: "extract-page-component",
    visitor: {
      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;

        if (!isPageCallExpression(decl)) {
          return;
        }

        const arg = decl.arguments[0];
        if (!isObjectExpression(arg)) {
          return;
        }

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
      },
    },
  };
}

export function transformForReactRefresh(code: string, filename: string, moduleId: string): string {
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

    // Pass 2: Transform JSX and add React Refresh
    const result = transformSync(extractResult.code, {
      filename,
      presets: [
        [presetTypescript, { isTSX: true, allExtensions: true }],
        [presetReact, { runtime: "classic" }],
      ],
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

    // Strip import.meta.hot blocks
    transformedCode = transformedCode.replace(/if\s*\(import\.meta\.hot\)\s*\{[^}]*\}/g, "");

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
