import { pathToFileURL } from "node:url";
import type { AnyElysia } from "elysia";

// Bun hot reload retains the global owner, not the old imported module graph.
const key: unique symbol = Symbol.for("@teyik0/furin/web-dev");
const global = globalThis as typeof globalThis & {
  [key]?: { app: AnyElysia; stop: () => Promise<void> };
};
const previous = global[key];
if (previous) {
  process.off("SIGINT", previous.stop);
  process.off("SIGTERM", previous.stop);
  process.off("message", previous.stop);
  await previous.app.stop(true);
}
const [, , entry, port] = process.argv;
if (!entry) {
  throw new Error("Missing development server entry.");
}
const module: { default?: AnyElysia; app?: AnyElysia } = await import(pathToFileURL(entry).href);
const app = module.default ?? module.app;
if (!app || typeof app.listen !== "function") {
  throw new Error("Default-export an Elysia app.");
}
let stopping: Promise<void> | undefined;
const stop = (status: number) => {
  stopping ??= (async () => {
    let code = status;
    const timer = setTimeout(() => process.exit(1), 5000);
    try {
      await app.stop(true);
    } catch (error) {
      console.error(error);
      code = 1;
    } finally {
      clearTimeout(timer);
      process.exit(code);
    }
  })();
  return stopping;
};
const cancel = () => stop(0);
global[key] = { app, stop: cancel };
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
process.on("message", cancel);
const timer = setTimeout(() => {
  console.error("Web development startup exceeded 30 seconds.");
  stop(1).catch(console.error);
}, 30_000);
await new Promise<void>((resolve, reject) => {
  app.cleanup(() => reject(new Error("Web development startup failed.")));
  app.listen({ hostname: "127.0.0.1", port: Number(port) }, () => {
    clearTimeout(timer);
    console.log(`[furin] Web development: http://127.0.0.1:${app.server?.port}`);
    resolve();
  });
});
