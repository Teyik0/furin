import { type AnyElysia, Elysia } from "elysia";

/** Normalize entry-owned listening without opening a socket or running startup hooks. */
export async function loadServerEntry<Module extends object>(
  load: () => Promise<Module>
): Promise<Module & { default: AnyElysia }> {
  const { listen } = Elysia.prototype;
  let capturing = true;
  let captured: AnyElysia | undefined;
  Elysia.prototype.listen = function (this: AnyElysia, ...args) {
    // desktopApp() can retain this method in its own listener wrapper. Once
    // import finishes, that retained method must delegate to the real listener.
    if (!capturing) {
      return listen.apply(this, args);
    }
    if (captured && captured !== this) {
      throw new Error("[furin] Server entry must listen on only one Elysia app.");
    }
    captured = this;
    const [options] = args;
    const serve = { ...this["~config"]?.serve };
    Object.assign(serve, typeof options === "object" ? options : { port: Number(options) });
    this["~config"] = { ...this["~config"], serve };
    return this;
  };
  try {
    const module = await load();
    const app = (module as { default?: AnyElysia }).default ?? captured;
    if (!app || typeof app.listen !== "function") {
      throw new Error(
        "[furin] Server entry must export the Elysia app as default or call app.listen()."
      );
    }
    return { ...module, default: app };
  } finally {
    capturing = false;
    Elysia.prototype.listen = listen;
  }
}
