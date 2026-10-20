import { walk } from "yuku-ast";
import type { CallExpression, Node, Program } from "yuku-parser";
import { importedName, localName, unwrapped } from "./module-bindings.ts";

const REACT_COMPONENT_WRAPPERS = new Set(["forwardRef", "memo"]);
const REACT_HOOK_NAME_RE = /^use[A-Z0-9]/;

function calledHookName(call: CallExpression): string | null {
  const callee = unwrapped(call.callee);
  if (callee?.type === "Identifier") {
    return REACT_HOOK_NAME_RE.test(callee.name) ? callee.name : null;
  }
  if (callee?.type === "MemberExpression" && callee.computed !== true) {
    const { property } = callee;
    if (property.type === "Identifier" && REACT_HOOK_NAME_RE.test(property.name)) {
      return property.name;
    }
  }
  return null;
}

function namedFunction(declaration: Node, name: string): Node | null {
  if (declaration.type === "FunctionDeclaration") {
    const identifier = unwrapped(declaration.id);
    return identifier?.type === "Identifier" && identifier.name === name ? declaration : null;
  }
  if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
    for (const item of declaration.declarations) {
      const identifier = unwrapped(item.id);
      const initializer = unwrapped(item.init);
      if (
        identifier?.type === "Identifier" &&
        identifier.name === name &&
        (initializer?.type === "ArrowFunctionExpression" ||
          initializer?.type === "FunctionExpression")
      ) {
        return initializer;
      }
    }
  }
  return null;
}

function localFunction(program: Program, name: string): Node | null {
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? unwrapped(statement.declaration)
        : statement;
    const component = declaration ? namedFunction(declaration, name) : null;
    if (component) {
      return component;
    }
  }
  return null;
}

interface ImportedRouteComponent {
  end: number;
  expression: string;
  start: number;
}

function isImportedBinding(program: Program, name: string): boolean {
  return program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type" &&
      statement.specifiers.some(
        (specifier) =>
          !(specifier.type === "ImportSpecifier" && specifier.importKind === "type") &&
          localName(specifier) === name
      )
  );
}

interface ReactWrapperBindings {
  members: Set<string>;
  namespaces: Set<string>;
}

function collectReactWrapperBindings(program: Program): ReactWrapperBindings {
  const bindings: ReactWrapperBindings = {
    members: new Set<string>(),
    namespaces: new Set<string>(),
  };
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "react") {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = localName(specifier);
      if (!local || (specifier.type === "ImportSpecifier" && specifier.importKind === "type")) {
        continue;
      }
      const imported = importedName(specifier);
      if (
        specifier.type === "ImportSpecifier" &&
        imported &&
        REACT_COMPONENT_WRAPPERS.has(imported)
      ) {
        bindings.members.add(local);
      } else if (
        specifier.type === "ImportDefaultSpecifier" ||
        specifier.type === "ImportNamespaceSpecifier" ||
        (specifier.type === "ImportSpecifier" && imported === "default")
      ) {
        bindings.namespaces.add(local);
      }
    }
  }
  return bindings;
}

function wrappedComponentFunction(
  program: Program,
  expression: Node,
  bindings: ReactWrapperBindings
): Node | null {
  if (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") {
    return expression;
  }
  if (expression.type === "Identifier") {
    return localFunction(program, expression.name);
  }
  if (expression.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapped(expression.callee);
  const isNamedWrapper = callee?.type === "Identifier" && bindings.members.has(callee.name);
  const object = callee?.type === "MemberExpression" ? unwrapped(callee.object) : null;
  const property = callee?.type === "MemberExpression" ? unwrapped(callee.property) : null;
  const isNamespaceWrapper =
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    object?.type === "Identifier" &&
    bindings.namespaces.has(object.name) &&
    property?.type === "Identifier" &&
    REACT_COMPONENT_WRAPPERS.has(property.name);
  if (!(isNamedWrapper || isNamespaceWrapper)) {
    return null;
  }
  const args = expression.arguments;
  const wrapped = Array.isArray(args) ? unwrapped(args[0]) : null;
  return wrapped ? wrappedComponentFunction(program, wrapped, bindings) : null;
}

function importedMemberBinding(program: Program, expression: Node): string | null {
  let object = expression.type === "MemberExpression" ? unwrapped(expression.object) : null;
  while (object?.type === "MemberExpression") {
    object = unwrapped(object.object);
  }
  return object?.type === "Identifier" && isImportedBinding(program, object.name)
    ? object.name
    : null;
}

function sourceText(code: string, node: Node | null): string {
  return node ? code.slice(node.start, node.end) : "";
}

export function unusedIdentifier(program: Program, preferred: string): string {
  const identifiers = new Set<string>();
  walk(program, {
    Identifier(node) {
      identifiers.add(node.name);
    },
  });
  if (!identifiers.has(preferred)) {
    return preferred;
  }
  let suffix = 1;
  while (identifiers.has(`${preferred}_${suffix}`)) {
    suffix += 1;
  }
  return `${preferred}_${suffix}`;
}

function hookCallsiteSignature(
  code: string,
  call: CallExpression,
  hookName: string,
  parent: Node | null
): string {
  let key = parent?.type === "VariableDeclarator" ? sourceText(code, unwrapped(parent.id)) : "";
  const args = call.arguments;
  const stateArgument = Array.isArray(args) ? unwrapped(args[0]) : null;
  const reducerArgument = Array.isArray(args) ? unwrapped(args[1]) : null;
  if (hookName === "useState" && stateArgument) {
    key += `(${sourceText(code, stateArgument)})`;
  } else if (hookName === "useReducer" && reducerArgument) {
    key += `(${sourceText(code, reducerArgument)})`;
  }
  return `${hookName}{${key}}`;
}

function collectFunctionHookSignature(code: string, component: Node): string[] {
  const hooks: string[] = [];
  walk(component, {
    CallExpression(call, context) {
      const name = calledHookName(call);
      if (name) {
        hooks.push(hookCallsiteSignature(code, call, name, unwrapped(context.parent)));
      }
    },
    Function(node, context) {
      if (node !== component) {
        context.skip();
      }
    },
  });
  return hooks;
}

export function collectClientHookSignature(
  code: string,
  program: Program,
  componentExpression: Node | null
): string[] | ImportedRouteComponent | "external" | null {
  if (!componentExpression) {
    return null;
  }
  const wrappedComponent = wrappedComponentFunction(
    program,
    componentExpression,
    collectReactWrapperBindings(program)
  );
  if (wrappedComponent) {
    return collectFunctionHookSignature(code, wrappedComponent);
  }
  if (componentExpression.type !== "Identifier") {
    if (importedMemberBinding(program, componentExpression)) {
      return {
        end: componentExpression.end,
        expression: sourceText(code, componentExpression),
        start: componentExpression.start,
      };
    }
    return collectFunctionHookSignature(code, componentExpression);
  }
  const component = localFunction(program, componentExpression.name);
  if (component) {
    return collectFunctionHookSignature(code, component);
  }
  return isImportedBinding(program, componentExpression.name)
    ? {
        end: componentExpression.end,
        expression: componentExpression.name,
        start: componentExpression.start,
      }
    : "external";
}
