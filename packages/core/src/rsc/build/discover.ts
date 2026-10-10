import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { Node } from "yuku-parser";
import { CLIENT_MODULE_PATH, LINK_MODULE_PATH } from "../../build/shared.ts";
import { hasShadowingDeclaration } from "../../plugin/binding-scope.ts";
import { deadCodeElimination } from "../../plugin/dead-code-elimination.ts";
import {
  isomorphicTransformPlugin,
  transformIsomorphicFunctions,
} from "../../plugin/transform-isomorphic.ts";
import { detectLangFromPath, detectLoaderFromPath } from "../../server/lang-detect.ts";
import { parseSource } from "../../shared/parser.ts";
import type { AstNode } from "../../shared/utils/ast-walk.ts";
import { registerClientModule } from "../client-references.ts";
import { clientModuleId, isClientModule } from "./client-references.ts";

export interface ClientBoundary {
  id: string;
  path: string;
}

/** Reexported functions can retain the identity of their original client module. */
function reexportedDependencies(source: string, path: string): Set<string> {
  const { program } = parseSource(source, detectLangFromPath(path));
  const imports = new Map<string, string>();
  const aliases = new Map<string, Node>();
  const exported: Node[] = [];
  const dependencies = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind !== "type") {
          imports.set(specifier.local.name, String(statement.source.value));
        }
      }
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const binding of declaration.declarations) {
        const initializer = binding.init;
        if (initializer) {
          walk(binding.id, {
            Identifier(node) {
              aliases.set(node.name, initializer);
            },
          });
          if (statement.type === "ExportNamedDeclaration") {
            exported.push(initializer);
          }
        }
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      exported.push(statement.declaration);
    }
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") {
        continue;
      }
      if (statement.source) {
        dependencies.add(String(statement.source.value));
      } else if (statement.type === "ExportNamedDeclaration") {
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") {
            exported.push(specifier.local);
          }
        }
      }
    }
  }
  walk(program, {
    AssignmentExpression(node, context) {
      let target: Node = node.left;
      while (target.type === "MemberExpression") {
        target = target.object;
      }
      if (
        target.type === "Identifier" &&
        (target.name === "module" || target.name === "exports") &&
        !hasShadowingDeclaration(target.name, context.ancestors() as AstNode[])
      ) {
        exported.push(node.right);
      }
    },
  });
  const visit = (expression: Node, seen: Set<string>): void => {
    walk(expression, {
      Function(_node, context) {
        context.skip();
      },
      Class(_node, context) {
        context.skip();
      },
      TSType(_node, context) {
        context.skip();
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          !aliases.has("require") &&
          !imports.has("require")
        ) {
          const [argument] = node.arguments;
          if (argument?.type === "Literal" && typeof argument.value === "string") {
            dependencies.add(argument.value);
          }
        }
      },
      Identifier(node, context) {
        const parent = context.parent;
        if (
          seen.has(node.name) ||
          (parent?.type === "MemberExpression" && !parent.computed && parent.property === node) ||
          (parent?.type === "Property" &&
            !parent.computed &&
            !parent.shorthand &&
            parent.key === node)
        ) {
          return;
        }
        seen.add(node.name);
        const dependency = imports.get(node.name);
        const alias = aliases.get(node.name);
        if (dependency) {
          dependencies.add(dependency);
        } else if (alias) {
          visit(alias, seen);
        }
      },
    });
  };
  for (const expression of exported) {
    visit(expression, new Set());
  }
  return dependencies;
}

/** Route views already belong to the ordinary browser graph. */
function stripRouteView(source: string, path: string): string {
  const lang = detectLangFromPath(path);
  const { program } = parseSource(source, lang);
  const transformed = new MagicString(source);
  for (const statement of program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      const call = declaration.init;
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== "route" ||
        call?.type !== "CallExpression"
      ) {
        continue;
      }
      const { callee } = call;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        (callee.property.name !== "page" && callee.property.name !== "layout")
      ) {
        continue;
      }
      const [view] = call.arguments;
      if (view !== undefined) {
        transformed.overwrite(view.start, view.end, "() => null");
      }
    }
  }
  return deadCodeElimination(transformed, source, lang).toString();
}

/** Scan the unstripped server graph: loader-only imports also need browser chunks. */
export async function discoverClientBoundaries(
  entrypoints: string[],
  plugins: Bun.BunPlugin[] | undefined
): Promise<ClientBoundary[]> {
  const paths = new Set<string>();
  const reexports = new Map<string, Set<string>>();
  const routePaths = new Set(entrypoints.map((path) => path.replaceAll("\\", "/")));
  const result = await Bun.build({
    entrypoints,
    target: "bun",
    plugins: [
      {
        name: "furin-discover-client-boundaries",
        setup(build) {
          // Styles do not contain client boundaries. Leave CSS processing to the
          // actual browser build, which has the application's CSS plugins.
          build.onLoad({ filter: /\.css$/ }, () => ({
            contents: "export default {};",
            loader: "js",
          }));
          // Ordinary imports belong to the boundary's browser graph. Reexports
          // also need loaders for the original functions' canonical identities.
          build.onResolve({ filter: /.*/ }, ({ importer, path }) => {
            if (paths.has(importer) && !reexports.get(importer)?.has(path)) {
              return { path, external: true };
            }
          });
          build.onResolve({ filter: /^(?:@teyik0\/)?furin(?:\/.*)?$/ }, ({ path }) => {
            if (path.endsWith("/link")) {
              return { path: LINK_MODULE_PATH };
            }
            if (path.endsWith("/client")) {
              return { path: CLIENT_MODULE_PATH };
            }
            return { path, external: true };
          });
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            if (isClientModule(source, path)) {
              paths.add(path);
              reexports.set(path, reexportedDependencies(source, path));
            }
            if (routePaths.has(path.replaceAll("\\", "/"))) {
              return {
                contents: transformIsomorphicFunctions(stripRouteView(source, path), path, "server")
                  .code,
                loader: detectLoaderFromPath(path),
              };
            }
          });
        },
      },
      ...(plugins ?? []),
      isomorphicTransformPlugin("server"),
    ],
    external: ["react", "react-dom", "elysia", "evlog"],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "[furin/rsc] Client boundary discovery failed");
  }
  return [...paths]
    .map((path) => path.replaceAll("\\", "/"))
    .toSorted()
    .map((path) => ({ id: clientModuleId(path), path }));
}

export async function registerServerBoundaries(
  boundaries: readonly ClientBoundary[]
): Promise<void> {
  for (const { id, path } of boundaries) {
    registerClientModule(id, (await import(path)) as object);
  }
}
