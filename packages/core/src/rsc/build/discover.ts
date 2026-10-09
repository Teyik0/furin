import { CLIENT_MODULE_PATH, LINK_MODULE_PATH } from "../../build/shared.ts";
import { isomorphicTransformPlugin } from "../../plugin/transform-isomorphic.ts";
import { registerClientModule } from "../client-references.ts";
import { clientModuleId, isClientModule } from "./client-references.ts";

export interface ClientBoundary {
  id: string;
  path: string;
}

/** Scan the unstripped server graph: loader-only imports also need browser chunks. */
export async function discoverClientBoundaries(
  entrypoints: string[],
  plugins: Bun.BunPlugin[] | undefined
): Promise<ClientBoundary[]> {
  const paths = new Set<string>();
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
            if (isClientModule(await Bun.file(path).text(), path)) {
              paths.add(path);
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
  return [...paths].toSorted().map((path) => ({ id: clientModuleId(path), path }));
}

export async function registerServerBoundaries(
  boundaries: readonly ClientBoundary[]
): Promise<void> {
  for (const { id, path } of boundaries) {
    registerClientModule(id, (await import(path)) as object);
  }
}
