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

const FURIN_MODULES = new Set(["@teyik0/furin", "furin"]);
const SCRIPT_FILE_FILTER = /^(?!.*(?:node_modules|[\\/]\.furin[\\/]build[\\/])).*\.(tsx?|jsx?)$/;

export type IsomorphicEnvironment = "client" | "server";

export interface IsomorphicTransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  transformed: boolean;
}

interface IsomorphicBindings {
  named: Set<string>;
  namespaces: Set<string>;
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

  return bindings;
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
  if (
    call.callee.type === "Identifier" &&
    typeof call.callee.name === "string" &&
    bindings.named.has(call.callee.name) &&
    !hasShadowingDeclaration(call.callee.name, ancestors)
  ) {
    return true;
  }
  const { callee } = call;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    typeof callee.object.name === "string" &&
    bindings.namespaces.has(callee.object.name) &&
    !hasShadowingDeclaration(callee.object.name, ancestors) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "createIsomorphicFn"
  );
}

function environmentMethod(node: AstNode): IsomorphicEnvironment | undefined {
  if (node.type !== "CallExpression") {
    return;
  }
  const call = node as unknown as CallExpression;
  const { callee } = call;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier"
  ) {
    return;
  }
  return callee.property.name === "client" || callee.property.name === "server"
    ? callee.property.name
    : undefined;
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
    const method = environmentMethod(current);
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
    const unwrappedImplementation = unwrapTSExpression(implementation) as AstNode;
    if (
      unwrappedImplementation.type !== "ArrowFunctionExpression" &&
      unwrappedImplementation.type !== "FunctionExpression" &&
      unwrappedImplementation.type !== "Identifier"
    ) {
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, implementation.start)} createIsomorphicFn().${method}() must receive a function.`
      );
    }
    if (method === "client") {
      client = implementation;
    } else {
      server = implementation;
    }
    current = unwrapTSExpression(call.callee.object) as AstNode;
  }

  if (!isCreateIsomorphicCall(current, bindings, ancestors)) {
    return null;
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
    if (current.type !== "CallExpression" || !environmentMethod(current)) {
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
      if (!node.computed || node.property.type !== "Literal") {
        return;
      }
      if (node.property.value !== "server" && node.property.value !== "client") {
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
      throw new Error(
        `[furin] ${filename}:${sourcePosition(source, node.start)} createIsomorphicFn() requires static .server() and .client() methods.`
      );
    },
  });
}

export function transformIsomorphicFunctions(
  source: string,
  filename: string,
  environment: IsomorphicEnvironment
): IsomorphicTransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code: source, map: null, transformed: false };
  }

  const { program, diagnostics } = parseSource(source, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  const bindings = collectBindings(program);
  const builders = collectBuilderBindings(program, bindings);
  assertStaticEnvironmentMethods(source, filename, program, bindings, builders);
  assertNoSplitChains(source, filename, program, builders);
  const candidates = collectCandidates(source, filename, program, bindings);
  if (candidates.length === 0) {
    return { code: source, map: null, transformed: false };
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

  const pruned = deadCodeElimination(transformed, source, lang);
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
      build.onLoad({ filter: SCRIPT_FILE_FILTER }, async ({ path }) => {
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
