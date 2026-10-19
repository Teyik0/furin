import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type {
  Argument,
  CallExpression,
  Expression,
  ImportDeclarationSpecifier,
  ImportSpecifier,
  Node,
  Program,
  VariableDeclaration,
  VariableDeclarator,
} from "yuku-parser";
import {
  detectLangFromPath,
  detectLoaderFromPath,
  unwrapTSExpression,
} from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { hasShadowingDeclaration, lexicalBindingScope, varBindingScope } from "./binding-scope.ts";
import { pruneDeadCode } from "./dead-code-elimination.ts";
import { transformClientModuleSource } from "./transform-client-module.ts";

const FURIN_MODULES = new Set(["@teyik0/furin", "furin"]);
const SCRIPT_FILE_FILTER =
  /^(?!.*(?:[\\/]node_modules[\\/]|[\\/]\.furin[\\/]build[\\/])).*\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/;

export type IsomorphicEnvironment = "client" | "server";

export interface IsomorphicTransformResult {
  code: string;
  transformed: boolean;
}

interface IsomorphicBindings {
  constants: ConstantBinding[];
  constantsByName: Map<string, ConstantBinding[]>;
  named: Set<string>;
  namespaces: Set<string>;
}

interface ConstantBinding {
  ancestors: Node[];
  declaration: VariableDeclarator;
  initializer: Expression;
  name: string;
  scope: Node;
  statement: VariableDeclaration;
}

interface IsomorphicCandidate {
  client: Argument | undefined;
  end: number;
  server: Argument | undefined;
  start: number;
}

interface IsomorphicBuilderBinding {
  name: string;
  scope: Node;
}

function importedName(specifier: ImportSpecifier): string {
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

function addImportSpecifier(
  specifier: ImportDeclarationSpecifier,
  bindings: IsomorphicBindings
): void {
  const local = specifier.local.name;
  if (specifier.type === "ImportNamespaceSpecifier") {
    bindings.namespaces.add(local);
    return;
  }
  if (
    specifier.type === "ImportSpecifier" &&
    specifier.importKind !== "type" &&
    importedName(specifier) === "createIsomorphicFn"
  ) {
    bindings.named.add(local);
  }
}

function collectBindings(program: Program): IsomorphicBindings {
  const bindings = {
    constants: [] as ConstantBinding[],
    constantsByName: new Map<string, ConstantBinding[]>(),
    named: new Set<string>(),
    namespaces: new Set<string>(),
  };

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    if (statement.importKind === "type" || !FURIN_MODULES.has(statement.source.value)) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      addImportSpecifier(specifier, bindings);
    }
  }

  if (bindings.named.size === 0 && bindings.namespaces.size === 0) {
    return bindings;
  }
  walk(program, {
    VariableDeclarator(node, context) {
      const ancestors = context.ancestors();
      const declaration = ancestors.at(-1);
      const scope = lexicalBindingScope(ancestors);
      if (
        declaration?.type !== "VariableDeclaration" ||
        declaration.kind !== "const" ||
        node.id.type !== "Identifier" ||
        !node.init ||
        !scope
      ) {
        return;
      }
      const binding = {
        ancestors,
        declaration: node,
        initializer: node.init,
        name: node.id.name,
        scope,
        statement: declaration,
      };
      bindings.constants.push(binding);
      const constants = bindings.constantsByName.get(binding.name) ?? [];
      constants.push(binding);
      bindings.constantsByName.set(binding.name, constants);
    },
  });

  return bindings;
}

function resolveConstant(
  name: string,
  bindings: IsomorphicBindings,
  ancestors: Node[]
): ConstantBinding | undefined {
  let match: ConstantBinding | undefined;
  let scopeIndex = -1;
  const constants = bindings.constantsByName.get(name);
  if (!constants) {
    return undefined;
  }
  for (const binding of constants) {
    const index = ancestors.lastIndexOf(binding.scope);
    if (index > scopeIndex) {
      match = binding;
      scopeIndex = index;
    }
  }
  return match && !hasShadowingDeclaration(name, ancestors.slice(scopeIndex + 1))
    ? match
    : undefined;
}

function resolveStaticString(
  expression: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[],
  seen: Set<ConstantBinding>
): string | undefined {
  const node = unwrapTSExpression(expression);
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Identifier") {
    const binding = resolveConstant(node.name, bindings, ancestors);
    if (binding && !seen.has(binding)) {
      seen.add(binding);
      return resolveStaticString(binding.initializer, bindings, binding.ancestors, seen);
    }
  }
}

function isCreateIsomorphicCall(
  node: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[]
): boolean {
  if (node.type !== "CallExpression") {
    return false;
  }
  return isFactoryExpression(node.callee, bindings, ancestors, new Set());
}

function isFactoryExpression(
  expression: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[],
  seen: Set<ConstantBinding>
): boolean {
  const callee = unwrapTSExpression(expression);
  if (
    callee.type === "Identifier" &&
    bindings.named.has(callee.name) &&
    !hasShadowingDeclaration(callee.name, ancestors)
  ) {
    return true;
  }
  if (callee.type === "Identifier") {
    const binding = resolveConstant(callee.name, bindings, ancestors);
    if (binding && !seen.has(binding)) {
      seen.add(binding);
      return isFactoryExpression(binding.initializer, bindings, binding.ancestors, seen);
    }
  }
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    bindings.namespaces.has(callee.object.name) &&
    !hasShadowingDeclaration(callee.object.name, ancestors) &&
    (callee.computed
      ? resolveStaticString(callee.property, bindings, ancestors, new Set()) ===
        "createIsomorphicFn"
      : callee.property.type === "Identifier" && callee.property.name === "createIsomorphicFn")
  );
}

function environmentMethod(
  node: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[]
): IsomorphicEnvironment | undefined {
  if (node.type !== "CallExpression") {
    return;
  }
  const { callee } = node;
  if (callee.type !== "MemberExpression") {
    return;
  }
  let method: string | undefined;
  if (callee.computed) {
    method = resolveStaticString(callee.property, bindings, ancestors, new Set());
  } else if (callee.property.type === "Identifier") {
    method = callee.property.name;
  }
  return method === "client" || method === "server" ? method : undefined;
}

function parseCandidate(
  source: string,
  filename: string,
  node: CallExpression,
  bindings: IsomorphicBindings,
  ancestors: Node[]
): IsomorphicCandidate | null {
  let current: Node = node;
  let client: Argument | undefined;
  let server: Argument | undefined;

  for (;;) {
    const method = environmentMethod(current, bindings, ancestors);
    // environmentMethod only resolves a method on a call expression.
    if (!method || current.type !== "CallExpression") {
      break;
    }
    if (current.callee.type !== "MemberExpression") {
      return null;
    }
    const [implementation] = current.arguments;
    if (!implementation) {
      return null;
    }
    if (method === "client") {
      client ??= implementation;
    } else {
      server ??= implementation;
    }
    current = unwrapTSExpression(current.callee.object);
  }

  if (!isCreateIsomorphicCall(current, bindings, ancestors)) {
    return null;
  }

  for (const [method, implementation] of [
    ["client", client],
    ["server", server],
  ] as const) {
    if (!implementation) {
      continue;
    }
    const unwrapped = unwrapTSExpression(implementation);
    if (
      unwrapped.type !== "ArrowFunctionExpression" &&
      unwrapped.type !== "FunctionExpression" &&
      unwrapped.type !== "Identifier"
    ) {
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, implementation.start)} createIsomorphicFn().${method}() must receive a function.`
      );
    }
  }

  return {
    client,
    end: node.end,
    server,
    start: node.start,
  };
}

function collectCandidates(
  source: string,
  filename: string,
  program: Program,
  bindings: IsomorphicBindings
): IsomorphicCandidate[] {
  const candidates: IsomorphicCandidate[] = [];

  walk(program, {
    CallExpression(node, context) {
      const candidate = parseCandidate(source, filename, node, bindings, context.ancestors());
      if (candidate) {
        candidates.push(candidate);
      }
    },
  });

  return candidates
    .toSorted((left, right) => right.end - right.start - (left.end - left.start))
    .filter(
      (candidate, index, all) =>
        !all
          .slice(0, index)
          .some((other) => other.start <= candidate.start && other.end >= candidate.end)
    );
}

function sourcePosition(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return `${line}:${offset - lastNewline}`;
}

function collectBuilderBindings(
  program: Program,
  bindings: IsomorphicBindings
): IsomorphicBuilderBinding[] {
  const builders: IsomorphicBuilderBinding[] = [];

  walk(program, {
    VariableDeclarator(node, context) {
      if (!node.init) {
        return;
      }
      const identifier = node.id;
      const initializer = unwrapTSExpression(node.init);
      const ancestors = context.ancestors();
      const declaration = ancestors.at(-1);
      const scope =
        declaration?.type === "VariableDeclaration" && declaration.kind === "var"
          ? varBindingScope(ancestors)
          : lexicalBindingScope(ancestors);
      if (
        scope &&
        identifier.type === "Identifier" &&
        isCreateIsomorphicCall(initializer, bindings, ancestors)
      ) {
        builders.push({ name: identifier.name, scope });
      }
    },
  });
  return builders;
}

function hasVisibleBuilder(
  name: string,
  ancestors: Node[],
  builders: IsomorphicBuilderBinding[]
): boolean {
  let scopeIndex = -1;
  for (const builder of builders) {
    if (builder.name === name) {
      scopeIndex = Math.max(scopeIndex, ancestors.lastIndexOf(builder.scope));
    }
  }
  return scopeIndex >= 0 && !hasShadowingDeclaration(name, ancestors.slice(scopeIndex + 1));
}

function assertNoSplitChains(
  source: string,
  filename: string,
  program: Program,
  builders: IsomorphicBuilderBinding[]
): void {
  if (builders.length === 0) {
    return;
  }

  walk(program, {
    MemberExpression(node, context) {
      if (
        node.computed ||
        node.object.type !== "Identifier" ||
        !hasVisibleBuilder(node.object.name, context.ancestors(), builders) ||
        node.property.type !== "Identifier" ||
        (node.property.name !== "server" && node.property.name !== "client")
      ) {
        return;
      }
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, node.start)} createIsomorphicFn() must use one fluent chain.`
      );
    },
  });
}

function chainStartsWithCreateIsomorphicFn(
  expression: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[]
): boolean {
  let current = unwrapTSExpression(expression);
  for (;;) {
    if (isCreateIsomorphicCall(current, bindings, ancestors)) {
      return true;
    }
    if (current.type !== "CallExpression" || !environmentMethod(current, bindings, ancestors)) {
      return false;
    }
    if (current.callee.type !== "MemberExpression") {
      return false;
    }
    current = unwrapTSExpression(current.callee.object);
  }
}

function assertStaticEnvironmentMethods(
  source: string,
  filename: string,
  program: Program,
  bindings: IsomorphicBindings,
  builders: IsomorphicBuilderBinding[]
): void {
  walk(program, {
    MemberExpression(node, context) {
      if (!node.computed) {
        return;
      }
      const ancestors = context.ancestors();
      const splitBuilder =
        node.object.type === "Identifier" &&
        hasVisibleBuilder(node.object.name, ancestors, builders);
      if (!(splitBuilder || chainStartsWithCreateIsomorphicFn(node.object, bindings, ancestors))) {
        return;
      }
      const method = resolveStaticString(node.property, bindings, ancestors, new Set());
      if (!splitBuilder && (method === "server" || method === "client")) {
        return;
      }
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, node.start)} createIsomorphicFn() requires static .server() and .client() methods.`
      );
    },
  });
}

function assertStaticNamespaceUse(
  node: Node,
  bindings: IsomorphicBindings,
  ancestors: Node[],
  filename: string
): void {
  if (
    !(
      node.type === "Identifier" &&
      bindings.namespaces.has(node.name) &&
      !hasShadowingDeclaration(node.name, ancestors)
    )
  ) {
    return;
  }
  const parent = ancestors.at(-1);
  if (
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    (!parent.computed ||
      resolveStaticString(parent.property, bindings, ancestors, new Set()) !== undefined)
  ) {
    return;
  }
  throw new Error(
    `[furin] ${filename}: Furin namespace imports must use direct static member access so createIsomorphicFn can be compiled. Use a named import instead of escaping the namespace.`
  );
}

function assertResolvedFactoryUses(
  program: Program,
  bindings: IsomorphicBindings,
  filename: string
): void {
  const inspect = (node: Node, ancestors: Node[]): void => {
    const parent = ancestors.at(-1);
    if (
      parent?.type === "ImportSpecifier" ||
      parent?.type === "ImportNamespaceSpecifier" ||
      (parent?.type === "VariableDeclarator" && parent.id === node) ||
      (parent?.type === "MemberExpression" && !parent.computed && parent.property === node) ||
      (parent?.type === "Property" &&
        !parent.computed &&
        !parent.shorthand &&
        parent.key === node) ||
      ancestors.some(
        (ancestor) => ancestor.type === "TSTypeQuery" || ancestor.type === "TSTypeReference"
      )
    ) {
      return;
    }
    assertStaticNamespaceUse(node, bindings, ancestors, filename);
    if (!isFactoryExpression(node, bindings, ancestors, new Set())) {
      return;
    }
    let expression = node;
    let index = ancestors.length - 1;
    let wrapper = ancestors[index];
    while (wrapper && unwrapTSExpression(wrapper) === expression) {
      expression = wrapper;
      index -= 1;
      wrapper = ancestors[index];
    }
    const owner = ancestors[index];
    if (owner?.type === "CallExpression" && owner.callee === expression) {
      return;
    }
    const declaration = ancestors[index - 1];
    if (
      owner?.type === "VariableDeclarator" &&
      owner.init === expression &&
      owner.id.type === "Identifier" &&
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
    ) {
      return;
    }
    throw new Error(
      `[furin] ${filename}: createIsomorphicFn references must stay in statically resolvable fluent chains or constant aliases.`
    );
  };
  walk(program, {
    Identifier(node, context) {
      inspect(node, context.ancestors());
    },
    MemberExpression(node, context) {
      inspect(node, context.ancestors());
    },
  });
}

function pruneFactoryAliases(code: string, filename: string): string {
  const { program } = parseSource(code, detectLangFromPath(filename));
  const bindings = collectBindings(program);
  const aliases = bindings.constants.filter((binding) =>
    isFactoryExpression(binding.initializer, bindings, binding.ancestors, new Set())
  );
  const used = new Set<ConstantBinding>();
  walk(program, {
    Identifier(node, context) {
      const ancestors = context.ancestors();
      const parent = ancestors.at(-1);
      if (
        (parent?.type === "VariableDeclarator" && parent.id === node) ||
        (parent?.type === "MemberExpression" && !parent.computed && parent.property === node) ||
        (parent?.type === "Property" &&
          !parent.computed &&
          !parent.shorthand &&
          parent.key === node)
      ) {
        return;
      }
      const binding = resolveConstant(node.name, bindings, ancestors);
      if (binding) {
        used.add(binding);
      }
    },
  });
  const unused = aliases.filter(
    (binding) => !(used.has(binding) || binding.ancestors.at(-2)?.type === "ExportNamedDeclaration")
  );
  if (unused.length === 0) {
    return code;
  }
  const pruned = new MagicString(code);
  const removedDeclarations = new Set<VariableDeclaration>();
  for (const binding of unused) {
    const declaration = binding.statement;
    if (removedDeclarations.has(declaration)) {
      continue;
    }
    removedDeclarations.add(declaration);
    const declarators = declaration.declarations;
    if (declarators.length === 1) {
      pruned.remove(declaration.start, declaration.end);
    } else {
      const index = declarators.indexOf(binding.declaration);
      const next = declarators[index + 1];
      const previous = declarators[index - 1];
      if (next) {
        pruned.remove(binding.declaration.start, next.start);
      } else if (previous) {
        pruned.remove(previous.end, binding.declaration.end);
      }
    }
  }
  return pruneFactoryAliases(pruned.toString(), filename);
}

export function transformIsomorphicFunctions(
  input: string,
  filename: string,
  environment: IsomorphicEnvironment
): IsomorphicTransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code: input, transformed: false };
  }
  const clientModules = transformClientModuleSource(input, filename, environment);
  const source = clientModules.toString();
  const clientModulesTransformed = source !== input;

  const { program, diagnostics } = parseSource(source, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  const bindings = collectBindings(program);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) {
    return { code: source, transformed: clientModulesTransformed };
  }
  assertResolvedFactoryUses(program, bindings, filename);
  const builders = collectBuilderBindings(program, bindings);
  assertStaticEnvironmentMethods(source, filename, program, bindings, builders);
  assertNoSplitChains(source, filename, program, builders);
  const candidates = collectCandidates(source, filename, program, bindings);
  if (candidates.length === 0) {
    return { code: source, transformed: clientModulesTransformed };
  }

  const transformed = new MagicString(source);
  for (const candidate of candidates) {
    const implementation = candidate[environment];
    if (implementation) {
      transformed.remove(candidate.start, implementation.start);
      transformed.remove(implementation.end, candidate.end);
      transformed.appendLeft(implementation.start, "(");
      transformed.appendLeft(implementation.end, ")");
    } else {
      transformed.overwrite(candidate.start, candidate.end, "(() => undefined)");
    }
  }

  const aliasesPruned = new MagicString(pruneFactoryAliases(transformed.toString(), filename));
  const pruned = pruneDeadCode(aliasesPruned, source, lang);
  const nested = transformIsomorphicFunctions(pruned.toString(), filename, environment);
  return { code: nested.code, transformed: true };
}

export function isomorphicTransformPlugin(environment: IsomorphicEnvironment): Bun.BunPlugin {
  return {
    name: `furin-isomorphic-${environment}`,
    setup(build) {
      build.onLoad({ filter: SCRIPT_FILE_FILTER }, async (args) => {
        const path = args.path.split("?")[0] as string;
        const source = await Bun.file(path).text();
        const loader = detectLoaderFromPath(path);
        const result = transformIsomorphicFunctions(source, path, environment);
        return {
          contents: result.transformed ? result.code : source,
          loader,
        };
      });
    },
  };
}
