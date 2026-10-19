import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { Node, Program } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import type { IsomorphicEnvironment } from "./transform-isomorphic.ts";

const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);
const SERVER_LOAD =
  '() => Promise.reject(new Error("[furin] clientModule() can only be loaded in the browser."))';

/**
 * Stable key shared by the `clientModule()` transform and the client build's
 * preload manifest. It is an opaque ASCII token so it survives minification
 * unchanged and can be swapped for the module's chunk URLs after the build.
 */
export function clientModuleKey(modulePath: string): string {
  const realPath = realpathSync(modulePath).replaceAll("\\", "/");
  return `__FURIN_CLIENT_MODULE_${Bun.hash(realPath).toString(36)}__`;
}

function collectClientModuleBindings(program: Program): Set<string> {
  const bindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    if (
      statement.importKind === "type" ||
      !FURIN_CLIENT_MODULES.has(String(statement.source.value))
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "clientModule"
      ) {
        bindings.add(specifier.local.name);
      }
    }
  }
  return bindings;
}

/** Returns the `import("…")` specifier of a `() => import("…")` loader. */
function dynamicImportSpecifier(loader: Node): string | null {
  if (loader.type !== "ArrowFunctionExpression" || loader.params.length > 0) {
    return null;
  }
  const { body } = loader;
  const source = body.type === "ImportExpression" ? body.source : null;
  return source?.type === "Literal" && typeof source.value === "string" ? source.value : null;
}

/**
 * Rewrites `clientModule(() => import("./x"))` calls imported from
 * `@teyik0/furin/client`:
 * - client: keeps the loader and appends the module key, which the production
 *   client build replaces with the module's chunk URLs;
 * - server: drops the `import()` so the module is never bundled server-side and
 *   passes the key, resolved against the preload manifest at render time.
 */
export function transformClientModules(
  source: string,
  filename: string,
  environment: IsomorphicEnvironment
): string {
  return transformClientModuleSource(source, filename, environment).toString();
}

export function transformClientModuleSource(
  source: string,
  filename: string,
  environment: IsomorphicEnvironment
): MagicString {
  const transformed = new MagicString(source);
  if (!source.includes("clientModule")) {
    return transformed;
  }
  const { program } = parseSource(source, detectLangFromPath(filename));
  const bindings = collectClientModuleBindings(program);
  if (bindings.size === 0) {
    return transformed;
  }

  walk(program, {
    CallExpression(call, context) {
      const [loader, ...rest] = call.arguments;
      if (
        call.callee.type !== "Identifier" ||
        !bindings.has(call.callee.name) ||
        hasShadowingDeclaration(call.callee.name, context.ancestors()) ||
        !loader ||
        rest.length > 0
      ) {
        return;
      }
      const unwrapped = unwrapTSExpression(loader);
      const specifier = dynamicImportSpecifier(unwrapped);
      if (specifier === null) {
        return;
      }
      let key: string;
      try {
        key = JSON.stringify(clientModuleKey(Bun.resolveSync(specifier, dirname(filename))));
      } catch (error) {
        throw new Error(
          `[furin] Cannot resolve clientModule import ${JSON.stringify(specifier)} in ${filename}`,
          { cause: error }
        );
      }
      if (environment === "client") {
        transformed.appendLeft(loader.end, `, ${key}`);
      } else {
        transformed.overwrite(loader.start, loader.end, `${SERVER_LOAD}, ${key}`);
      }
    },
  });
  return transformed;
}
