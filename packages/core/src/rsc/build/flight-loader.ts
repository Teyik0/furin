import { readFileSync } from "node:fs";
import { BUNDLED_CLIENT_CODEC_PATH, CLIENT_REFERENCE_RUNTIME_PATH } from "./paths.ts";

const CLIENT_CODEC =
  /react-server-dom-webpack-client\.(?:edge|browser)\.(?:development|production)\.js$/;
const CODEC_EXPORT = /exports\.([\w$]+)\s*=/g;
const SERVER_CODEC =
  /react-server-dom-webpack-server\.(?:edge|browser|node)\.(?:development|production)\.js$/;
const REFERENCE_FIELD = /((?:[\w$]+\.)*[\w$]+)\.\$\$(typeof|id|async)\b/g;

/** Flight recognizes Furin's client references through the registry's side table. */
function readReferenceFieldsThroughRegistry(source: string, path: string): string {
  const patched = source.replace(
    REFERENCE_FIELD,
    (_field, owner: string, name: string) => `__furinClientReference(${owner}).$$${name}`
  );
  if (patched === source) {
    throw new Error(`[furin/rsc] Unsupported Flight server codec: ${path}`);
  }
  // The registry is ESM, the codec CommonJS: bind it after the strict directive.
  return patched.replace(
    '"use strict";',
    `"use strict";
var __furinClientReference = require(${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)}).clientReference;`
  );
}

export function flightLoaderPlugin(): Bun.BunPlugin {
  return {
    name: "furin-flight-module-loader",
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)server-client-codec\.ts$/ }, () => ({
        path: BUNDLED_CLIENT_CODEC_PATH,
      }));
      build.onLoad({ filter: SERVER_CODEC }, ({ path }) => ({
        contents: readReferenceFieldsThroughRegistry(readFileSync(path, "utf8"), path),
        loader: "js",
      }));
      // React's pinned codec expects a bundler module loader. Keep that adapter
      // lexical: Flight IDs resolve only through Furin's generated registry.
      // Replacing its CommonJS exports also lets Bun load it as native ESM.
      build.onLoad({ filter: CLIENT_CODEC }, ({ path }) => {
        let source = readFileSync(path, "utf8");
        if (path.endsWith(".development.js")) {
          // Bun's CSS observer parses every added link's href, even image
          // preloads with only imagesrcset (oven-sh/bun#46164). Skip that hint
          // in dev browsers; SSR and the production codec keep the preload.
          source = source.replace(
            /case "L":(\s+)id = response\[0\];/,
            `case "L":$1if (typeof window !== "undefined" && response[1] === "image" && response[2]?.imageSrcSet) break;
              id = response[0];`
          );
        }
        // Production assignments are at module scope, so real ESM exports
        // let Bun remove the codec's unused encoding/Server Action APIs.
        const exports = path.endsWith(".production.js")
          ? source.replaceAll(CODEC_EXPORT, "export const $1 =")
          : `const furinCodecExports = {};
${source.replaceAll("exports.", "furinCodecExports.")}
export const { createFromReadableStream, createFromFetch } = furinCodecExports;`;
        return {
          contents: `import { requireClientModule as __webpack_require__ } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
${exports}`,
          loader: "js",
        };
      });
    },
  };
}
