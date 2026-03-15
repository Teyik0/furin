import { transformForClient } from "./transform-client.ts";

const ELYSIA_FILTER = /^elysia$/;
const BUN_BUILTIN_FILTER = /^bun:/;
const ANY_FILTER = /.*/;
const TS_FILE_FILTER = /\.(tsx|ts)$/;
const REACT_IMPORT_FILTER = /import\s+React\b/;

// Minimal browser stub for elysia — `t` is only used for schema definitions
// in params/query, which the client never validates at runtime.
const ELYSIA_STUB = `\
export const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }
export class ValidationError extends Error { constructor(m) { super(m); this.name = "ValidationError"; } }
export default {};
`;

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
 * The plugin:
 *  1. Stubs `elysia` for the browser with a minimal proxy.
 *  2. Stubs `bun:*` builtins with an empty module (safety net — DCE removes
 *     loader imports before they reach the browser bundle in practice).
 *  3. Strips server-only code (loader, query, params) from page files before
 *     they are bundled into the client entry.
 */
const plugin: Bun.BunPlugin = {
  name: "furin-strip-server",
  setup(build) {
    // ── browser stubs ───────────────────────────────────────────────────────
    build.onResolve({ filter: ELYSIA_FILTER }, () => ({
      path: "elysia-stub",
      namespace: "furin-stubs",
    }));

    build.onResolve({ filter: BUN_BUILTIN_FILTER }, () => ({
      path: "bun-builtin-stub",
      namespace: "furin-stubs",
    }));

    build.onLoad({ namespace: "furin-stubs", filter: ANY_FILTER }, (args) => ({
      contents: args.path === "elysia-stub" ? ELYSIA_STUB : "",
      loader: "js",
    }));

    // ── page file stripping ─────────────────────────────────────────────────
    build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
      if (args.path.includes("node_modules")) {
        return undefined;
      }

      const source = await Bun.file(args.path).text();

      try {
        const result = transformForClient(source, args.path);
        let code = result.code;

        if (code.includes("React.createElement") && !REACT_IMPORT_FILTER.test(code)) {
          code = `import React from "react";\n${code}`;
        }

        return { contents: code, loader: "js" };
      } catch (err) {
        console.error(`[furin] strip-plugin transform error for ${args.path}:`, err);
        return undefined;
      }
    });
  },
};

export default plugin;
