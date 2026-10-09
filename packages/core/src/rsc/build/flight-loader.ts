import { readFileSync } from "node:fs";
import { BUNDLED_CLIENT_CODEC_PATH, CLIENT_REFERENCE_RUNTIME_PATH } from "./paths.ts";

const CLIENT_CODEC =
  /react-server-dom-webpack-client\.(?:edge|browser)\.(?:development|production)\.js$/;
const CODEC_EXPORT = /exports\.([\w$]+)\s*=/g;

export function flightLoaderPlugin(): Bun.BunPlugin {
  return {
    name: "furin-flight-module-loader",
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)server-client-codec\.ts$/ }, () => ({
        path: BUNDLED_CLIENT_CODEC_PATH,
      }));
      // React's pinned codec expects a bundler module loader. Keep that adapter
      // lexical: Flight IDs resolve only through Furin's generated registry.
      // Replacing its CommonJS exports also lets Bun load it as native ESM.
      build.onLoad({ filter: CLIENT_CODEC }, ({ path }) => {
        const source = readFileSync(path, "utf8");
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
