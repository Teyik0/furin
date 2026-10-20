import type { ImportDeclaration, Node, Program } from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";
import { isNode } from "../shared/utils/ast-walk.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import { hmrDependencySignature } from "./hmr-dependencies.ts";
import {
  collectModuleBindings,
  isReferenceIdentifier,
  type LocalDeclaration,
  unwrapped,
} from "./module-bindings.ts";
import type { ServerStage } from "./route-chains.ts";

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

export function createHmrDataSignature(
  code: string,
  program: Program,
  serverStages: ServerStage[],
  filename: string
): string {
  const stageSources: Array<{ source: string; start: number }> = [];
  const dependencyState: HmrDependencyState = {
    dependencies: new Map(),
    dynamicImports: new Set(),
    imports: new Set(),
    importTrackedDependencies: new Set(),
    moduleBindings: collectModuleBindings(program),
  };

  for (const { call, object, property } of serverStages) {
    stageSources.push({
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
  }

  const dataSource = [
    ...stageSources,
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
