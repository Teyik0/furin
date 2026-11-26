import type MagicString from "magic-string";
import type { Expression, Node, Program } from "yuku-parser";
import type { FactoryBindings } from "./binding-scope.ts";
import { referencedNames } from "./dead-code-elimination.ts";
import {
  collectModuleBindings,
  importedName,
  type LocalDeclaration,
  localName,
  unwrapped,
} from "./module-bindings.ts";
import {
  isRemoved,
  type ModuleTransform,
  removeRange,
  replaceRange,
  type SourceRange,
} from "./module-transform.ts";
import { FURIN_SERVER_MODULES, type RouteChains } from "./route-chains.ts";

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

function memberAccessStart(source: string, object: Node, property: Node): number {
  // Parser expression ranges exclude parentheses around a fluent receiver.
  const accessGap = source.slice(object.end, property.start);
  const separator = accessGap
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (comment) => " ".repeat(comment.length))
    .lastIndexOf(".");
  return object.end + separator - (accessGap[separator - 1] === "?" ? 1 : 0);
}

export interface StrippedCode {
  /** Config bindings the stripped `.config()` calls referenced. */
  configBindings: Set<string>;
  /** Names the retained client policies reference. */
  retained: Set<string>;
}

/** Drops a server stage, keeping only a `.config()` call's client policies. */
function stripServerStage(
  module: ModuleTransform,
  stripped: StrippedCode,
  range: SourceRange,
  policies: Node[]
): void {
  const { removed, source } = module;
  if (policies.length > 0) {
    // The policies as edited so far: an isomorphic chain in them is already selected.
    const retained = policies.map((policy) => source.slice(policy.start, policy.end));
    for (const policy of policies) {
      for (const name of referencedNames(policy, removed)) {
        stripped.retained.add(name);
      }
    }
    // overwrite, not update: update keeps the text earlier steps inserted in the range.
    replaceRange(module, range.start, range.end, `.config({ ${retained.join(", ")} })`);
  } else {
    removeRange(module, range.start, range.end);
  }
}

export function removeChainedServerCalls(
  module: ModuleTransform,
  bindings: FactoryBindings,
  chains: RouteChains,
  stripped: StrippedCode
): boolean {
  const { filename, program, source } = module;
  let transformed = rewriteClientImports(source, program, bindings);
  const { declarations } = collectModuleBindings(program);

  for (const { call, object, property } of chains.serverStages) {
    if (isRemoved(call, module.removed)) {
      continue;
    }
    let policies: Node[] = [];
    if (property.name === "config" && Array.isArray(call.arguments)) {
      const config = unwrapped(call.arguments[0]);
      if (config?.type === "ObjectExpression" && Array.isArray(config.properties)) {
        collectConfigBindings(config, declarations, stripped.configBindings);
        policies = clientPolicies(config, declarations, stripped.configBindings, filename);
      }
    }
    const accessStart = memberAccessStart(source.original, object, property);
    stripServerStage(module, stripped, { end: call.end, start: accessStart }, policies);
    transformed = true;
  }
  return transformed;
}

/** The `.config()` properties the browser keeps: `loaderDeps`, then `remountDeps`. */
function clientPolicies(
  config: Node,
  declarations: Map<string, LocalDeclaration>,
  configBindings: Set<string>,
  filename: string
): Node[] {
  const resolve = (name: string) =>
    resolveConfigProperty(config, name, declarations, configBindings, new Set());
  // Loader deps behind an unresolvable spread only cost the in-place optimisation.
  const loaderDeps = resolve("loaderDeps");
  const remount = resolve("remountDeps");
  if (remount === UNRESOLVED) {
    throw new Error(
      `[furin] ${filename}: route config spreads must resolve to local object literals; declare remountDeps after dynamic spreads.`
    );
  }
  const policies: Node[] = [];
  if (loaderDeps !== null && loaderDeps !== UNRESOLVED) {
    policies.push(loaderDeps);
  }
  if (remount !== null) {
    policies.push(remount);
  }
  return policies;
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

/** A spread the plugin cannot read may hide the property. */
const UNRESOLVED: unique symbol = Symbol("unresolved");

/** The config property `name` resolves to, in object spread order. */
function resolveConfigProperty(
  config: Node | null,
  name: string,
  declarations: Map<string, LocalDeclaration>,
  configBindings: Set<string>,
  visiting: Set<string>
): Node | null | typeof UNRESOLVED {
  if (config?.type === "Identifier" && !visiting.has(config.name)) {
    visiting.add(config.name);
    configBindings.add(config.name);
    const declaration = declarations.get(config.name);
    const result = resolveConfigProperty(
      declaredInitializer(declaration),
      name,
      declarations,
      configBindings,
      visiting
    );
    visiting.delete(config.name);
    return result;
  }
  if (config?.type !== "ObjectExpression" || !Array.isArray(config.properties)) {
    return UNRESOLVED;
  }
  for (let index = config.properties.length - 1; index >= 0; index -= 1) {
    const entry = unwrapped(config.properties[index]);
    if (entry?.type === "SpreadElement") {
      const property = resolveConfigProperty(
        unwrapped(entry.argument),
        name,
        declarations,
        configBindings,
        visiting
      );
      if (property) {
        return property;
      }
    } else if (entry?.type === "Property") {
      const key = unwrapped(entry.key);
      if (
        (key?.type === "Identifier" && entry.computed !== true && key.name === name) ||
        (key?.type === "Literal" && key.value === name)
      ) {
        return entry;
      }
    }
  }
  return null;
}
