import { transformSync } from "@babel/core";
import generate from "@babel/generator";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import {
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  isObjectProperty,
} from "@babel/types";

const presetTypescript = require.resolve("@babel/preset-typescript");

const SERVER_ONLY_PROPERTIES = ["loader"];

interface TransformResult {
  code: string;
  map: ReturnType<typeof generate>["map"] | null;
  removedServerCode: boolean;
}

function isCreateRouteCall(node: t.Node | null | undefined): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  return isIdentifier(node.callee, { name: "createRoute" });
}

function isRoutePageCall(node: t.Node | null | undefined): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  const callee = node.callee;
  if (isIdentifier(callee, { name: "page" })) {
    return true;
  }
  if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
    return true;
  }
  return false;
}

function findObjectProperty(obj: t.ObjectExpression, name: string): t.ObjectProperty | undefined {
  return obj.properties.find(
    (p): p is t.ObjectProperty => isObjectProperty(p) && isIdentifier(p.key, { name })
  );
}

function removeServerProperties(obj: t.ObjectExpression, properties: string[]): boolean {
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

function pruneImportDeclaration(
  node: t.ImportDeclaration,
  index: number,
  body: t.Statement[],
  programPath: NodePath<t.Program>
): void {
  const { specifiers } = node;
  if (!specifiers || specifiers.length === 0) {
    return;
  }

  const newSpecifiers = specifiers.filter((spec) => {
    const binding = programPath.scope.getBinding(spec.local.name);
    return binding?.referenced;
  });

  if (newSpecifiers.length === 0) {
    body.splice(index, 1);
  } else if (newSpecifiers.length !== specifiers.length) {
    node.specifiers = newSpecifiers;
  }
}

function deadCodeElimination(ast: t.File): void {
  traverse(ast, {
    Program(programPath) {
      const body = programPath.node.body;
      for (let i = body.length - 1; i >= 0; i--) {
        const node = body[i] as t.Statement;
        if (node.type === "ImportDeclaration") {
          pruneImportDeclaration(node, i, body, programPath);
        }
      }
    },
  });
}

function removeServerExports(ast: t.File): boolean {
  let removedServerCode = false;

  traverse(ast, {
    CallExpression(path) {
      const node = path.node;

      if (isRoutePageCall(node)) {
        const arg = node.arguments[0];
        if (isObjectExpression(arg) && removeServerProperties(arg, SERVER_ONLY_PROPERTIES)) {
          removedServerCode = true;
        }
      }

      if (isCreateRouteCall(node)) {
        const arg = node.arguments[0];
        if (isObjectExpression(arg) && removeServerProperties(arg, SERVER_ONLY_PROPERTIES)) {
          removedServerCode = true;
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;

      if (isCallExpression(decl) && (isRoutePageCall(decl) || isCreateRouteCall(decl))) {
        const arg = decl.arguments[0];
        if (isObjectExpression(arg) && removeServerProperties(arg, SERVER_ONLY_PROPERTIES)) {
          removedServerCode = true;
        }
      }
    },
  });

  return removedServerCode;
}

export function transformForClient(code: string, filename: string): TransformResult {
  const parseResult = transformSync(code, {
    filename,
    presets: [[presetTypescript, { isTSX: true, allExtensions: true }]],
    plugins: [],
    sourceMaps: false,
    ast: true,
    code: false,
  });

  if (!parseResult?.ast) {
    throw new Error(`Failed to parse ${filename}`);
  }

  const ast = parseResult.ast as t.File;

  const removedServerCode = removeServerExports(ast);

  if (removedServerCode) {
    traverse(ast, {
      Program(programPath) {
        programPath.scope.crawl();
      },
    });
    deadCodeElimination(ast);
  }

  const result = generate(ast, {
    sourceMaps: true,
    sourceFileName: filename,
  });

  return {
    code: result.code,
    map: result.map,
    removedServerCode,
  };
}
