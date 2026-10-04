import { parentPort, workerData } from "node:worker_threads";
import { aotFactory } from "elysia/plugin/aot/unplugin";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";

export type AotWorkerOperation =
  | { method: "start" | "end" }
  | { code: string; method: "transform"; path: string };

export type AotWorkerRequest = AotWorkerOperation & { id: number };

export interface AotWorkerConfig {
  entry: string;
  target: "bun" | "workerd";
}

export interface AotWorkerResult {
  code?: string;
  virtualType?: string;
}

export interface AotWorkerError {
  message: string;
  name: string;
  stack?: string;
}

export type AotWorkerResponse =
  | (AotWorkerResult & { id: number; ok: true })
  | { error: AotWorkerError; id: number; ok: false };

const port = parentPort;
if (!port) {
  throw new Error("[furin] Elysia AOT worker requires a parent port.");
}
const { entry, target } = workerData as AotWorkerConfig;
const hooks = aotFactory({ entry, strip: false, target });
Bun.plugin(isomorphicTransformPlugin("server"));

port.on("message", async (request: AotWorkerRequest) => {
  try {
    let code: string | undefined;
    let virtualType: string | undefined;
    if (request.method === "start") {
      await hooks.buildStart?.();
      code = hooks.load?.("\0elysia/compiled");
      virtualType = hooks.load?.("\0elysia/type");
    } else if (request.method === "transform") {
      if (hooks.transformInclude?.(request.path) !== false) {
        code = hooks.transform?.(request.code, request.path);
      }
    } else {
      hooks.buildEnd?.();
    }
    port.postMessage({ code, id: request.id, ok: true, virtualType } satisfies AotWorkerResponse);
  } catch (error) {
    const diagnostic = error instanceof Error ? error : new Error(String(error));
    port.postMessage({
      error: {
        message: diagnostic.message,
        name: diagnostic.name,
        stack: diagnostic.stack,
      },
      id: request.id,
      ok: false,
    } satisfies AotWorkerResponse);
  }
});
