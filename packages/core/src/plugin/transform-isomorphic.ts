import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { CallExpression, ImportDeclaration, Program } from "yuku-parser";
import {
  detectLangFromPath,
  detectLoaderFromPath,
  unwrapTSExpression,
} from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";
import { transformClientModules } from "./transform-client-module.ts";

const FURIN_MODULES = new Set(["@teyik0/furin", "furin"]);
const SCRIPT_FILE_FILTER =
  /^(?!.*(?:node_modules|[\\/]\.furin[\\/]build[\\/])).*\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/;

export type IsomorphicEnvironment = "client" | "server";

export interface IsomorphicTransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  transformed: boolean;
}

interface IsomorphicBindings {
  constants: ConstantBinding[];
  named: Set<string>;
  namespaces: Set<string>;
}

interface ConstantBinding {
  ancestors: AstNode[];
  declaration: AstNode;
  initializer: AstNode;
  name: string;
  scope: AstNode;
}

interface IsomorphicCandidate {
  client: AstNode | undefined;
  end: number;
  server: AstNode | undefined;
  start: number;
}

interface IsomorphicBuilderBinding {
  name: string;
  scope: AstNode;
}

function importedName(specifier: AstNode): string | undefined {
  const { imported } = specifier;
  if (!(imported && typeof imported === "object")) {
    return;
  }
  const node = imported as AstNode;
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
}

function localName(specifier: AstNode): string | undefined {
  const local = specifier.local as AstNode | undefined;
  return local?.type === "Identifier" && typeof local.name === "string" ? local.name : undefined;
}

function addImportSpecifier(specifier: AstNode, bindings: IsomorphicBindings): void {
  const local = localName(specifier);
  if (!local) {
    return;
  }
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
    named: new Set<string>(),
    namespaces: new Set<string>(),
  };

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    if (declaration.importKind === "type" || !FURIN_MODULES.has(String(declaration.source.value))) {
      continue;
    }
    for (const specifier of declaration.specifiers as unknown as AstNode[]) {
      addImportSpecifier(specifier, bindings);
    }
  }

  walk(program, {
    VariableDeclarator(node, context) {
      const ancestors = context.ancestors() as AstNode[];
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
      bindings.constants.push({
        ancestors,
        declaration: node as unknown as AstNode,
        initializer: node.init as AstNode,
        name: node.id.name,
        scope,
      });
    },
  });

  return bindings;
}

function resolveConstant(
  name: string,
  bindings: IsomorphicBindings,
  ancestors: AstNode[]
): ConstantBinding | undefined {
  let match: ConstantBinding | undefined;
  let scopeIndex = -1;
  for (const binding of bindings.constants) {
    const index = ancestors.lastIndexOf(binding.scope);
    if (binding.name === name && index > scopeIndex) {
      match = binding;
      scopeIndex = index;
    }
  }
  return match && !hasShadowingDeclaration(name, ancestors.slice(scopeIndex + 1))
    ? match
    : undefined;
}

function resolveStaticString(
  expression: AstNode,
  bindings: IsomorphicBindings,
  ancestors: AstNode[],
  seen: Set<ConstantBinding>
): string | undefined {
  const node = unwrapTSExpression(expression);
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    const binding = resolveConstant(node.name, bindings, ancestors);
    if (binding && !seen.has(binding)) {
      seen.add(binding);
      return resolveStaticString(binding.initializer, bindings, binding.ancestors, seen);
    }
  }
}

function isCreateIsomorphicCall(
  node: AstNode,
  bindings: IsomorphicBindings,
  ancestors: AstNode[]
): boolean {
  if (node.type !== "CallExpression") {
    return false;
  }
  const call = node as unknown as CallExpression;
  return isFactoryExpression(call.callee as AstNode, bindings, ancestors, new Set());
}

function isFactoryExpression(
  expression: AstNode,
  bindings: IsomorphicBindings,
  ancestors: AstNode[],
  seen: Set<ConstantBinding>
): boolean {
  const callee = unwrapTSExpression(expression);
  if (
    callee.type === "Identifier" &&
    typeof callee.name === "string" &&
    bindings.named.has(callee.name) &&
    !hasShadowingDeclaration(callee.name, ancestors)
  ) {
    return true;
  }
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    const binding = resolveConstant(callee.name, bindings, ancestors);
    if (binding && !seen.has(binding)) {
      seen.add(binding);
      return isFactoryExpression(binding.initializer, bindings, binding.ancestors, seen);
    }
  }
  return (
    callee.type === "MemberExpression" &&
    (callee.object as AstNode).type === "Identifier" &&
    typeof (callee.object as AstNode).name === "string" &&
    bindings.namespaces.has((callee.object as AstNode).name as string) &&
    !hasShadowingDeclaration((callee.object as AstNode).name as string, ancestors) &&
    (callee.computed
      ? resolveStaticString(callee.property as AstNode, bindings, ancestors, new Set()) ===
        "createIsomorphicFn"
      : (callee.property as AstNode).type === "Identifier" &&
        (callee.property as AstNode).name === "createIsomorphicFn")
  );
}

function environmentMethod(
  node: AstNode,
  bindings: IsomorphicBindings,
  ancestors: AstNode[]
): IsomorphicEnvironment | undefined {
  if (node.type !== "CallExpression") {
    return;
  }
  const call = node as unknown as CallExpression;
  const { callee } = call;
  if (callee.type !== "MemberExpression") {
    return;
  }
  let method: string | undefined;
  if (callee.computed) {
    method = resolveStaticString(callee.property as AstNode, bindings, ancestors, new Set());
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
  ancestors: AstNode[]
): IsomorphicCandidate | null {
  let current = node as unknown as AstNode;
  let client: AstNode | undefined;
  let server: AstNode | undefined;

  for (;;) {
    const method = environmentMethod(current, bindings, ancestors);
    if (!method) {
      break;
    }
    const call = current as unknown as CallExpression;
    if (call.callee.type !== "MemberExpression") {
      return null;
    }
    const [implementation] = call.arguments as unknown as AstNode[];
    if (!implementation) {
      return null;
    }
    if (method === "client") {
      client ??= implementation;
    } else {
      server ??= implementation;
    }
    current = unwrapTSExpression(call.callee.object) as AstNode;
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
    const unwrapped = unwrapTSExpression(implementation) as AstNode;
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
      const candidate = parseCandidate(
        source,
        filename,
        node,
        bindings,
        context.ancestors() as AstNode[]
      );
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

function lexicalBindingScope(ancestors: AstNode[]): AstNode | undefined {
  return ancestors.findLast(
    (ancestor) =>
      ancestor.type === "Program" ||
      ancestor.type === "BlockStatement" ||
      ancestor.type === "SwitchStatement" ||
      ancestor.type === "ForStatement" ||
      ancestor.type === "ForInStatement" ||
      ancestor.type === "ForOfStatement" ||
      ancestor.type === "StaticBlock"
  );
}

function varBindingScope(ancestors: AstNode[]): AstNode | undefined {
  return ancestors.findLast((ancestor, index) => {
    if (ancestor.type === "Program" || ancestor.type === "StaticBlock") {
      return true;
    }
    if (ancestor.type !== "BlockStatement") {
      return false;
    }
    const parent = ancestors[index - 1];
    return (
      parent?.type === "FunctionDeclaration" ||
      parent?.type === "FunctionExpression" ||
      parent?.type === "ArrowFunctionExpression"
    );
  });
}

function collectBuilderBindings(
  program: Program,
  bindings: IsomorphicBindings
): IsomorphicBuilderBinding[] {
  const builders: IsomorphicBuilderBinding[] = [];

  walk(program, {
    VariableDeclarator(node, context) {
      if (!(node.id && node.init && typeof node.id === "object" && typeof node.init === "object")) {
        return;
      }
      const identifier = node.id as unknown as AstNode;
      const initializer = unwrapTSExpression(node.init) as AstNode;
      const ancestors = context.ancestors() as AstNode[];
      const declaration = ancestors.at(-1);
      const scope =
        declaration?.type === "VariableDeclaration" && declaration.kind === "var"
          ? varBindingScope(ancestors)
          : lexicalBindingScope(ancestors);
      if (
        scope &&
        identifier.type === "Identifier" &&
        typeof identifier.name === "string" &&
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
  ancestors: AstNode[],
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
        typeof node.object.name !== "string" ||
        !hasVisibleBuilder(node.object.name, context.ancestors() as AstNode[], builders) ||
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
  expression: AstNode,
  bindings: IsomorphicBindings,
  ancestors: AstNode[]
): boolean {
  let current = unwrapTSExpression(expression) as AstNode;
  for (;;) {
    if (isCreateIsomorphicCall(current, bindings, ancestors)) {
      return true;
    }
    if (current.type !== "CallExpression" || !environmentMethod(current, bindings, ancestors)) {
      return false;
    }
    const call = current as unknown as CallExpression;
    if (call.callee.type !== "MemberExpression") {
      return false;
    }
    current = unwrapTSExpression(call.callee.object) as AstNode;
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
      const ancestors = context.ancestors() as AstNode[];
      const splitBuilder =
        node.object.type === "Identifier" &&
        typeof node.object.name === "string" &&
        hasVisibleBuilder(node.object.name, ancestors, builders);
      if (
        !(
          splitBuilder ||
          chainStartsWithCreateIsomorphicFn(node.object as AstNode, bindings, ancestors)
        )
      ) {
        return;
      }
      const method = resolveStaticString(node.property as AstNode, bindings, ancestors, new Set());
      if (!splitBuilder && (method === "server" || method === "client")) {
        return;
      }
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, node.start)} createIsomorphicFn() requires static .server() and .client() methods.`
      );
    },
  });
}

function assertResolvedFactoryUses(
  program: Program,
  bindings: IsomorphicBindings,
  filename: string
): void {
  const inspect = (value: unknown, ancestors: AstNode[]): void => {
    const node = value as AstNode;
    const parent = ancestors.at(-1);
    if (
      parent?.type === "ImportSpecifier" ||
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
    if (!isFactoryExpression(node, bindings, ancestors, new Set())) {
      return;
    }
    let expression = node;
    let index = ancestors.length - 1;
    while (index >= 0 && unwrapTSExpression(ancestors[index] as AstNode) === expression) {
      expression = ancestors[index] as AstNode;
      index -= 1;
    }
    const owner = ancestors[index];
    if (owner?.type === "CallExpression" && owner.callee === expression) {
      return;
    }
    if (
      owner?.type === "VariableDeclarator" &&
      owner.init === expression &&
      (owner.id as AstNode)?.type === "Identifier" &&
      ancestors[index - 1]?.kind === "const"
    ) {
      return;
    }
    throw new Error(
      `[furin] ${filename}: createIsomorphicFn references must stay in statically resolvable fluent chains or constant aliases.`
    );
  };
  walk(program, {
    Identifier(node, context) {
      inspect(node, context.ancestors() as AstNode[]);
    },
    MemberExpression(node, context) {
      inspect(node, context.ancestors() as AstNode[]);
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
      const ancestors = context.ancestors() as AstNode[];
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
    (binding) =>
      !(
        used.has(binding) ||
        binding.ancestors.some((node) => node.type === "ExportNamedDeclaration")
      )
  );
  if (unused.length === 0) {
    return code;
  }
  const pruned = new MagicString(code);
  const removedDeclarations = new Set<AstNode>();
  for (const binding of unused) {
    const declaration = binding.ancestors.at(-1) as AstNode;
    if (removedDeclarations.has(declaration)) {
      continue;
    }
    removedDeclarations.add(declaration);
    const declarators = declaration.declarations as AstNode[];
    if (declarators.length === 1) {
      pruned.remove(declaration.start, declaration.end);
    } else {
      const index = declarators.indexOf(binding.declaration);
      const next = declarators[index + 1];
      const previous = declarators[index - 1];
      pruned.remove(
        next ? binding.declaration.start : (previous as AstNode).end,
        next ? next.start : binding.declaration.end
      );
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
    return { code: input, map: null, transformed: false };
  }
  const source = transformClientModules(input, filename, environment);
  const clientModulesTransformed = source !== input;

  const { program, diagnostics } = parseSource(source, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  const bindings = collectBindings(program);
  assertResolvedFactoryUses(program, bindings, filename);
  const builders = collectBuilderBindings(program, bindings);
  assertStaticEnvironmentMethods(source, filename, program, bindings, builders);
  assertNoSplitChains(source, filename, program, builders);
  const candidates = collectCandidates(source, filename, program, bindings);
  if (candidates.length === 0) {
    return { code: source, map: null, transformed: clientModulesTransformed };
  }

  const transformed = new MagicString(source);
  for (const candidate of candidates) {
    const implementation = candidate[environment];
    transformed.overwrite(
      candidate.start,
      candidate.end,
      implementation
        ? `(${source.slice(implementation.start, implementation.end)})`
        : "(() => undefined)"
    );
  }

  const aliasesPruned = new MagicString(pruneFactoryAliases(transformed.toString(), filename));
  const pruned = deadCodeElimination(aliasesPruned, source, lang);
  return {
    code: pruned.toString(),
    map: pruned.generateMap({ includeContent: true, source: filename }),
    transformed: true,
  };
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
