import { createClientStripPlugin } from "./client-plugin.ts";

/**
 * Standalone Bun bundler plugin for Furin.
 *
 * Register it in your project's bunfig.toml so that Bun's HTML bundler
 * applies it when building the client bundle:
 *
 * ```toml
 * [serve.static]
 * plugins = ["@teyik0/furin/strip-plugin"]
 * ```
 *
 * The production client build uses the same plugin in `build` mode.
 */
const plugin: Bun.BunPlugin = createClientStripPlugin({ mode: "dev" });

export default plugin;
