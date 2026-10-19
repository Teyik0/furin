import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { aotFactory } from "elysia/plugin/aot/unplugin";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { collectFurinRegistrations, type FurinRegistration } from "../server/registrations.ts";
import { collectInMemoryApps, inMemoryApps } from "../shared/in-memory-apps.ts";

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
const registrations = collectFurinRegistrations(false);
collectInMemoryApps();
const IN_MEMORY_APPS_MODULE = fileURLToPath(
  new URL("../shared/in-memory-apps.ts", import.meta.url)
);

/**
 * Elysia AOT compiles a manifest for each app its entry exports, and every
 * app an in-memory Eden client handles needs one. Those apps are known only
 * once the application evaluates, after which the entry's exports are fixed:
 * the application moves to a sibling module evaluated first, and the entry
 * re-exports it with each recorded app.
 */
async function exportInMemoryApps(): Promise<void> {
  const application = join(dirname(entry), `_furin-application${extname(entry)}`);
  await Bun.write(application, await Bun.file(entry).text());
  // Elysia evaluates its entry in this mode; the application observes the same.
  process.env.ELYSIA_AOT_BUILD = "1";
  const { app: served } = await import(application);
  const apps = inMemoryApps();
  if (apps.some((app) => app !== served && app["~routes"].length > 0 && !app["~config"]?.name)) {
    throw new Error(
      "[furin] An in-memory client calls an unnamed Elysia instance. Elysia AOT keys each compiled app by name: name it, e.g. new Elysia({ name: \"api\" })."
    );
  }
  await Bun.write(
    entry,
    [
      `export * from ${JSON.stringify(application)};`,
      `export { default } from ${JSON.stringify(application)};`,
      ...(apps.length === 0
        ? []
        : [`import { inMemoryApps } from ${JSON.stringify(IN_MEMORY_APPS_MODULE)};`]),
      ...apps.map((_, index) => `export const __furinInMemoryApp${index} = inMemoryApps()[${index}];`),
      "",
    ].join("\n")
  );
}

port.on("message", async (request: AotWorkerRequest) => {
  try {
    let code: string | undefined;
    let virtualType: string | undefined;
    if (request.method === "start") {
      await exportInMemoryApps();
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
