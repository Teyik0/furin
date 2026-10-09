import MagicString from "magic-string";
import { CLIENT_MODULE_PATH, LINK_MODULE_PATH } from "../../build/shared.ts";
import { deadCodeElimination } from "../../plugin/dead-code-elimination.ts";
import {
  isomorphicTransformPlugin,
  transformIsomorphicFunctions,
} from "../../plugin/transform-isomorphic.ts";
import { detectLangFromPath, detectLoaderFromPath } from "../../server/lang-detect.ts";
import { parseSource } from "../../shared/parser.ts";
import { registerClientModule } from "../client-references.ts";
import { clientModuleId, isClientModule } from "./client-references.ts";

export interface ClientBoundary {
  id: string;
  path: string;
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
          // Imports beneath a client boundary belong to its browser graph.
          // Registering them separately would retain all their unused exports.
          build.onResolve({ filter: /.*/ }, ({ importer, path }) => {
            if (paths.has(importer)) {
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
