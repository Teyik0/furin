import { walk } from "yuku-ast";
import type { Expression, Node, Program } from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";
import { isNode } from "../shared/utils/ast-walk.ts";

export function fluentChain(call: Node, ancestors: Node[]): Node {
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

export function lexicalBindingScope(ancestors: Node[]): Node | undefined {
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

export function varBindingScope(ancestors: Node[]): Node | undefined {
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
  ancestors: Node[];
  immutable: boolean;
  initializer: Expression;
  name: string;
  scope: Node;
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
        const ancestors = context.ancestors();
        const declaration = ancestors.at(-1);
        const kind = declaration?.type === "VariableDeclaration" ? declaration.kind : undefined;
        const scope = kind === "var" ? varBindingScope(ancestors) : lexicalBindingScope(ancestors);
        if (node.id.type === "Identifier" && node.init && scope) {
          const aliases = this.aliases.get(node.id.name) ?? [];
          aliases.push({
            ancestors,
            immutable: kind === "const",
            initializer: node.init,
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

  factoryName(expression: Node, ancestors: Node[]): string | undefined {
    return this.size === 0 ? undefined : this.resolve(expression, ancestors, this, new Set());
  }

  namespaceName(expression: Node, ancestors: Node[]): string | undefined {
    return this.namespaces.size === 0
      ? undefined
      : this.resolve(expression, ancestors, this.namespaces, new Set());
  }

  private resolve(
    expression: Node,
    ancestors: Node[],
    imports: Set<string>,
    seen: Set<FactoryAlias>
  ): string | undefined {
    const node = unwrapTSExpression(expression);
    if (node.type !== "Identifier") {
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

function bindingPatternHasName(pattern: Node | null, name: string): boolean {
  if (!pattern) {
    return false;
  }
  if (pattern.type === "Identifier") {
    return pattern.name === name;
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingPatternHasName(pattern.left, name);
  }
  if (pattern.type === "RestElement") {
    return bindingPatternHasName(pattern.argument, name);
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.some((element) => bindingPatternHasName(element, name));
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      bindingPatternHasName(property.type === "Property" ? property.value : property.argument, name)
    );
  }
  if (pattern.type === "TSParameterProperty") {
    return bindingPatternHasName(pattern.parameter, name);
  }
  return false;
}

function declarationHasName(node: Node, name: string): boolean {
  if (node.type === "VariableDeclaration") {
    return node.declarations.some((declaration) => bindingPatternHasName(declaration.id, name));
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return bindingPatternHasName(node.id, name);
  }
  return false;
}

const NESTED_VAR_SCOPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "StaticBlock",
]);

function functionBodyHasVarName(value: unknown, name: string, root: boolean): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => functionBodyHasVarName(entry, name, false));
  }
  if (isNode(value)) {
    if (!root && NESTED_VAR_SCOPES.has(value.type)) {
      return false;
    }
    if (
      value.type === "VariableDeclaration" &&
      value.kind === "var" &&
      value.declarations.some((declaration) => bindingPatternHasName(declaration.id, name))
    ) {
      return true;
    }
  }
  return Object.values(value).some((entry) => functionBodyHasVarName(entry, name, false));
}

function functionScopeHasName(scope: Node, name: string): boolean {
  if (
    scope.type !== "FunctionDeclaration" &&
    scope.type !== "FunctionExpression" &&
    scope.type !== "ArrowFunctionExpression"
  ) {
    return false;
  }
  return (
    scope.params.some((parameter) => bindingPatternHasName(parameter, name)) ||
    (scope.type === "FunctionExpression" && bindingPatternHasName(scope.id, name)) ||
    functionBodyHasVarName(scope.body, name, true)
  );
}

function blockScopeHasName(scope: Node, name: string): boolean {
  return (
    (scope.type === "BlockStatement" || scope.type === "StaticBlock") &&
    scope.body.some((statement) => declarationHasName(statement, name))
  );
}

function loopScopeHasName(scope: Node, name: string): boolean {
  if (scope.type === "ForStatement") {
    return !!scope.init && declarationHasName(scope.init, name);
  }
  if (scope.type === "ForInStatement" || scope.type === "ForOfStatement") {
    return declarationHasName(scope.left, name);
  }
  return false;
}

function switchScopeHasName(scope: Node, name: string): boolean {
  return (
    scope.type === "SwitchStatement" &&
    scope.cases.some((switchCase) =>
      switchCase.consequent.some((statement) => declarationHasName(statement, name))
    )
  );
}

export function hasShadowingDeclaration(name: string, ancestors: Node[]): boolean {
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
