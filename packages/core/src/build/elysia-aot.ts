import { dirname, resolve } from "node:path";
import { aotFactory } from "elysia/plugin/aot/unplugin";

const AOT_NAMESPACE = "furin-elysia-aot";
const RUNTIME_NAMESPACE = "furin-elysia-runtime";
const RUNTIME_SPECIFIER = "furin:elysia-runtime";
const ELYSIA_RESOLVE_DIR = dirname(Bun.resolveSync("elysia", import.meta.dir));
const SOURCE_FILTER = /\.[cm]?[jt]sx?$/;
const WEBSOCKET_STUB_MARKER =
  "[elysia-aot] WebSocket route builder was stripped (strip mode) but a WS route was used.";
const RUNTIME_TYPEBOX_SETUP = `import { setupTypebox } from "elysia";
import exactMirror from "exact-mirror";
import * as type from "typebox/type";
import * as system from "typebox/system";
import * as value from "typebox/value";
import * as schema from "typebox/schema";
import * as compile from "typebox/compile";
setupTypebox({ exactMirror, typebox: { type, system, value, schema, compile } });
`;

function loaderFor(path: string): Bun.Loader {
  const extension = path.slice(path.lastIndexOf("."));
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "ts";
  }
  return "js";
}

/**
 * Kiana beta.16 strips the WebSocket route module when an app has no WS route,
 * but its capability plugin still imports four helpers omitted by that stub.
 * Keep the upstream failure semantics while restoring the complete export
 * surface. Remove this compatibility shim when Elysia ships the full stub.
 */
export function patchElysiaWebSocketStub(source: string): string {
  if (!source.includes(WEBSOCKET_STUB_MARKER) || source.includes("accumulateWSOptions")) {
    return source;
  }
  return `${source}
export function accumulateWSOptions(){return e()}
export function resolveWSOptions(){return e()}
export function drainWaiters(){return e()}
export function handleWSResponse(){return e()}
`;
}

/** Elysia AOT plugin with the beta.16 no-WebSocket stub compatibility fix. */
export function elysiaAot(entry: string): Bun.BunPlugin {
  const entryPath = resolve(entry);
  const hooks = aotFactory({ entry, strip: "auto", target: "bun" });
  return {
    name: "elysia-aot",
    async setup(build) {
      try {
        await hooks.buildStart?.();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("[elysia-aot]") &&
          error.message.includes("mounts a sub-app")
        ) {
          console.warn("[furin] Elysia AOT skipped because the app uses .mount().");
          const entrySource = await Bun.file(entryPath).text();
          await Bun.write(entryPath, `import ${JSON.stringify(RUNTIME_SPECIFIER)};\n${entrySource}`);
          build.onResolve({ filter: /^furin:elysia-runtime$/ }, () => ({
            namespace: RUNTIME_NAMESPACE,
            path: RUNTIME_SPECIFIER,
          }));
          build.onLoad({ filter: /.*/, namespace: RUNTIME_NAMESPACE }, () => ({
            contents: RUNTIME_TYPEBOX_SETUP,
            loader: "js",
            resolveDir: ELYSIA_RESOLVE_DIR,
          }));
          return;
        }
        throw error;
      }
      const entrySource = await Bun.file(entryPath).text();
      const transformedEntry = await hooks.transform?.(entrySource, entryPath);
      if (transformedEntry !== undefined) {
        await Bun.write(entryPath, transformedEntry);
      }
      build.onResolve({ filter: /^elysia(?:\/(?!compiled$|type$).*)?$/ }, ({ path }) => ({
        path: Bun.resolveSync(path, ELYSIA_RESOLVE_DIR),
      }));
      build.onResolve({ filter: /^elysia\/(?:compiled|type)$/ }, ({ path }) => {
        const resolved = hooks.resolveId?.(path);
        return resolved === undefined ? undefined : { namespace: AOT_NAMESPACE, path: resolved };
      });
      build.onLoad({ filter: /.*/, namespace: AOT_NAMESPACE }, ({ path }) => {
        const contents = hooks.load?.(path);
        return contents === undefined
          ? undefined
          : { contents, loader: "js", resolveDir: ELYSIA_RESOLVE_DIR };
      });
      build.onLoad({ filter: SOURCE_FILTER }, async ({ path }) => {
        if (resolve(path) === entryPath) {
          return;
        }
        if (hooks.transformInclude?.(path) === false) {
          return;
        }
        const original = await Bun.file(path).text();
        const transformed = await hooks.transform?.(original, path);
        if (transformed === undefined) {
          return;
        }
        return {
          contents: patchElysiaWebSocketStub(transformed),
          loader: loaderFor(path),
        };
      });
      build.onEnd(() => {
        hooks.buildEnd?.();
      });
    },
  };
}
