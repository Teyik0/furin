import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AotWorkerConfig,
  AotWorkerOperation,
  AotWorkerRequest,
  AotWorkerResponse,
  AotWorkerResult,
} from "./elysia-aot-worker.ts";

const AOT_NAMESPACE = "furin-elysia-aot";
const ELYSIA_RESOLVE_DIR = dirname(Bun.resolveSync("elysia", import.meta.dir));
// The published package ships src/ too; resolving from the package entry also
// works when this adapter is bundled into dist/build/index.js or dist/cli/index.js.
const AOT_WORKER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin")))),
  "src/build/elysia-aot-worker.ts"
);
const SOURCE_FILTER = /\.[cm]?[jt]sx?$/;
const ELYSIA_IMPORT_FILTER = /^elysia(?:\/(?!compiled$|type$).*)?$/;
const ELYSIA_VIRTUAL_IMPORT_FILTER = /^elysia\/(?:compiled|type)$/;
const ANY_MODULE_FILTER = /.*/;
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
 * Kiana strips the WebSocket route module when an app has no WS route,
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

/** Elysia AOT evaluation has its own module cache, independent of prerender loaders. */
export function elysiaAot(entry: string, target?: AotWorkerConfig["target"]): Bun.BunPlugin {
  const entryPath = resolve(entry);
  return {
    name: "elysia-aot",
    async setup(build) {
      const worker = new Worker(AOT_WORKER_PATH, {
        workerData: { entry: entryPath, target: target ?? "bun" } satisfies AotWorkerConfig,
      });
      const pending = new Map<
        number,
        {
          reject: (error: Error) => void;
          resolve: (response: AotWorkerResult) => void;
        }
      >();
      let nextId = 0;
      let workerFailure: Error | undefined;
      const fail = (error: Error): void => {
        workerFailure = error;
        for (const request of pending.values()) {
          request.reject(error);
        }
        pending.clear();
      };
      worker.on("message", (response: AotWorkerResponse) => {
        const request = pending.get(response.id);
        pending.delete(response.id);
        if (response.ok) {
          request?.resolve(response);
        } else {
          request?.reject(response.error);
        }
      });
      worker.on("error", fail);
      worker.on("exit", (code) => fail(new Error(`[furin] Elysia AOT worker exited (${code}).`)));
      const request = (payload: AotWorkerOperation) =>
        new Promise<AotWorkerResult>((resolveResponse, reject) => {
          if (workerFailure) {
            reject(workerFailure);
            return;
          }
          const id = nextId;
          nextId += 1;
          pending.set(id, { reject, resolve: resolveResponse });
          worker.postMessage({ ...payload, id } satisfies AotWorkerRequest);
        });
      let compiled: string | undefined;
      let virtualType: string | undefined;
      try {
        ({ code: compiled, virtualType } = await request({ method: "start" }));
      } catch (error) {
        await worker.terminate();
        if (
          error instanceof Error &&
          error.message.startsWith("[elysia-aot]") &&
          error.message.includes("mounts a sub-app")
        ) {
          console.warn("[furin] Elysia AOT skipped because the app uses .mount().");
          return;
        }
        throw error;
      }
      build.onEnd(async () => {
        try {
          await request({ method: "end" });
        } finally {
          await worker.terminate();
        }
      });
      const entrySource = await Bun.file(entryPath).text();
      const { code: transformedEntry } = await request({
        code: entrySource,
        method: "transform",
        path: entryPath,
      });
      if (transformedEntry !== undefined) {
        await Bun.write(entryPath, transformedEntry);
      }
      build.onResolve({ filter: ELYSIA_IMPORT_FILTER }, ({ path }) => ({
        path: Bun.resolveSync(path, ELYSIA_RESOLVE_DIR),
      }));
      build.onResolve({ filter: ELYSIA_VIRTUAL_IMPORT_FILTER }, ({ path }) => {
        if (path === "elysia/type" && virtualType === undefined) {
          return;
        }
        return { namespace: AOT_NAMESPACE, path };
      });
      build.onLoad({ filter: ANY_MODULE_FILTER, namespace: AOT_NAMESPACE }, ({ path }) => {
        const contents = path === "elysia/compiled" ? compiled : virtualType;
        return contents === undefined
          ? undefined
          : { contents, loader: "js", resolveDir: ELYSIA_RESOLVE_DIR };
      });
      build.onLoad({ filter: SOURCE_FILTER }, async ({ path }) => {
        if (resolve(path) === entryPath) {
          return;
        }
        const original = await Bun.file(path).text();
        const { code: transformed } = await request({ code: original, method: "transform", path });
        if (transformed === undefined) {
          return;
        }
        return {
          contents: patchElysiaWebSocketStub(transformed),
          loader: loaderFor(path),
        };
      });
    },
  };
}
