import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { ImportDeclaration, Program } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";
import { transformIsomorphicFunctions } from "./transform-isomorphic.ts";

const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);
const FURIN_SERVER_MODULES = new Set(["@teyik0/furin", "furin"]);
const REACT_COMPONENT_WRAPPERS = new Set(["forwardRef", "memo"]);
const SERVER_ONLY_METHODS = new Set(["config", "head", "loader", "requestLoader", "staticParams"]);
const REACT_HOOK_NAME_RE = /^use[A-Z0-9]/;
const HMR_DATA_SIGNATURE = "furin.hmr.data-signature";
const TYPESCRIPT_EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  removedServerCode: boolean;
}

function isFurinRouteModule(source: unknown): source is string {
  return (
    typeof source === "string" &&
    (FURIN_SERVER_MODULES.has(source) || FURIN_CLIENT_MODULES.has(source))
  );
}

function importedName(specifier: AstNode): string | null {
  const { imported } = specifier;
  if (!imported || typeof imported !== "object") {
    return null;
  }
  const node = imported as AstNode;
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function localName(specifier: AstNode): string | null {
  const { local } = specifier;
  if (!local || typeof local !== "object") {
    return null;
  }
  const node = local as AstNode;
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function collectDefineRouteBindings(program: Program): Set<string> {
  const bindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    if (declaration.importKind === "type") {
      continue;
    }
    const source = declaration.source.value;
    if (!isFurinRouteModule(source)) {
      continue;
    }
    for (const specifier of declaration.specifiers as unknown as AstNode[]) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") {
        continue;
      }
      const imported = importedName(specifier);
      if (imported !== "defineRoute" && imported !== "defineRootRoute") {
        continue;
      }
      const local = localName(specifier);
      if (local) {
        bindings.add(local);
      }
    }
  }
  return bindings;
}

function rewriteClientImports(
  source: MagicString,
  program: Program,
  bindings: Set<string>
): boolean {
  let rewritten = false;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    const moduleName = declaration.source.value;
    if (typeof moduleName !== "string" || !FURIN_SERVER_MODULES.has(moduleName)) {
      continue;
    }
    const importsClientValue = (declaration.specifiers as unknown as AstNode[]).some(
      (specifier) => {
        const local = localName(specifier);
        const imported = importedName(specifier);
        return (
          (local !== null && bindings.has(local)) ||
          imported === "HeadContent" ||
          imported === "Scripts"
        );
      }
    );
    if (!importsClientValue) {
      continue;
    }
    const clientModule = moduleName === "furin" ? "furin/client" : "@teyik0/furin/client";
    source.update(declaration.source.start + 1, declaration.source.end - 1, clientModule);
    rewritten = true;
  }
  return rewritten;
}

function asAstNode(node: unknown): AstNode | null {
  if (!node || typeof node !== "object" || !("type" in node)) {
    return null;
  }
  return unwrapTSExpression(node as { type: string }) as AstNode;
}

function chainRootIsDefineRoute(
  node: unknown,
  bindings: Set<string>,
  ancestors: AstNode[]
): boolean {
  let current = asAstNode(node);
  while (current) {
    if (current.type === "MemberExpression") {
      current = asAstNode(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      current = asAstNode(current.callee);
      continue;
    }
    return (
      current.type === "Identifier" &&
      typeof current.name === "string" &&
      bindings.has(current.name) &&
      !hasShadowingDeclaration(current.name, ancestors)
    );
  }
  return false;
}

function removeChainedServerCalls(
  source: MagicString,
  program: Program,
  bindings: Set<string>
): boolean {
  let transformed = rewriteClientImports(source, program, bindings);

  walk(program, {
    CallExpression(call, context) {
      const callee = asAstNode(call.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed === true ||
        !callee.property ||
        typeof callee.property !== "object"
      ) {
        return;
      }
      const property = callee.property as AstNode;
      if (
        property.type !== "Identifier" ||
        typeof property.name !== "string" ||
        !SERVER_ONLY_METHODS.has(property.name) ||
        !chainRootIsDefineRoute(callee.object, bindings, context.ancestors() as AstNode[])
      ) {
        return;
      }
      const object = asAstNode(callee.object);
      if (!object) {
        return;
      }
      source.remove(object.end, call.end);
      transformed = true;
    },
  });
  return transformed;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
  const node = asAstNode(pattern);
  if (!node) {
    return;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
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
      const propertyNode = asAstNode(property);
      collectBindingNames(
        propertyNode?.type === "Property" ? propertyNode.value : propertyNode?.argument,
        names
      );
    }
  }
}

function collectDeclarationBindings(
  declaration: AstNode | null,
  declarations: Map<string, AstNode>
): void {
  if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
    const identifier = asAstNode(declaration.id);
    if (identifier?.type === "Identifier" && typeof identifier.name === "string") {
      declarations.set(identifier.name, declaration);
    }
    return;
  }
  if (declaration?.type !== "VariableDeclaration" || !Array.isArray(declaration.declarations)) {
    return;
  }
  for (const item of declaration.declarations as AstNode[]) {
    const names: string[] = [];
    collectBindingNames(item.id, names);
    for (const name of names) {
      declarations.set(name, item);
    }
  }
}

function collectModuleBindings(program: Program): {
  declarations: Map<string, AstNode>;
  imports: Set<string>;
} {
  const declarations = new Map<string, AstNode>();
  const imports = new Set<string>();
  for (const statement of program.body as unknown as AstNode[]) {
    if (statement.type === "ImportDeclaration" && Array.isArray(statement.specifiers)) {
      for (const specifier of statement.specifiers as AstNode[]) {
        const local = localName(specifier);
        if (local) {
          imports.add(local);
        }
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? asAstNode(statement.declaration)
        : statement;
    collectDeclarationBindings(declaration, declarations);
  }
  return { declarations, imports };
}

function isBindingIdentifier(identifier: AstNode, pattern: unknown): boolean {
  const node = asAstNode(pattern);
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
    return node.properties.some((property) => {
      const propertyNode = asAstNode(property);
      return isBindingIdentifier(
        identifier,
        propertyNode?.type === "Property" ? propertyNode.value : propertyNode?.argument
      );
    });
  }
  return false;
}

function nodeContains(container: unknown, node: AstNode): boolean {
  const containerNode = asAstNode(container);
  return Boolean(
    containerNode && containerNode.start <= node.start && node.end <= containerNode.end
  );
}

function isTypePosition(node: AstNode, ancestors: AstNode[]): boolean {
  return ancestors.some((ancestor) => {
    if (!ancestor.type.startsWith("TS")) {
      return false;
    }
    if (TYPESCRIPT_EXPRESSION_WRAPPERS.has(ancestor.type)) {
      return !nodeContains(ancestor.expression, node);
    }
    return true;
  });
}

function isNonReferenceKey(node: AstNode, parent: AstNode | undefined): boolean {
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

function isReferenceIdentifier(node: AstNode, ancestors: AstNode[]): boolean {
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

function walkWithAncestors(
  value: unknown,
  ancestors: AstNode[],
  visitor: (node: AstNode, ancestors: AstNode[]) => void
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkWithAncestors(entry, ancestors, visitor);
    }
    return;
  }
  const node = asAstNode(value);
  if (!node) {
    return;
  }
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type" && key !== "start" && key !== "end" && key !== "comments") {
      walkWithAncestors(child, nextAncestors, visitor);
    }
  }
}

interface HmrDependencyState {
  dependencies: Map<number, AstNode>;
  hasUnresolvedImport: boolean;
  importTrackedDependencies: Set<number>;
  moduleBindings: ReturnType<typeof collectModuleBindings>;
}

function collectDependencyIdentifier(
  child: AstNode,
  ancestors: AstNode[],
  trackImports: boolean,
  state: HmrDependencyState
): void {
  if (
    child.type !== "Identifier" ||
    typeof child.name !== "string" ||
    !isReferenceIdentifier(child, ancestors) ||
    hasShadowingDeclaration(child.name, ancestors)
  ) {
    return;
  }
  const declaration = state.moduleBindings.declarations.get(child.name);
  if (!declaration) {
    if (trackImports && state.moduleBindings.imports.has(child.name)) {
      state.hasUnresolvedImport = true;
    }
    return;
  }
  const alreadyTracked = state.dependencies.has(declaration.start);
  if (!alreadyTracked) {
    state.dependencies.set(declaration.start, declaration);
  }
  if (trackImports) {
    if (state.importTrackedDependencies.has(declaration.start)) {
      return;
    }
    state.importTrackedDependencies.add(declaration.start);
  } else if (alreadyTracked) {
    return;
  }
  collectDependencies(declaration, trackImports, state);
}

function collectDependencies(
  node: AstNode,
  trackImports: boolean,
  state: HmrDependencyState
): void {
  walkWithAncestors(node, [], (child, ancestors) => {
    collectDependencyIdentifier(child, ancestors, trackImports, state);
  });
}

function createHmrDataSignature(code: string, program: Program, bindings: Set<string>): string {
  const serverStages: Array<{ source: string; start: number }> = [];
  const dependencyState: HmrDependencyState = {
    dependencies: new Map(),
    hasUnresolvedImport: false,
    importTrackedDependencies: new Set(),
    moduleBindings: collectModuleBindings(program),
  };

  walk(program, {
    CallExpression(call, context) {
      const callee = asAstNode(call.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed === true ||
        !callee.property ||
        typeof callee.property !== "object"
      ) {
        return;
      }
      const property = callee.property as AstNode;
      if (
        property.type !== "Identifier" ||
        typeof property.name !== "string" ||
        !SERVER_ONLY_METHODS.has(property.name) ||
        !chainRootIsDefineRoute(callee.object, bindings, context.ancestors() as AstNode[])
      ) {
        return;
      }
      const object = asAstNode(callee.object);
      if (!object) {
        return;
      }
      serverStages.push({
        source: code.slice(object.end, call.end),
        start: call.start,
      });
      if (Array.isArray(call.arguments)) {
        for (const argument of call.arguments) {
          const argumentNode = asAstNode(argument);
          if (argumentNode) {
            collectDependencies(argumentNode, property.name !== "config", dependencyState);
          }
        }
      }
    },
  });

  const dataSource = [
    ...serverStages,
    ...[...dependencyState.dependencies.values()].map((dependency) => ({
      source: code.slice(dependency.start, dependency.end),
      start: dependency.start,
    })),
  ]
    .sort((left, right) => left.start - right.start)
    .map((entry) => entry.source)
    .join("\n");
  const hash = new Bun.CryptoHasher("sha256").update(dataSource).digest("hex");
  return dependencyState.hasUnresolvedImport ? `external:${hash}` : hash;
}

function calledHookName(call: AstNode): string | null {
  const callee = asAstNode(call.callee);
  if (callee?.type === "Identifier" && typeof callee.name === "string") {
    return REACT_HOOK_NAME_RE.test(callee.name) ? callee.name : null;
  }
  if (
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    callee.property &&
    typeof callee.property === "object"
  ) {
    const property = callee.property as AstNode;
    if (
      property.type === "Identifier" &&
      typeof property.name === "string" &&
      REACT_HOOK_NAME_RE.test(property.name)
    ) {
      return property.name;
    }
  }
  return null;
}

function routeComponentExpression(program: Program, bindings: Set<string>): AstNode | null {
  let component: AstNode | null = null;
  walk(program, {
    CallExpression(call, context) {
      const callee = asAstNode(call.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed === true ||
        !callee.property ||
        typeof callee.property !== "object"
      ) {
        return;
      }
      const property = callee.property as AstNode;
      const ancestors = context.ancestors() as AstNode[];
      const routeDeclarator = ancestors.find((ancestor) => {
        if (ancestor.type !== "VariableDeclarator") {
          return false;
        }
        const identifier = asAstNode(ancestor.id);
        return identifier?.type === "Identifier" && identifier.name === "route";
      });
      if (
        !(
          routeDeclarator &&
          ancestors.some((ancestor) => ancestor.type === "ExportNamedDeclaration")
        ) ||
        property.type !== "Identifier" ||
        (property.name !== "page" && property.name !== "layout") ||
        !chainRootIsDefineRoute(callee.object, bindings, ancestors)
      ) {
        return;
      }
      const args = call.arguments;
      component = Array.isArray(args) ? asAstNode(args[0]) : null;
      context.stop();
    },
  });
  return component;
}

function namedFunction(declaration: AstNode, name: string): AstNode | null {
  if (declaration.type === "FunctionDeclaration") {
    const identifier = asAstNode(declaration.id);
    return identifier?.type === "Identifier" && identifier.name === name ? declaration : null;
  }
  if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
    for (const item of declaration.declarations as AstNode[]) {
      const identifier = asAstNode(item.id);
      const initializer = asAstNode(item.init);
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

function localFunction(program: Program, name: string): AstNode | null {
  for (const statement of program.body as unknown as AstNode[]) {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? asAstNode(statement.declaration)
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
      (statement.specifiers as unknown as AstNode[]).some(
        (specifier) => specifier.importKind !== "type" && localName(specifier) === name
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
    for (const specifier of statement.specifiers as unknown as AstNode[]) {
      const local = localName(specifier);
      if (!local || specifier.importKind === "type") {
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
  expression: AstNode,
  bindings: ReactWrapperBindings
): AstNode | null {
  if (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") {
    return expression;
  }
  if (expression.type === "Identifier" && typeof expression.name === "string") {
    return localFunction(program, expression.name);
  }
  if (expression.type !== "CallExpression") {
    return null;
  }
  const callee = asAstNode(expression.callee);
  const isNamedWrapper =
    callee?.type === "Identifier" &&
    typeof callee.name === "string" &&
    bindings.members.has(callee.name);
  const object = callee?.type === "MemberExpression" ? asAstNode(callee.object) : null;
  const property = callee?.type === "MemberExpression" ? asAstNode(callee.property) : null;
  const isNamespaceWrapper =
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    object?.type === "Identifier" &&
    typeof object.name === "string" &&
    bindings.namespaces.has(object.name) &&
    property?.type === "Identifier" &&
    typeof property.name === "string" &&
    REACT_COMPONENT_WRAPPERS.has(property.name);
  if (!(isNamedWrapper || isNamespaceWrapper)) {
    return null;
  }
  const args = expression.arguments;
  const wrapped = Array.isArray(args) ? asAstNode(args[0]) : null;
  return wrapped ? wrappedComponentFunction(program, wrapped, bindings) : null;
}

function importedMemberBinding(program: Program, expression: AstNode): string | null {
  let object = expression.type === "MemberExpression" ? asAstNode(expression.object) : null;
  while (object?.type === "MemberExpression") {
    object = asAstNode(object.object);
  }
  return object?.type === "Identifier" &&
    typeof object.name === "string" &&
    isImportedBinding(program, object.name)
    ? object.name
    : null;
}

function sourceText(code: string, node: AstNode | null): string {
  return node ? code.slice(node.start, node.end) : "";
}

function unusedIdentifier(program: Program, preferred: string): string {
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
  call: AstNode,
  hookName: string,
  parent: AstNode | null
): string {
  let key = parent?.type === "VariableDeclarator" ? sourceText(code, asAstNode(parent.id)) : "";
  const args = call.arguments;
  const stateArgument = Array.isArray(args) ? asAstNode(args[0]) : null;
  const reducerArgument = Array.isArray(args) ? asAstNode(args[1]) : null;
  if (hookName === "useState" && stateArgument) {
    key += `(${sourceText(code, stateArgument)})`;
  } else if (hookName === "useReducer" && reducerArgument) {
    key += `(${sourceText(code, reducerArgument)})`;
  }
  return `${hookName}{${key}}`;
}

function collectFunctionHookSignature(code: string, component: AstNode): string[] {
  const hooks: string[] = [];
  walk(component as never, {
    CallExpression(call, context) {
      const callNode = call as unknown as AstNode;
      const name = calledHookName(callNode);
      if (name) {
        hooks.push(
          hookCallsiteSignature(code, callNode, name, asAstNode(context.parent as unknown))
        );
      }
    },
    Function(node, context) {
      if ((node as unknown as AstNode) !== component) {
        context.skip();
      }
    },
  });
  return hooks;
}

function collectClientHookSignature(
  code: string,
  filename: string
): string[] | ImportedRouteComponent | "external" | null {
  const lang = detectLangFromPath(filename);
  const { program } = parseSource(code, lang);
  const componentExpression = routeComponentExpression(
    program,
    collectDefineRouteBindings(program)
  );
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
  if (componentExpression.type !== "Identifier" || typeof componentExpression.name !== "string") {
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

export function transformForClient(code: string, filename: string): TransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code, map: null, removedServerCode: false };
  }

  const isomorphicResult = transformIsomorphicFunctions(code, filename, "client");
  const clientSource = isomorphicResult.code;
  const { diagnostics, program } = parseSource(clientSource, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  let source = new MagicString(clientSource);
  const routeBindings = collectDefineRouteBindings(program);
  const removedRouteCode = removeChainedServerCalls(source, program, routeBindings);
  const removedServerCode = isomorphicResult.transformed || removedRouteCode;
  if (removedServerCode) {
    source = deadCodeElimination(source, code, lang);
  }
  const transformedCode = source.toString();
  let hookSignature =
    routeBindings.size > 0 ? collectClientHookSignature(transformedCode, filename) : null;
  if (hookSignature && typeof hookSignature === "object" && !Array.isArray(hookSignature)) {
    const createElementBinding = unusedIdentifier(program, "__furinCreateElement");
    source = new MagicString(transformedCode);
    source.prepend(`import { createElement as ${createElementBinding} } from "react";\n`);
    source.update(
      hookSignature.start,
      hookSignature.end,
      `(import.meta.hot ? (props) => ${createElementBinding}(${hookSignature.expression}, props) : ${hookSignature.expression})`
    );
    hookSignature = [];
  }
  if (routeBindings.size > 0 && hookSignature !== null) {
    const originalParse = parseSource(code, lang);
    const originalError = originalParse.diagnostics.find(
      (diagnostic) => diagnostic.severity === "error"
    );
    if (originalError) {
      throw new Error(`Failed to parse ${filename}: ${originalError.message}`);
    }
    const hmrDataSignature = createHmrDataSignature(
      code,
      originalParse.program,
      collectDefineRouteBindings(originalParse.program)
    );
    const signatureValue = Array.isArray(hookSignature)
      ? JSON.stringify(hookSignature)
      : 'route.component[Symbol.for("furin.hmr.hook-signature")] ?? [String(route.component)]';
    source.append(`
if (import.meta.hot && route?.component) {
  const previousDataSignature = ${JSON.stringify(hmrDataSignature)};
  Object.defineProperty(route, Symbol.for(${JSON.stringify(HMR_DATA_SIGNATURE)}), {
    configurable: true,
    value: previousDataSignature,
  });
  Object.defineProperty(route.component, Symbol.for("furin.hmr.hook-signature"), {
    configurable: true,
    value: ${signatureValue},
  });
  import.meta.hot.accept((updatedModule) => {
    const updatedRoute = updatedModule?.route;
    if (updatedRoute?.component) {
      const updatedDataSignature = Reflect.get(
        updatedRoute,
        Symbol.for(${JSON.stringify(HMR_DATA_SIGNATURE)})
      );
      const dataChanged =
        previousDataSignature.startsWith("external:") ||
        typeof updatedDataSignature !== "string" ||
        updatedDataSignature.startsWith("external:") ||
        updatedDataSignature !== previousDataSignature;
      window.__FURIN_HMR_UPDATE__?.(${JSON.stringify(filename)}, updatedRoute.component, dataChanged);
    }
  });
}
`);
  }

  return {
    code: source.toString(),
    map: source.generateMap({ includeContent: true, source: filename }),
    removedServerCode,
  };
}
