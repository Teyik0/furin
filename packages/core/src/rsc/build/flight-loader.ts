import { readFileSync } from "node:fs";
import { BUNDLED_CLIENT_CODEC_PATH, CLIENT_REFERENCE_RUNTIME_PATH } from "./paths.ts";

const CLIENT_CODEC =
  /react-server-dom-webpack-client\.(?:edge|browser)\.(?:development|production)\.js$/;

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
      build.onLoad({ filter: CLIENT_CODEC }, ({ path }) => ({
        contents: `import { requireClientModule as __webpack_require__ } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
const furinCodecExports = {};
${readFileSync(path, "utf8").replaceAll("exports.", "furinCodecExports.")}
export const { createFromReadableStream, createFromFetch } = furinCodecExports;`,
        loader: "js",
      }));
    },
  };
}
