import { literalValue, walk } from "yuku-ast";
import type {
  CallExpression,
  Expression,
  IdentifierName,
  ImportDeclaration,
  Node,
  Program,
} from "yuku-parser";
import { FactoryBindings, fluentChain } from "./binding-scope.ts";
import { importedName, isReferenceIdentifier, localName, unwrapped } from "./module-bindings.ts";

const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);
export const FURIN_SERVER_MODULES = new Set(["@teyik0/furin", "furin"]);
const SERVER_ONLY_METHODS = new Set(["config", "head", "loader", "requestLoader", "staticParams"]);

function isFurinRouteModule(source: unknown): source is string {
  return (
    typeof source === "string" &&
    (FURIN_SERVER_MODULES.has(source) || FURIN_CLIENT_MODULES.has(source))
  );
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

export function collectDefineRouteBindings(program: Program): FactoryBindings {
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

export function assertCompleteRouteChains(
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

export interface ServerStage {
  call: CallExpression;
  /** The chain the stage is called on. */
  object: Expression;
  property: IdentifierName;
}

/** The `defineRoute(id)` chains of a module, found in one walk for every step. */
export interface RouteChains {
  /** The component passed to the exported route's `.page()` or `.layout()`. */
  component: Node | null;
  serverStages: ServerStage[];
}

export interface RouteChainCall {
  call: CallExpression;
  method: string;
}

/** `export const route = defineRoute(id)...`: the `route` export route discovery reads. */
export interface ExportedRouteChain {
  /** The builder calls after the factory call, the terminal call first. */
  calls: RouteChainCall[];
  /** Local name of the `defineRoute` or `defineRootRoute` import. */
  factory: string;
  head: CallExpression;
}

/**
 * The module's top-level `export const route = <factory>()...` chain, the
 * single definition of "the route export" for every transform and check.
 */
export function exportedRouteChain(
  program: Program,
  bindings: FactoryBindings
): ExportedRouteChain | undefined {
  for (const statement of program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      continue;
    }
    for (const declarator of statement.declaration.declarations) {
      const id = unwrapped(declarator.id);
      if (id?.type === "Identifier" && id.name === "route") {
        return routeChainOf(declarator.init, bindings, program);
      }
    }
  }
}

function routeChainOf(
  initializer: Expression | null,
  bindings: FactoryBindings,
  program: Program
): ExportedRouteChain | undefined {
  const calls: RouteChainCall[] = [];
  let current = unwrapped(initializer);
  while (current?.type === "CallExpression") {
    const callee = unwrapped(current.callee);
    if (callee?.type !== "MemberExpression") {
      const factory = callee ? bindings.factoryName(callee, [program]) : undefined;
      return factory === undefined ? undefined : { calls, factory, head: current };
    }
    if (callee.computed || callee.property.type !== "Identifier") {
      return;
    }
    calls.push({ call: current, method: callee.property.name });
    current = unwrapped(callee.object);
  }
}

export function analyzeRouteChains(program: Program, bindings: FactoryBindings): RouteChains {
  const chains: RouteChains = { component: null, serverStages: [] };
  if (bindings.size === 0) {
    return chains;
  }
  const [terminal] = exportedRouteChain(program, bindings)?.calls ?? [];
  if (terminal?.method === "page" || terminal?.method === "layout") {
    chains.component = unwrapped(terminal.call.arguments[0]);
  }
  walk(program, {
    CallExpression(call, context) {
      const callee = unwrapped(call.callee);
      if (callee?.type !== "MemberExpression" || callee.computed === true) {
        return;
      }
      const { property } = callee;
      if (property.type !== "Identifier") {
        return;
      }
      if (SERVER_ONLY_METHODS.has(property.name)) {
        const object = unwrapped(callee.object);
        if (object && chainRootIsDefineRoute(callee.object, bindings, context.ancestors())) {
          chains.serverStages.push({ call, object, property });
        }
      }
    },
  });
  return chains;
}
