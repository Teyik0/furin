import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_DEFINE, runBunBuild } from "../../build/bun-build.ts";
import { CLIENT_MODULE_PATH, LINK_MODULE_PATH } from "../../build/shared.ts";
import { isomorphicTransformPlugin } from "../../plugin/transform-isomorphic.ts";
import type { ResolvedRoute, RootLayout } from "../../server/router/types.ts";
import { assertInstalledRscVersions } from "../version.ts";
import { rscClientReferencesPlugin } from "./client-references.ts";
import { environmentGuardPlugin } from "./environment.ts";

export interface ClientReference {
  chunks: readonly string[];
  id: string;
  name: string;
}

interface RscCssAsset {
  href: string;
}

export interface RscManifest {
  buildId: string;
  clientReferences: readonly ClientReference[];
  css: readonly RscCssAsset[];
}

export interface RscBuildApp {
  root: RootLayout;
  routes: ResolvedRoute[];
}

export async function buildRscGraph(
  apps: RscBuildApp[],
  outDir: string,
  buildId: string,
  userPlugins: Bun.BunPlugin[] | undefined
): Promise<RscManifest> {
  await assertInstalledRscVersions();
  const graphDir = join(outDir, "rsc");
  mkdirSync(graphDir, { recursive: true });
  const rscEntry = fileURLToPath(import.meta.resolve("../../rsc-server.tsx"));
  const entrypoints = [
    ...new Set(
      apps.flatMap(({ root, routes }) => [root.path, ...routes.map((route) => route.path)])
    ),
  ];
  const aliasPlugin: Bun.BunPlugin = {
    name: "furin-rsc-entry",
    setup(build) {
      build.onResolve({ filter: /^(?:@teyik0\/)?furin(?:\/.*)?$/ }, ({ path }) => {
        if (path === "furin/rsc" || path === "@teyik0/furin/rsc") {
          return { path: rscEntry };
        }
        if (path.endsWith("/link")) {
          return { path: LINK_MODULE_PATH };
        }
        if (path.endsWith("/client")) {
          return { path: CLIENT_MODULE_PATH };
        }
        return { path, external: true };
      });
    },
  };
  // Both builds run in the react-server graph with the same transforms.
  const reactServerBuild = {
    conditions: ["react-server"],
    define: PRODUCTION_DEFINE,
    format: "esm",
    target: "bun",
  } satisfies Partial<Bun.BuildConfig>;
  const reactServerPlugins = () => [isomorphicTransformPlugin("server"), environmentGuardPlugin("rsc")];
  const clientReferences: ClientReference[] = [];
  const result = await runBunBuild({
    ...reactServerBuild,
    entrypoints,
    outdir: graphDir,
    splitting: true,
    naming: { entry: "[dir]/[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    plugins: [
      ...(userPlugins ?? []),
      rscClientReferencesPlugin(clientReferences),
      ...reactServerPlugins(),
      aliasPlugin,
    ],
  });
  if (!result.success) {
    throw new Error(
      `[furin] RSC graph build failed.\n${result.logs.map((log) => log.message).join("\n")}`
    );
  }
  const codecResult = await runBunBuild({
    ...reactServerBuild,
    entrypoints: [fileURLToPath(import.meta.resolve("../server-codec.ts"))],
    outdir: outDir,
    naming: "server-codec.js",
    plugins: [...(userPlugins ?? []), ...reactServerPlugins()],
  });
  if (!codecResult.success) {
    throw new Error(
      `[furin] Flight codec build failed.\n${codecResult.logs.map((log) => log.message).join("\n")}`
    );
  }
  const css = result.outputs
    .filter((output) => output.path.endsWith(".css"))
    .map((output) => ({ href: `/_rsc/${basename(output.path)}` }));
  const manifest: RscManifest = { buildId, clientReferences, css };
  writeFileSync(join(graphDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
