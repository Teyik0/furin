import { pathToFileURL } from "node:url";
import "elysia";
import type { AnyElysia } from "elysia";
import { BunAdapter } from "elysia/adapter/bun";

interface WebDevelopment {
  load: <T>(load: () => Promise<T>) => Promise<T>;
  ready: (app: AnyElysia) => Promise<void>;
  stop: () => Promise<void>;
}

// Bun hot reload retains the global owner, not the old imported module graph.
const key: unique symbol = Symbol.for("@teyik0/furin/web-dev");
const global = globalThis as typeof globalThis & {
  [key]?: { dispose: () => Promise<void>; cancel: () => Promise<void> };
};
const previous = global[key];
if (previous) {
  process.off("SIGINT", previous.cancel);
  process.off("SIGTERM", previous.cancel);
  process.off("message", previous.cancel);
  await previous.dispose();
}
const [, , entry, port, integration] = process.argv;
if (!entry) {
  throw new Error("Missing development server entry.");
}
let app: AnyElysia | undefined;
let web: WebDevelopment | undefined;
const dispose = async () => {
  try {
    await app?.stop(true);
  } finally {
    await web?.stop();
  }
};
let stopping: Promise<void> | undefined;
const stop = (status: number) => {
  stopping ??= (async () => {
    let code = status;
    const timer = setTimeout(() => process.exit(1), 5000);
    try {
      await dispose();
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
global[key] = { dispose, cancel };
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
process.on("message", cancel);
const timer = setTimeout(() => {
  console.error("Web development startup exceeded 30 seconds.");
  stop(1).catch(console.error);
}, 30_000);
try {
  if (integration) {
    const addon: { createWebDevelopment: () => WebDevelopment } = await import(
      pathToFileURL(integration).href
    );
    web = addon.createWebDevelopment();
  }
  const { listen } = BunAdapter;
  if (!listen) {
    throw new Error("Web development requires Elysia's Bun adapter.");
  }
  const ready = Promise.withResolvers<void>();
  // Source import can fail after a startup failure has already rejected readiness.
  ready.promise.catch(() => undefined);
  BunAdapter.listen = (root, options, callback) => {
    if (app) {
      throw new Error("Web development supports one application listener.");
    }
    app = root;
    root.onStop(() => ready.reject(new Error("Web development startup failed.")));
    if (typeof options === "object" && options.unix !== undefined) {
      throw new Error("Web development requires a TCP listener.");
    }
    const settings = port
      ? { ...(typeof options === "object" ? options : {}), unix: undefined, port: Number(port) }
      : options;
    return listen(root, settings, (server) => {
      callback?.(server);
      ready.resolve();
    });
  };
  try {
    const load = (): Promise<{ default?: AnyElysia; app?: AnyElysia }> =>
      import(pathToFileURL(entry).href);
    const module = await (web ? web.load(load) : load());
    const exported = module.default ?? module.app;
    if (app && exported && exported !== app) {
      throw new Error("Default-export the listening Elysia app.");
    }
    if (!app) {
      if (!exported || typeof exported.listen !== "function") {
        throw new Error("Listen on or default-export an Elysia app.");
      }
      exported.listen({ hostname: "127.0.0.1", port: 3000 });
    }
    await ready.promise;
  } finally {
    BunAdapter.listen = listen;
  }
  const activeApp = app;
  if (!activeApp) {
    throw new Error("Web development did not start a listener.");
  }
  await web?.ready(activeApp);
  clearTimeout(timer);
  console.log(`[furin] Web development: ${activeApp.server?.url.origin}`);
} catch (error) {
  clearTimeout(timer);
  console.error(error);
  await stop(1);
}
