import { aotFactory } from "elysia/plugin/aot/unplugin";

const AOT_NAMESPACE = "furin-elysia-aot";
const SOURCE_FILTER = /\.[cm]?[jt]sx?$/;
const WEBSOCKET_STUB_MARKER =
  "[elysia-aot] WebSocket route builder was stripped (strip mode) but a WS route was used.";

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
  const hooks = aotFactory({ entry, strip: "auto", target: "bun" });
  return {
    name: "elysia-aot",
    async setup(build) {
      await hooks.buildStart?.();
      build.onResolve({ filter: /^elysia\/(?:compiled|type)$/ }, ({ path }) => {
        const resolved = hooks.resolveId?.(path);
        return resolved === undefined ? undefined : { namespace: AOT_NAMESPACE, path: resolved };
      });
      build.onLoad({ filter: /.*/, namespace: AOT_NAMESPACE }, ({ path }) => {
        const contents = hooks.load?.(path);
        return contents === undefined ? undefined : { contents, loader: "js" };
      });
      build.onLoad({ filter: SOURCE_FILTER }, async ({ path }) => {
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
