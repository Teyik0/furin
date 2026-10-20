import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { transformForClient } from "./transform-client.ts";

const NODE_MODULES_SEGMENT = /[\\/]node_modules[\\/]/;

/** Package modules are published code: they are bundled as-is, never stripped. */
export function isPackageModule(path: string): boolean {
  return NODE_MODULES_SEGMENT.test(path);
}

/**
 * Strips server-only code from an application module for the browser bundle.
 * Shared by the dev strip plugin and the production client build.
 */
export function stripServerCode(
  path: string,
  source: string
): { contents: string; loader: Bun.Loader } {
  // TS/TSX output: Bun's bundler applies the project tsconfig, including the
  // JSX automatic runtime, from the file extension's loader.
  return { contents: transformForClient(source, path).code, loader: detectLoaderFromPath(path) };
}
