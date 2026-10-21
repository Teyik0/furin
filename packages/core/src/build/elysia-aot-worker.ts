import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const send = process.send?.bind(process);
if (!send) {
  throw new Error("[furin] Elysia AOT process requires IPC.");
}
// A dead build parent must not leave its evaluation and native locks behind.
process.on("disconnect", () => process.exit(0));
const entry = process.argv[2] as string;
const hooks = aotFactory({ entry, strip: false, target: "bun" });
Bun.plugin(isomorphicTransformPlugin("server"));
const registrations = collectFurinRegistrations(false);
collectInMemoryApps();
const IN_MEMORY_APPS_MODULE = fileURLToPath(
  new URL("../shared/in-memory-apps.ts", import.meta.url)
);

/**
 * An Eden client given an Elysia instance (`treaty(app)`) handles it in memory. While the
 * application evaluates, the application's own Eden entries record each instance `treaty` gets.
 */
Bun.plugin({
  name: "furin-in-memory-eden",
  setup(build) {
    for (const specifier of ["@elysia/eden", "@elysia/eden/treaty2"]) {
      let eden: string;
      try {
        eden = Bun.resolveSync(specifier, dirname(entry));
      } catch {
        continue; // The application has no Eden: no in-memory client either.
      }
      build.module(specifier, () => ({
        contents: [
          `import { treaty as edenTreaty } from ${JSON.stringify(eden)};`,
          `import { recordInMemoryApp } from ${JSON.stringify(IN_MEMORY_APPS_MODULE)};`,
          `export * from ${JSON.stringify(eden)};`,
          "export function treaty(domain, config) {",
          '  if (typeof domain !== "string") recordInMemoryApp(domain);',
          "  return edenTreaty(domain, config);",
          "}",
        ].join("\n"),
        loader: "js",
      }));
    }
  },
});

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

process.on("message", async (request: AotWorkerRequest) => {
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
    send({
      code,
      id: request.id,
      ok: true,
      registrations: request.method === "start" ? registrations : undefined,
      virtualType,
    } satisfies AotWorkerResponse);
  } catch (error) {
    send({
      error: error instanceof Error ? error : new Error(String(error)),
      id: request.id,
      ok: false,
      registrations: request.method === "start" ? registrations : undefined,
    } satisfies AotWorkerResponse);
  }
});
