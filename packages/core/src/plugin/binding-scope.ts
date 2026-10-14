import { walk } from "yuku-ast";
import type { Program } from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";

export function fluentChain(call: AstNode, ancestors: AstNode[]): AstNode {
  let chain = call;
  for (const parent of ancestors.toReversed()) {
    if (parent === chain) {
      continue;
    }
    if (
      (parent.type === "MemberExpression" && parent.object === chain) ||
      (parent.type === "CallExpression" && parent.callee === chain) ||
      unwrapTSExpression(parent) === chain
    ) {
      chain = parent;
    } else {
      break;
    }
  }
  return unwrapTSExpression(chain);
}

export function lexicalBindingScope(ancestors: AstNode[]): AstNode | undefined {
  return ancestors.findLast((ancestor) =>
    [
      "Program",
      "BlockStatement",
      "SwitchStatement",
      "ForStatement",
      "ForInStatement",
      "ForOfStatement",
      "StaticBlock",
    ].includes(ancestor.type)
  );
}

export function varBindingScope(ancestors: AstNode[]): AstNode | undefined {
  return ancestors.findLast((ancestor, index) => {
    if (ancestor.type === "Program" || ancestor.type === "StaticBlock") {
      return true;
    }
    const parent = ancestors[index - 1];
    return (
      ancestor.type === "BlockStatement" &&
      !!parent &&
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type)
    );
  });
}

interface FactoryAlias {
  ancestors: AstNode[];
  immutable: boolean;
  initializer: AstNode;
  name: string;
  scope: AstNode;
}

/** Import identities stay module-local; aliases resolve at their lexical declaration. */
export class FactoryBindings extends Set<string> {
  private readonly aliases = new Map<string, FactoryAlias[]>();
  private readonly namespaces: Set<string>;

  constructor(program: Program, named: Set<string>, namespaces: Set<string>) {
    super(named);
    this.namespaces = namespaces;
    if (!this.hasImports) {
      return;
    }
    walk(program, {
      VariableDeclarator: (node, context) => {
        const ancestors = context.ancestors() as AstNode[];
        const declaration = ancestors.at(-1);
        const scope =
          declaration?.kind === "var" ? varBindingScope(ancestors) : lexicalBindingScope(ancestors);
        if (node.id.type === "Identifier" && node.init && scope) {
          const aliases = this.aliases.get(node.id.name) ?? [];
          aliases.push({
            ancestors,
            immutable: declaration?.kind === "const",
            initializer: node.init as AstNode,
            name: node.id.name,
            scope,
          });
          this.aliases.set(node.id.name, aliases);
        }
      },
    });
  }

  get hasImports(): boolean {
    return this.size > 0 || this.namespaces.size > 0;
  }

  factoryName(expression: AstNode, ancestors: AstNode[]): string | undefined {
    return this.size === 0 ? undefined : this.resolve(expression, ancestors, this, new Set());
  }

  namespaceName(expression: AstNode, ancestors: AstNode[]): string | undefined {
    return this.namespaces.size === 0
      ? undefined
      : this.resolve(expression, ancestors, this.namespaces, new Set());
  }

  private resolve(
    expression: AstNode,
    ancestors: AstNode[],
    imports: Set<string>,
    seen: Set<FactoryAlias>
  ): string | undefined {
    const node = unwrapTSExpression(expression);
    if (node.type !== "Identifier" || typeof node.name !== "string") {
      return undefined;
    }
    if (imports.has(node.name) && !hasShadowingDeclaration(node.name, ancestors)) {
      return node.name;
    }
    let match: FactoryAlias | undefined;
    let sameScope: FactoryAlias[] = [];
    let scopeIndex = -1;
    const aliases = this.aliases.get(node.name);
    if (!aliases) {
      return undefined;
    }
    for (const alias of aliases) {
      const index = ancestors.lastIndexOf(alias.scope);
      if (index > scopeIndex) {
        match = alias;
        scopeIndex = index;
        sameScope = [alias];
      } else if (index === scopeIndex && index >= 0) {
        sameScope.push(alias);
      }
    }
    if (
      !match ||
      seen.has(match) ||
      hasShadowingDeclaration(node.name, ancestors.slice(scopeIndex + 1))
    ) {
      return undefined;
    }
    if (sameScope.length > 1) {
      const factory = sameScope.some(
        (alias) =>
          !seen.has(alias) &&
          this.resolve(alias.initializer, alias.ancestors, imports, new Set([...seen, alias])) !==
            undefined
      );
      if (factory) {
        throw new Error("[furin] Route factory aliases are ambiguous in the same scope.");
      }
      return undefined;
    }
    seen.add(match);
    const name = this.resolve(match.initializer, match.ancestors, imports, seen);
    if (name && !match.immutable) {
      throw new Error("[furin] Route factory aliases must be immutable.");
    }
    return name;
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
      (scope.type === "StaticBlock" && functionBodyHasVarName(scope.body, name, true)) ||
      blockScopeHasName(scope, name) ||
      loopScopeHasName(scope, name) ||
      switchScopeHasName(scope, name)
  );
}
