import type { Program } from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";

function moduleFactoryAliases(program: Program): Array<{ name: string; target: string }> {
  const aliases: Array<{ name: string; target: string }> = [];
  for (const statement of program.body) {
    const declaration = (statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement) as unknown as AstNode | null;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
      continue;
    }
    for (const declarator of declaration.declarations as AstNode[]) {
      const identifier = declarator.id as AstNode;
      const initializer = declarator.init
        ? unwrapTSExpression(declarator.init as AstNode)
        : undefined;
      if (
        identifier.type === "Identifier" &&
        typeof identifier.name === "string" &&
        initializer?.type === "Identifier" &&
        typeof initializer.name === "string"
      ) {
        aliases.push({ name: identifier.name, target: initializer.name });
      }
    }
  }
  return aliases;
}

/** Resolve module-local immutable aliases without confusing nested shadowed bindings. */
export function addFactoryAliases(program: Program, bindings: Set<string>): void {
  const aliases = moduleFactoryAliases(program);
  for (;;) {
    const { size } = bindings;
    for (const alias of aliases) {
      if (bindings.has(alias.target)) {
        bindings.add(alias.name);
      }
    }
    if (bindings.size === size) {
      return;
    }
  }
}

function bindingPatternHasName(pattern: unknown, name: string): boolean {
  if (!(pattern && typeof pattern === "object")) {
    return false;
  }
  const node = pattern as AstNode;
  if (node.type === "Identifier") {
    return node.name === name;
  }
  if (node.type === "AssignmentPattern") {
    return bindingPatternHasName(node.left, name);
  }
  if (node.type === "RestElement") {
    return bindingPatternHasName(node.argument, name);
  }
  if (node.type === "ArrayPattern") {
    return (
      Array.isArray(node.elements) &&
      node.elements.some((element) => bindingPatternHasName(element, name))
    );
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        if (!(property && typeof property === "object")) {
          return false;
        }
        const propertyNode = property as AstNode;
        return bindingPatternHasName(
          propertyNode.type === "Property" ? propertyNode.value : propertyNode.argument,
          name
        );
      })
    );
  }
  if (node.type === "TSParameterProperty") {
    return bindingPatternHasName(node.parameter, name);
  }
  return false;
}

function declarationHasName(node: AstNode, name: string): boolean {
  if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
    return node.declarations.some((declaration) =>
      declaration && typeof declaration === "object"
        ? bindingPatternHasName((declaration as AstNode).id, name)
        : false
    );
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return bindingPatternHasName(node.id, name);
  }
  return false;
}

function functionBodyHasVarName(value: unknown, name: string, root: boolean): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => functionBodyHasVarName(entry, name, false));
  }
  const node = value as AstNode;
  if (
    !root &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "StaticBlock")
  ) {
    return false;
  }
  if (
    node.type === "VariableDeclaration" &&
    node.kind === "var" &&
    Array.isArray(node.declarations) &&
    node.declarations.some((declaration) =>
      declaration && typeof declaration === "object"
        ? bindingPatternHasName((declaration as AstNode).id, name)
        : false
    )
  ) {
    return true;
  }
  return Object.values(node).some((entry) => functionBodyHasVarName(entry, name, false));
}

function functionScopeHasName(scope: AstNode, name: string): boolean {
  if (
    scope.type !== "FunctionDeclaration" &&
    scope.type !== "FunctionExpression" &&
    scope.type !== "ArrowFunctionExpression"
  ) {
    return false;
  }
  return (
    (Array.isArray(scope.params) &&
      scope.params.some((parameter) => bindingPatternHasName(parameter, name))) ||
    (scope.type === "FunctionExpression" && bindingPatternHasName(scope.id, name)) ||
    functionBodyHasVarName(scope.body, name, true)
  );
}

function blockScopeHasName(scope: AstNode, name: string): boolean {
  return (
    (scope.type === "BlockStatement" || scope.type === "StaticBlock") &&
    Array.isArray(scope.body) &&
    scope.body.some((statement) =>
      statement && typeof statement === "object"
        ? declarationHasName(statement as AstNode, name)
        : false
    )
  );
}

function loopScopeHasName(scope: AstNode, name: string): boolean {
  const declaration = scope.type === "ForStatement" ? scope.init : scope.left;
  return (
    (scope.type === "ForStatement" ||
      scope.type === "ForInStatement" ||
      scope.type === "ForOfStatement") &&
    !!declaration &&
    typeof declaration === "object" &&
    declarationHasName(declaration as AstNode, name)
  );
}

function switchScopeHasName(scope: AstNode, name: string): boolean {
  return (
    scope.type === "SwitchStatement" &&
    Array.isArray(scope.cases) &&
    scope.cases.some(
      (switchCase) =>
        switchCase &&
        typeof switchCase === "object" &&
        Array.isArray((switchCase as AstNode).consequent) &&
        ((switchCase as AstNode).consequent as unknown[]).some(
          (statement) =>
            statement &&
            typeof statement === "object" &&
            declarationHasName(statement as AstNode, name)
        )
    )
  );
}

export function hasShadowingDeclaration(name: string, ancestors: AstNode[]): boolean {
  return ancestors.some(
    (scope) =>
      functionScopeHasName(scope, name) ||
      (scope.type === "ClassExpression" && bindingPatternHasName(scope.id, name)) ||
      (scope.type === "CatchClause" && bindingPatternHasName(scope.param, name)) ||
      blockScopeHasName(scope, name) ||
      loopScopeHasName(scope, name) ||
      switchScopeHasName(scope, name)
  );
}
