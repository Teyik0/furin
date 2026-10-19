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
import { isRemoved, type ModuleTransform, type SourceRange } from "./module-transform.ts";
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
  /** Names the retained remount policy references. */
  retained: Set<string>;
}

/** Drops a server stage, keeping only a `.config()` call's remount policy. */
function stripServerStage(
  module: ModuleTransform,
  stripped: StrippedCode,
  range: SourceRange,
  remount: Node | null
): void {
  const { removed, source } = module;
  if (remount) {
    // The policy as edited so far: an isomorphic chain in it is already selected.
    const policy = source.slice(remount.start, remount.end);
    for (const name of referencedNames(remount, removed)) {
      stripped.retained.add(name);
    }
    // overwrite, not update: update keeps the text earlier steps inserted in the range.
    source.overwrite(range.start, range.end, `.config({ ${policy} })`);
  } else {
    source.remove(range.start, range.end);
  }
  removed.push(range);
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
    stripServerStage(module, stripped, { end: call.end, start: accessStart }, remount);
    transformed = true;
  }
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
