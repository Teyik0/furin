import MagicString from "magic-string";
import { literalValue, walk } from "yuku-ast";
import type {
  CallExpression,
  Expression,
  ImportDeclaration,
  ImportDeclarationSpecifier,
  Node,
  NodeOfType,
  Program,
} from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { isNode } from "../shared/utils/ast-walk.ts";
import { FactoryBindings, fluentChain, hasShadowingDeclaration } from "./binding-scope.ts";
import {
  collectModuleReferences,
  type DeadCodeState,
  pruneDeadBindings,
  pruneDeadImports,
  referencedNames,
  type SourceRange,
} from "./dead-code-elimination.ts";
import { hmrDependencySignature } from "./hmr-dependencies.ts";
import { transformIsomorphicFunctions } from "./transform-isomorphic.ts";

const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);
const FURIN_SERVER_MODULES = new Set(["@teyik0/furin", "furin"]);
const REACT_COMPONENT_WRAPPERS = new Set(["forwardRef", "memo"]);
const SERVER_ONLY_METHODS = new Set(["config", "head", "loader", "requestLoader", "staticParams"]);
const REACT_HOOK_NAME_RE = /^use[A-Z0-9]/;
const HMR_DATA_SIGNATURE = "furin.hmr.data-signature";
const HMR_SOURCE_SIGNATURE = "furin.hmr.source-signature";

type LocalDeclaration = NodeOfType<
  "ClassDeclaration" | "FunctionDeclaration" | "VariableDeclarator"
>;

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

function importedName(specifier: ImportDeclarationSpecifier): string | null {
  if (specifier.type !== "ImportSpecifier") {
    return null;
  }
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

function localName(specifier: ImportDeclarationSpecifier): string {
  return specifier.local.name;
}

function collectFactorySpecifiers(
  declaration: ImportDeclaration,
  bindings: Set<string>,
  namespaces: Set<string>
): void {
  for (const specifier of declaration.specifiers) {
    const namespace = localName(specifier);
    if (specifier.type === "ImportNamespaceSpecifier" && namespace) {
      namespaces.add(namespace);
    }
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

function collectDefineRouteBindings(program: Program): FactoryBindings {
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    if (statement.importKind !== "type" && isFurinRouteModule(statement.source.value)) {
      collectFactorySpecifiers(statement, bindings, namespaces);
    }
  }
  return new FactoryBindings(program, bindings, namespaces);
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
    const declaration = statement;
    const moduleName = declaration.source.value;
    if (!FURIN_SERVER_MODULES.has(moduleName)) {
      continue;
    }
    const importsClientValue = declaration.specifiers.some((specifier) => {
      const imported = importedName(specifier);
      return (
        bindings.has(localName(specifier)) || imported === "HeadContent" || imported === "Scripts"
      );
    });
    if (!importsClientValue) {
      continue;
    }
    const clientModule = moduleName === "furin" ? "furin/client" : "@teyik0/furin/client";
    source.update(declaration.source.start + 1, declaration.source.end - 1, clientModule);
    rewritten = true;
  }
  return rewritten;
}

function unwrapped(node: Expression | null | undefined): Expression | null;
function unwrapped(node: Node | null | undefined): Node | null;
function unwrapped(node: Node | null | undefined): Node | null {
  return node ? unwrapTSExpression(node) : null;
}

function chainRootIsDefineRoute(
  node: Node | null,
  bindings: FactoryBindings,
  ancestors: Node[]
): boolean {
  let current = unwrapped(node);
  while (current) {
    if (current.type === "MemberExpression") {
      current = unwrapped(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      current = unwrapped(current.callee);
      continue;
    }
    return current.type === "Identifier" && bindings.factoryName(current, ancestors) !== undefined;
  }
  return false;
}

function isLocalFactoryAlias(identifier: Node, ancestors: Node[], filename: string): boolean {
  const parent = ancestors.at(-1);
  if (
    parent?.type !== "VariableDeclarator" ||
    unwrapped(parent.id)?.type !== "Identifier" ||
    unwrapped(parent.init) !== identifier
  ) {
    return false;
  }
  const declaration = ancestors.at(-2);
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error(`[furin] ${filename}: route factory aliases must be immutable.`);
  }
  return ancestors.at(-3)?.type !== "ExportNamedDeclaration";
}

function assertCompleteRouteChains(
  program: Program,
  bindings: FactoryBindings,
  filename: string
): void {
  if (!bindings.hasImports) {
    return;
  }
  walk(program, {
    CallExpression(call, context) {
      const callee = unwrapped(call.callee);
      const ancestors = context.ancestors();
      if (!callee || bindings.factoryName(callee, ancestors) === undefined) {
        return;
      }
      const chain = fluentChain(call, ancestors);
      const terminal = chain.type === "CallExpression" ? unwrapped(chain.callee) : null;
      const method = terminal?.type === "MemberExpression" ? unwrapped(terminal.property) : null;
      if (method?.type !== "Identifier" || (method.name !== "page" && method.name !== "layout")) {
        throw new Error(
          `[furin] ${filename}: route builders must use one fluent chain ending in .page() or .layout().`
        );
      }
    },
    Identifier(node, context) {
      const ancestors = context.ancestors();
      const identifier = node;
      if (
        ancestors.some((ancestor) => ancestor.type === "ImportDeclaration") ||
        !isReferenceIdentifier(identifier, ancestors)
      ) {
        return;
      }
      const factory = bindings.factoryName(identifier, ancestors);
      const namespace = bindings.namespaceName(identifier, ancestors);
      if (factory === undefined && namespace === undefined) {
        return;
      }
      let index = ancestors.length - 1;
      while (index >= 0 && unwrapped(ancestors[index]) === identifier) {
        index -= 1;
      }
      const parent = ancestors[index];
      if (
        namespace !== undefined &&
        parent?.type === "MemberExpression" &&
        unwrapped(parent.object) === identifier
      ) {
        return;
      }
      if (
        factory !== undefined &&
        parent?.type === "CallExpression" &&
        unwrapped(parent.callee) === identifier
      ) {
        return;
      }
      if (isLocalFactoryAlias(identifier, ancestors.slice(0, index + 1), filename)) {
        return;
      }
      if (namespace !== undefined) {
        throw new Error(`[furin] ${filename}: route builders require a named import.`);
      }
      throw new Error(
        `[furin] ${filename}: route factory aliases require static local bindings and cannot escape.`
      );
    },
    MemberExpression(node, context) {
      const object = unwrapped(node.object);
      const property = unwrapped(node.property);
      const method = property?.type === "Identifier" ? property.name : literalValue(property);
      const dynamic = node.computed && property?.type !== "Literal";
      if (
        object?.type === "Identifier" &&
        bindings.namespaceName(object, context.ancestors()) !== undefined &&
        (dynamic || method === "defineRoute" || method === "defineRootRoute")
      ) {
        throw new Error(`[furin] ${filename}: route builders require a named import.`);
      }
      if (
        node.computed &&
        context.parent?.type === "CallExpression" &&
        chainRootIsDefineRoute(node.object, bindings, context.ancestors())
      ) {
        throw new Error(`[furin] ${filename}: route builders require static builder methods.`);
      }
    },
    VariableDeclarator(node, context) {
      const initializer = unwrapped(node.init);
      if (!(initializer && chainRootIsDefineRoute(initializer, bindings, context.ancestors()))) {
        return;
      }
      if (initializer.type === "Identifier") {
        const declaration = context.ancestors().at(-1);
        if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
          throw new Error(`[furin] ${filename}: route factory aliases must be immutable.`);
        }
        return;
      }
      const callee = initializer.type === "CallExpression" ? unwrapped(initializer.callee) : null;
      const method = callee?.type === "MemberExpression" ? unwrapped(callee.property) : null;
      if (method?.type !== "Identifier" || (method.name !== "page" && method.name !== "layout")) {
        throw new Error(
          `[furin] ${filename}: route builders must use one fluent chain ending in .page() or .layout().`
        );
      }
    },
  });
}

function memberAccessStart(source: string, object: Node, property: Node): number {
  // Parser expression ranges exclude parentheses around a fluent receiver.
  const accessGap = source.slice(object.end, property.start);
  const separator = accessGap
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (comment) => " ".repeat(comment.length))
    .lastIndexOf(".");
  return object.end + separator - (accessGap[separator - 1] === "?" ? 1 : 0);
}

interface StrippedCode {
  /** Config bindings the stripped `.config()` calls referenced. */
  configBindings: Set<string>;
  removed: SourceRange[];
  /** Names the retained remount policy references. */
  retained: Set<string>;
}

/** Drops a server stage, keeping only a `.config()` call's remount policy. */
function stripServerStage(
  source: MagicString,
  stripped: StrippedCode,
  range: SourceRange,
  remount: Node | null
): void {
  if (remount) {
    source.update(
      range.start,
      range.end,
      `.config({ ${source.original.slice(remount.start, remount.end)} })`
    );
    for (const name of referencedNames(remount)) {
      stripped.retained.add(name);
    }
  } else {
    source.remove(range.start, range.end);
  }
  stripped.removed.push(range);
}

function removeChainedServerCalls(
  source: MagicString,
  program: Program,
  bindings: FactoryBindings,
  stripped: StrippedCode,
  filename: string
): boolean {
  let transformed = rewriteClientImports(source, program, bindings);
  const { declarations } = collectModuleBindings(program);

  walk(program, {
    CallExpression(call, context) {
      const callee = unwrapped(call.callee);
      if (callee?.type !== "MemberExpression" || callee.computed === true) {
        return;
      }
      const { property } = callee;
      if (
        property.type !== "Identifier" ||
        !SERVER_ONLY_METHODS.has(property.name) ||
        !chainRootIsDefineRoute(callee.object, bindings, context.ancestors())
      ) {
        return;
      }
      const object = unwrapped(callee.object);
      if (!object) {
        return;
      }
      let remount: Node | null = null;
      if (property.name === "config" && Array.isArray(call.arguments)) {
        const config = unwrapped(call.arguments[0]);
        if (config?.type === "ObjectExpression" && Array.isArray(config.properties)) {
          collectConfigBindings(config, declarations, stripped.configBindings);
          remount = resolveRemountProperty(
            config,
            declarations,
            stripped.configBindings,
            new Set(),
            filename
          );
        }
      }
      const accessStart = memberAccessStart(source.original, object, property);
      stripServerStage(source, stripped, { end: call.end, start: accessStart }, remount);
      transformed = true;
    },
  });
  return transformed;
}

function declaredInitializer(declaration: LocalDeclaration | undefined): Expression | null {
  return declaration?.type === "VariableDeclarator" ? unwrapped(declaration.init) : null;
}

function collectConfigBindings(
  config: Node | null,
  declarations: Map<string, LocalDeclaration>,
  names: Set<string>
): void {
  if (config?.type === "Identifier" && !names.has(config.name)) {
    names.add(config.name);
    const declaration = declarations.get(config.name);
    collectConfigBindings(declaredInitializer(declaration), declarations, names);
  } else if (config?.type === "ObjectExpression" && Array.isArray(config.properties)) {
    for (const property of config.properties) {
      const entry = unwrapped(property);
      if (entry?.type === "SpreadElement") {
        collectConfigBindings(unwrapped(entry.argument), declarations, names);
      }
    }
  }
}

function resolveRemountProperty(
  config: Node | null,
  declarations: Map<string, LocalDeclaration>,
  configBindings: Set<string>,
  visiting: Set<string>,
  filename: string
): Node | null {
  if (config?.type === "Identifier" && !visiting.has(config.name)) {
    visiting.add(config.name);
    configBindings.add(config.name);
    const declaration = declarations.get(config.name);
    const result = resolveRemountProperty(
      declaredInitializer(declaration),
      declarations,
      configBindings,
      visiting,
      filename
    );
    visiting.delete(config.name);
    return result;
  }
  if (config?.type !== "ObjectExpression" || !Array.isArray(config.properties)) {
    throw new Error(
      `[furin] ${filename}: route config spreads must resolve to local object literals; declare remountDeps after dynamic spreads.`
    );
  }
  for (let index = config.properties.length - 1; index >= 0; index -= 1) {
    const entry = unwrapped(config.properties[index]);
    if (entry?.type === "SpreadElement") {
      const remount = resolveRemountProperty(
        unwrapped(entry.argument),
        declarations,
        configBindings,
        visiting,
        filename
      );
      if (remount) {
        return remount;
      }
    } else if (entry?.type === "Property") {
      const key = unwrapped(entry.key);
      if (
        (key?.type === "Identifier" && entry.computed !== true && key.name === "remountDeps") ||
        (key?.type === "Literal" && key.value === "remountDeps")
      ) {
        return entry;
      }
    }
  }
  return null;
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

function collectModuleBindings(program: Program): {
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

function isReferenceIdentifier(node: Node, ancestors: Node[]): boolean {
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
  ancestors: Node[],
  visitor: (node: Node, ancestors: Node[]) => void
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkWithAncestors(entry, ancestors, visitor);
    }
    return;
  }
  if (!value || typeof value !== "object" || !isNode(value)) {
    return;
  }
  const node = unwrapTSExpression(value);
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type" && key !== "start" && key !== "end" && key !== "comments") {
      walkWithAncestors(child, nextAncestors, visitor);
    }
  }
}

interface HmrDependencyState {
  dependencies: Map<number, LocalDeclaration>;
  dynamicImports: Set<string>;
  imports: Set<ImportDeclaration>;
  importTrackedDependencies: Set<number>;
  moduleBindings: ReturnType<typeof collectModuleBindings>;
}

function collectDependencyIdentifier(
  child: Node,
  ancestors: Node[],
  trackImports: boolean,
  state: HmrDependencyState
): void {
  if (child.type !== "Identifier" && child.type !== "JSXIdentifier") {
    return;
  }
  const parent = ancestors.at(-1);
  const jsxReference =
    child.type === "JSXIdentifier" &&
    ((parent?.type === "JSXOpeningElement" &&
      parent.name === child &&
      child.name[0] === child.name[0]?.toUpperCase()) ||
      (parent?.type === "JSXMemberExpression" && parent.object === child));
  if (
    (child.type === "JSXIdentifier" && !jsxReference) ||
    !isReferenceIdentifier(child, ancestors) ||
    hasShadowingDeclaration(child.name, ancestors)
  ) {
    return;
  }
  const declaration = state.moduleBindings.declarations.get(child.name);
  if (!declaration) {
    const imported = state.moduleBindings.imports.get(child.name);
    if (trackImports && imported) {
      state.imports.add(imported);
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

function collectDependencies(node: Node, trackImports: boolean, state: HmrDependencyState): void {
  walkWithAncestors(node, [], (child, ancestors) => {
    collectDependencyIdentifier(child, ancestors, trackImports, state);
    if (trackImports && child.type === "ImportExpression") {
      const source = unwrapped(child.source);
      const specifier = source?.type === "Literal" ? source.value : undefined;
      if (typeof specifier === "string") {
        state.dynamicImports.add(specifier);
      }
    }
  });
}

function createHmrDataSignature(
  code: string,
  program: Program,
  bindings: FactoryBindings,
  filename: string
): string {
  const serverStages: Array<{ source: string; start: number }> = [];
  const dependencyState: HmrDependencyState = {
    dependencies: new Map(),
    dynamicImports: new Set(),
    imports: new Set(),
    importTrackedDependencies: new Set(),
    moduleBindings: collectModuleBindings(program),
  };

  walk(program, {
    CallExpression(call, context) {
      const callee = unwrapped(call.callee);
      if (callee?.type !== "MemberExpression" || callee.computed === true) {
        return;
      }
      const { property } = callee;
      if (
        property.type !== "Identifier" ||
        !SERVER_ONLY_METHODS.has(property.name) ||
        !chainRootIsDefineRoute(callee.object, bindings, context.ancestors())
      ) {
        return;
      }
      const object = unwrapped(callee.object);
      if (!object) {
        return;
      }
      serverStages.push({
        source: code.slice(object.end, call.end),
        start: call.start,
      });
      if (Array.isArray(call.arguments)) {
        for (const argument of call.arguments) {
          const argumentNode = unwrapped(argument);
          if (argumentNode) {
            collectDependencies(argumentNode, property.name !== "config", dependencyState);
          }
        }
      }
    },
  });

  const dataSource = [
    ...serverStages,
    ...[...dependencyState.imports].map((imported) => ({
      source: code.slice(imported.start, imported.end),
      start: imported.start,
    })),
    ...[...dependencyState.dependencies.values()].map((dependency) => ({
      source: code.slice(dependency.start, dependency.end),
      start: dependency.start,
    })),
  ]
    .sort((left, right) => left.start - right.start)
    .map((entry) => entry.source)
    .join("\n");
  const hash = new Bun.CryptoHasher("sha256").update(dataSource).digest("hex");
  if (dependencyState.imports.size === 0 && dependencyState.dynamicImports.size === 0) {
    return hash;
  }
  const dependencies = hmrDependencySignature(
    new Set([
      ...[...dependencyState.imports].map((imported) => imported.source.value),
      ...dependencyState.dynamicImports,
    ]),
    filename
  );
  return dependencies === undefined ? `external:${hash}` : `imports:${hash}:${dependencies}`;
}

/** Server stages and their imports share one signature across both HMR graphs. */
export function getHmrDataSignature(code: string, filename: string): string {
  const { diagnostics, program } = parseSource(code, detectLangFromPath(filename));
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (error) {
    throw new Error(`Failed to parse ${filename}: ${error.message}`);
  }
  return createHmrDataSignature(code, program, collectDefineRouteBindings(program), filename);
}

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

function routeComponentExpression(program: Program, bindings: FactoryBindings): Node | null {
  let component: Node | null = null;
  walk(program, {
    CallExpression(call, context) {
      const callee = unwrapped(call.callee);
      if (callee?.type !== "MemberExpression" || callee.computed === true) {
        return;
      }
      const { property } = callee;
      const ancestors = context.ancestors();
      const routeDeclarator = ancestors.find((ancestor) => {
        if (ancestor.type !== "VariableDeclarator") {
          return false;
        }
        const identifier = unwrapped(ancestor.id);
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
      component = Array.isArray(args) ? unwrapped(args[0]) : null;
      context.stop();
    },
  });
  return component;
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

function collectClientHookSignature(
  code: string,
  program: Program,
  bindings: FactoryBindings
): string[] | ImportedRouteComponent | "external" | null {
  const componentExpression = routeComponentExpression(program, bindings);
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

function parseOrThrow(code: string, filename: string): Program {
  const { diagnostics, program } = parseSource(code, detectLangFromPath(filename));
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }
  return program;
}

export function transformForClient(code: string, filename: string): TransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code, map: null, removedServerCode: false };
  }

  const isomorphicResult = transformIsomorphicFunctions(code, filename, "client");
  const clientSource = isomorphicResult.code;
  // Every step below edits this one AST and MagicString in clientSource
  // coordinates; nothing is reparsed until Bun bundles the result.
  const program = parseOrThrow(clientSource, filename);
  const originalProgram = clientSource === code ? program : parseOrThrow(code, filename);

  const source = new MagicString(clientSource);
  const routeBindings = collectDefineRouteBindings(program);
  assertCompleteRouteChains(program, routeBindings, filename);
  const stripped: StrippedCode = { configBindings: new Set(), removed: [], retained: new Set() };
  const removedRouteCode = removeChainedServerCalls(
    source,
    program,
    routeBindings,
    stripped,
    filename
  );
  const removedServerCode = isomorphicResult.transformed || removedRouteCode;
  if (removedServerCode) {
    const state: DeadCodeState = {
      before: collectModuleReferences(originalProgram, []),
      forced: stripped.configBindings,
      program,
      removed: stripped.removed,
      retained: stripped.retained,
      source,
    };
    pruneDeadBindings(state);
    pruneDeadImports(state);
  }
  let hookSignature =
    routeBindings.size > 0
      ? collectClientHookSignature(clientSource, program, routeBindings)
      : null;
  if (hookSignature && typeof hookSignature === "object" && !Array.isArray(hookSignature)) {
    const createElementBinding = unusedIdentifier(program, "__furinCreateElement");
    source.prepend(`import { createElement as ${createElementBinding} } from "react";\n`);
    source.update(
      hookSignature.start,
      hookSignature.end,
      `(import.meta.hot ? (props) => ${createElementBinding}(${hookSignature.expression}, props) : ${hookSignature.expression})`
    );
    hookSignature = [];
  }
  if (routeBindings.size > 0 && hookSignature !== null) {
    const hmrDataSignature = createHmrDataSignature(
      code,
      originalProgram,
      originalProgram === program ? routeBindings : collectDefineRouteBindings(originalProgram),
      filename
    );
    const signatureValue = Array.isArray(hookSignature)
      ? JSON.stringify(hookSignature)
      : 'route.component[Symbol.for("furin.hmr.hook-signature")] ?? [String(route.component)]';
    source.append(`
if (import.meta.hot && route?.component) {
  const previousDataSignature = ${JSON.stringify(hmrDataSignature)};
  const previousSourceSignature = ${JSON.stringify(Bun.hash(code).toString(16))};
  Object.defineProperty(route, Symbol.for(${JSON.stringify(HMR_SOURCE_SIGNATURE)}), {
    configurable: true,
    value: previousSourceSignature,
  });
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
      // An unchanged source can be re-evaluated by Bun after an import edit
      // without rerunning this transform. Its embedded dependency hash is stale.
      const dataChanged =
        previousDataSignature.startsWith("external:") ||
        typeof updatedDataSignature !== "string" ||
        updatedDataSignature.startsWith("external:") ||
        (updatedDataSignature.startsWith("imports:") &&
          Reflect.get(updatedRoute, Symbol.for(${JSON.stringify(HMR_SOURCE_SIGNATURE)})) === previousSourceSignature) ||
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
