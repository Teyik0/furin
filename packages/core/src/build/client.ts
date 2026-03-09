import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformForClient } from "../plugin/transform-client";
import { generateIndexHtml } from "../render/shell";
import type { ResolvedRoute } from "../router";
import { generateHydrateEntry } from "./hydrate";
import { writeRouteTypes } from "./route-types";
import { CLIENT_MODULE_PATH, LINK_MODULE_PATH, rewriteFrameworkImports } from "./shared";
import type { BunBuildAliasConfig, BuildClientOptions } from "./types";

const TS_FILE_FILTER = /\.(tsx|ts)$/;
const REACT_IMPORT_RE = /import\s+React\b/;

/**
 * Builds the production client bundle via Bun.build() using the generated
 * index.html as the HTML entrypoint. Bun produces:
 *   <outDir>/client/index.html  — processed template with hashed chunk paths
 *   <outDir>/client/chunk-*.js  — code-split bundles
 *   <outDir>/client/styles.css  — CSS (if imported)
 *
 * The output index.html is NOT served to browsers directly. The server reads
 * it as an SSR template, injects the pre-rendered React HTML into
 * <!--ssr-outlet-->, and sends the complete page.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  {outDir, rootLayout}: BuildClientOptions
): Promise<void> {
  const clientDir = join(outDir, "client");

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout);
  const hydratePath = join(outDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  writeFileSync(indexPath, indexHtml);

  writeRouteTypes(routes, outDir);

  console.log("[elyra] Building production client bundle…");

  const transformPlugin: Bun.BunPlugin = {
    name: "elyra-transform-client",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const code = await Bun.file(path).text();
        try {
          const result = transformForClient(code, path);
          let transformed = result.code;

          if (transformed.includes("React.createElement") && !REACT_IMPORT_RE.test(transformed)) {
            transformed = `import React from "react";\n${transformed}`;
          }

          transformed = rewriteFrameworkImports(transformed);

          return {
            contents: transformed,
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
          };
        } catch (error) {
          console.error(`[elyra] Transform error for ${path}:`, error);
          return undefined;
        }
      });
    },
  };

  const clientBuildConfig: BunBuildAliasConfig = {
    entrypoints: [indexPath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    plugins: [transformPlugin],
    alias: {
      "elyra/client": CLIENT_MODULE_PATH,
      "elyra/link": LINK_MODULE_PATH,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const result = await Bun.build(clientBuildConfig);

  if (!result.success) {
    console.error("[elyra] Client build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Client build failed");
  }

  for (const output of result.outputs) {
    console.log(`[elyra]   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  console.log("[elyra] Production client build complete");
}
