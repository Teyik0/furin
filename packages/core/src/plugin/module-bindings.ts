import type {
  Expression,
  ImportDeclaration,
  ImportDeclarationSpecifier,
  Node,
  NodeOfType,
  Program,
} from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";

export type LocalDeclaration = NodeOfType<
  "ClassDeclaration" | "FunctionDeclaration" | "VariableDeclarator"
>;

export function importedName(specifier: ImportDeclarationSpecifier): string | null {
  if (specifier.type !== "ImportSpecifier") {
    return null;
  }
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

export function localName(specifier: ImportDeclarationSpecifier): string {
  return specifier.local.name;
}

export function unwrapped(node: Expression | null | undefined): Expression | null;
export function unwrapped(node: Node | null | undefined): Node | null;
export function unwrapped(node: Node | null | undefined): Node | null {
  return node ? unwrapTSExpression(node) : null;
}

function collectBindingNames(pattern: Node | null, names: string[]): void {
  const node = unwrapped(pattern);
  if (!node) {
    return;
  }
  if (node.type === "Identifier") {
    names.push(node.name);
    return;
  }
  if (node.type === "AssignmentPattern") {
    collectBindingNames(node.left, names);
    return;
  }
  if (node.type === "RestElement") {
    collectBindingNames(node.argument, names);
    return;
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) {
      collectBindingNames(element, names);
    }
    return;
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      collectBindingNames(property.type === "Property" ? property.value : property.argument, names);
    }
  }
}

function collectDeclarationBindings(
  declaration: Node | null,
  declarations: Map<string, LocalDeclaration>
): void {
  if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
    const identifier = unwrapped(declaration.id);
    if (identifier?.type === "Identifier") {
      declarations.set(identifier.name, declaration);
    }
    return;
  }
  if (declaration?.type !== "VariableDeclaration" || !Array.isArray(declaration.declarations)) {
    return;
  }
  for (const item of declaration.declarations) {
    const names: string[] = [];
    collectBindingNames(item.id, names);
    for (const name of names) {
      declarations.set(name, item);
    }
  }
}

export function collectModuleBindings(program: Program): {
  declarations: Map<string, LocalDeclaration>;
  imports: Map<string, ImportDeclaration>;
} {
  const declarations = new Map<string, LocalDeclaration>();
  const imports = new Map<string, ImportDeclaration>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && Array.isArray(statement.specifiers)) {
      for (const specifier of statement.specifiers) {
        const local = localName(specifier);
        if (local) {
          imports.set(local, statement);
        }
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? unwrapped(statement.declaration)
        : statement;
    collectDeclarationBindings(declaration, declarations);
  }
  return { declarations, imports };
}

function isBindingIdentifier(identifier: Node, pattern: Node | null): boolean {
  const node = unwrapped(pattern);
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.start === identifier.start && node.end === identifier.end;
  }
  if (node.type === "AssignmentPattern") {
    return isBindingIdentifier(identifier, node.left);
  }
  if (node.type === "RestElement") {
    return isBindingIdentifier(identifier, node.argument);
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    return node.elements.some((element) => isBindingIdentifier(identifier, element));
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    return node.properties.some((property) =>
      isBindingIdentifier(
        identifier,
        property.type === "Property" ? property.value : property.argument
      )
    );
  }
  return false;
}

function nodeContains(container: Node | Node[], node: Node): boolean {
  if (Array.isArray(container)) {
    return container.some((entry) => nodeContains(entry, node));
  }
  const containerNode = unwrapTSExpression(container);
  return containerNode.start <= node.start && node.end <= containerNode.end;
}

/** The children of a TypeScript node that remain runtime code. */
function typescriptRuntimeChildren(ancestor: Node): Array<Node | Node[]> | undefined {
  switch (ancestor.type) {
    case "TSAsExpression":
    case "TSInstantiationExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return [ancestor.expression];
    case "TSParameterProperty":
      return [ancestor.decorators, ancestor.parameter];
    default:
      return;
  }
}

function isTypePosition(node: Node, ancestors: Node[]): boolean {
  return ancestors.some((ancestor) => {
    if (!ancestor.type.startsWith("TS")) {
      return false;
    }
    const runtimeChildren = typescriptRuntimeChildren(ancestor);
    if (runtimeChildren) {
      return !runtimeChildren.some((child) => nodeContains(child, node));
    }
    return true;
  });
}

function isNonReferenceKey(node: Node, parent: Node | undefined): boolean {
  return Boolean(
    parent &&
      ((parent.type === "MemberExpression" &&
        parent.computed !== true &&
        parent.property === node) ||
        (parent.type === "Property" &&
          parent.computed !== true &&
          parent.shorthand !== true &&
          parent.key === node) ||
        ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
          parent.computed !== true &&
          parent.key === node) ||
        ((parent.type === "LabeledStatement" ||
          parent.type === "BreakStatement" ||
          parent.type === "ContinueStatement") &&
          parent.label === node))
  );
}

export function isReferenceIdentifier(node: Node, ancestors: Node[]): boolean {
  if (isTypePosition(node, ancestors) || isNonReferenceKey(node, ancestors.at(-1))) {
    return false;
  }
  for (const ancestor of ancestors) {
    if (
      (ancestor.type === "VariableDeclarator" && isBindingIdentifier(node, ancestor.id)) ||
      ((ancestor.type === "FunctionDeclaration" ||
        ancestor.type === "FunctionExpression" ||
        ancestor.type === "ArrowFunctionExpression") &&
        (isBindingIdentifier(node, ancestor.id) ||
          (Array.isArray(ancestor.params) &&
            ancestor.params.some((parameter) => isBindingIdentifier(node, parameter))))) ||
      (ancestor.type === "ClassDeclaration" && isBindingIdentifier(node, ancestor.id)) ||
      (ancestor.type === "CatchClause" && isBindingIdentifier(node, ancestor.param))
    ) {
      return false;
    }
  }
  return true;
}
