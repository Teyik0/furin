import { parentPort, workerData } from "node:worker_threads";
import { aotFactory } from "elysia/plugin/aot/unplugin";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { collectFurinRegistrations, type FurinRegistration } from "../server/registrations.ts";

export type AotWorkerOperation =
  | { method: "start" | "end" }
  | { code: string; method: "transform"; path: string };

export type AotWorkerRequest = AotWorkerOperation & { id: number };

export interface AotWorkerResult {
  code?: string;
  /** `furin()` calls made while the application was evaluated (start only). */
  registrations?: FurinRegistration[];
  virtualType?: string;
}

export type AotWorkerResponse =
  | (AotWorkerResult & { id: number; ok: true })
  | { error: Error; id: number; ok: false; registrations?: FurinRegistration[] };

const port = parentPort;
if (!port) {
  throw new Error("[furin] Elysia AOT worker requires a parent port.");
}
const { entry } = workerData as { entry: string };
const hooks = aotFactory({ entry, strip: false, target: "bun" });
Bun.plugin(isomorphicTransformPlugin("server"));
const registrations = collectFurinRegistrations();

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
    port.postMessage({
      code,
      id: request.id,
      ok: true,
      registrations: request.method === "start" ? registrations : undefined,
      virtualType,
    } satisfies AotWorkerResponse);
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error : new Error(String(error)),
      id: request.id,
      ok: false,
      registrations: request.method === "start" ? registrations : undefined,
    } satisfies AotWorkerResponse);
  }
});
