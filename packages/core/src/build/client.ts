import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { transformForClient } from "../plugin/transform-client";
import { createRoutesPlugin } from "../plugin/routes.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import type { ResolvedRoute } from "../server/router/types.ts";
import { runBunBuild } from "./bun-build.ts";
import { generateHydrateEntry } from "./hydrate";
import { CLIENT_MODULE_PATH, LINK_MODULE_PATH, SEARCH_MODULE_PATH } from "./shared";
import type { BuildClientOptions, BunBuildAliasConfig } from "./types";

const SCRIPT_FILE_FILTER = /\.(tsx?|jsx?)$/;

export interface BuildClientResult {
  /** Public paths of all CSS chunks, e.g. `["/_client/chunk-abc.css"]` */
  cssChunks: string[];
  /** Public path of the JS entry chunk, e.g. `/_client/chunk-abc.js` */
  entryChunk: string;
}

/**
 * Builds the production client bundle via Bun.build() using _hydrate.tsx as
 * the JS entrypoint (NOT an HTML entrypoint). Bun produces:
 *   <outDir>/client/chunk-*.js  — code-split bundles
 *   <outDir>/client/chunk-*.css — extracted CSS (if imported)
 *
 * Returns the chunk paths so the caller can compute a `buildId` and write
 * `index.html` with the correct meta tag. Using an HTML entrypoint with
 * code-splitting causes a Bun bug where the output index.html references a
 * leaf chunk instead of the actual entry chunk, preventing React from mounting
 * in production.
 *
 * The output index.html is NOT served to browsers directly. The server reads
 * it as an SSR template, injects the pre-rendered React HTML into
 * <!--ssr-outlet-->, and sends the complete page.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  {
    outDir,
    rootLayout,
    plugins,
    publicPath,
    basePath,
    clientLogging,
    clientDirName,
    pagesDir,
  }: BuildClientOptions
): Promise<BuildClientResult> {
  // Per-app client dir so several mounted apps build side by side
  // ("client", "client-admin", …) without clobbering each other.
  const dirName = clientDirName ?? "client";
  const clientDir = join(outDir, dirName);

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout, basePath, clientLogging);
  const hydratePath = join(
    outDir,
    dirName === "client" ? "_hydrate.tsx" : `_hydrate-${dirName}.tsx`
  );
  writeFileSync(hydratePath, hydrateCode);

  console.log("[furin] Building production client bundle…");

  const transformPlugin: Bun.BunPlugin = {
    name: "furin-transform-client",
    setup(build) {
      build.onLoad({ filter: SCRIPT_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return;
        }

        const code = await Bun.file(path).text();
        const result = transformForClient(code, path);
        // transformForClient now emits TS/TSX directly (no pre-transpile),
        // so JSX → React handling is delegated to Bun.build's loader, which
        // applies the project tsconfig's automatic runtime by default.
        const transformed = result.code
          .replaceAll(`"@teyik0/furin/client"`, JSON.stringify(CLIENT_MODULE_PATH))
          .replaceAll(`'furin/client'`, JSON.stringify(CLIENT_MODULE_PATH))
          .replaceAll(`"@teyik0/furin/link"`, JSON.stringify(LINK_MODULE_PATH))
          .replaceAll(`'furin/link'`, JSON.stringify(LINK_MODULE_PATH))
          .replaceAll(`"@teyik0/furin/search"`, JSON.stringify(SEARCH_MODULE_PATH))
          .replaceAll(`'furin/search'`, JSON.stringify(SEARCH_MODULE_PATH));

        return {
          contents: transformed,
          loader: detectLoaderFromPath(path),
        };
      });
    },
  };

  const clientBuildConfig: BunBuildAliasConfig = {
    // Use the JS file as entrypoint — NOT an HTML file. Bun's HTML bundler
    // with code-splitting incorrectly references a leaf chunk in the output
    // index.html instead of the actual entry chunk, preventing React from
    // mounting. We write index.html ourselves after the build.
    entrypoints: [hydratePath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    sourcemap: "none",
    // Hash the entry point name so it gets immutable caching like chunks.
    // Without this, _hydrate.js keeps the same name across builds and browsers
    // serve stale versions that reference old chunk hashes → dynamic import 404.
    naming: {
      entry: "[dir]/[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
    },
    // Absolute public path so SSR template asset URLs resolve on any route.
    // Overridable via the `publicPath` option (e.g. "/furin/_client/" for basePath builds).
    publicPath,
    // User plugins run before the internal transform so they pre-process files first
    plugins: [
      ...(plugins ?? []),
      ...(pagesDir
        ? [createRoutesPlugin({ instances: [{ pagesDir, prefix: basePath }], target: "client" })]
        : []),
      environmentGuardPlugin("client"),
      transformPlugin,
    ],
    alias: {
      "@teyik0/furin/client": CLIENT_MODULE_PATH,
      "@teyik0/furin/link": LINK_MODULE_PATH,
      "@teyik0/furin/search": SEARCH_MODULE_PATH,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const result = await runBunBuild(clientBuildConfig);
  for (const output of result.outputs) {
    console.log(`[furin]   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  // Build index.html (SSR template) with correct chunk references.
  // We derive these from result.outputs rather than letting Bun write the HTML,
  // because Bun's HTML entrypoint + code-splitting produces the wrong entry chunk.
  const entryOutput = result.outputs.find((o) => o.kind === "entry-point");
  const cssOutputs = result.outputs.filter(
    (o) => o.path.endsWith(".css") && !o.path.endsWith(".css.map")
  );
  if (!entryOutput) {
    throw new Error("[furin] client build did not emit entry chunk");
  }

  // Normalise: ensure publicPath ends with exactly one "/".
  // Preserve an empty publicPath ("") as-is so callers that want
  // relative chunk URLs don't get an unintended root-absolute "/".
  let publicPrefix: string;
  if (publicPath === "") {
    publicPrefix = "";
  } else {
    publicPrefix = publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
  }
  const entryChunk = `${publicPrefix}${basename(entryOutput.path)}`;
  const cssChunks = cssOutputs.map((o) => `${publicPrefix}${basename(o.path)}`);

  console.log("[furin] Production client build complete");
  return { entryChunk, cssChunks };
}
