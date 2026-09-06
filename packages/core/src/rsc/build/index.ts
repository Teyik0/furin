import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBunBuild } from "../../build/bun-build.ts";
import { isomorphicTransformPlugin } from "../../plugin/transform-isomorphic.ts";
import type { ResolvedRoute, RootLayout } from "../../server/router/types.ts";
import { assertInstalledRscVersions } from "../version.ts";
import { environmentGuardPlugin } from "./environment.ts";

export interface ClientReference {
  chunks: readonly string[];
  id: string;
  name: string;
}

export interface RscCssAsset {
  href: string;
}

export interface RscManifest {
  buildId: string;
  clientReferences: readonly ClientReference[];
  css: readonly RscCssAsset[];
}

export async function buildRscGraph(
  routes: ResolvedRoute[],
  root: RootLayout,
  outDir: string,
  buildId: string,
  userPlugins: Bun.BunPlugin[] | undefined
): Promise<RscManifest> {
  await assertInstalledRscVersions();
  const graphDir = join(outDir, "rsc");
  mkdirSync(graphDir, { recursive: true });
  const rscEntry = fileURLToPath(import.meta.resolve("../../rsc-server.tsx"));
  const aliasPlugin: Bun.BunPlugin = {
    name: "furin-rsc-entry",
    setup(build) {
      build.onResolve({ filter: /^(?:@teyik0\/)?furin(?:\/.*)?$/ }, ({ path }) => {
        if (path === "furin/rsc" || path === "@teyik0/furin/rsc") {
          return { path: rscEntry };
        }
        return { path, external: true };
      });
    },
  };
  const result = await runBunBuild({
    entrypoints: [root.path, ...routes.map((route) => route.path)],
    outdir: graphDir,
    target: "bun",
    format: "esm",
    splitting: true,
    conditions: ["react-server"],
    naming: { entry: "[dir]/[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    plugins: [
      ...(userPlugins ?? []),
      isomorphicTransformPlugin("server"),
      environmentGuardPlugin("rsc"),
      aliasPlugin,
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    throw new Error(
      `[furin] RSC graph build failed.\n${result.logs.map((log) => log.message).join("\n")}`
    );
  }
  const codecResult = await runBunBuild({
    entrypoints: [fileURLToPath(import.meta.resolve("../server-codec.ts"))],
    outdir: outDir,
    target: "bun",
    format: "esm",
    conditions: ["react-server"],
    naming: "server-codec.js",
    plugins: [
      ...(userPlugins ?? []),
      isomorphicTransformPlugin("server"),
      environmentGuardPlugin("rsc"),
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!codecResult.success) {
    throw new Error(
      `[furin] Flight codec build failed.\n${codecResult.logs.map((log) => log.message).join("\n")}`
    );
  }
  const css = result.outputs
    .filter((output) => output.path.endsWith(".css"))
    .map((output) => ({ href: `/_rsc/${basename(output.path)}` }));
  const manifest: RscManifest = { buildId, clientReferences: [], css };
  writeFileSync(join(graphDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
