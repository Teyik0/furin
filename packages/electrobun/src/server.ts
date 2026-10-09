import { type AnyElysia, Elysia } from "elysia";
import { BunAdapter, isHTMLBundle } from "elysia/adapter/bun";
import type { ElysiaConfig, EventScope } from "elysia/types";
import { type DesktopMode, type DesktopState, registerDesktopApp } from "./registry";

const HMR_ENTRY = /(?:^|\/)_bun_hmr_entry(?:\/index\.html)?$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function protectLocalWeb(request: Request): Response | undefined {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (
    !LOCAL_HOSTS.has(url.hostname) ||
    (request.method !== "GET" && origin && origin !== url.origin)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
}

export interface DesktopAppOptions {
  onShutdown?: () => void | Promise<void>;
  onStartup?: (signal: AbortSignal) => void | Promise<void>;
  restrictWebToLoopback?: boolean;
}

/** Install on the original root before application wrappers or plugins. */
export function desktopApp(hooks?: DesktopAppOptions) {
  return <App extends AnyElysia>(app: App): App => {
    if (app["~ext"]?.hoc?.length || app.server) {
      throw new Error("Install desktopApp() before application wrappers and before listening.");
    }
    const options = app["~config"];
    const validate = (mode: DesktopMode): void => {
      if (options?.adapter !== undefined && options.adapter !== BunAdapter) {
        throw new Error(
          "Desktop requires Elysia's default Bun adapter; custom adapters cannot guarantee session dispatch."
        );
      }
      if (options?.serve?.routes !== undefined) {
        throw new Error(
          "Desktop serve.routes bypasses session dispatch; declare routes on the Elysia app instead."
        );
      }
      for (const route of app.routes) {
        if (
          isHTMLBundle(route.handler) &&
          (mode === "build" || route.method !== "GET" || !HMR_ENTRY.test(route.path))
        ) {
          throw new Error(
            `Native HTMLBundle route "${route.path}" bypasses desktop session dispatch. Only GET Furin _bun_hmr_entry assets are permitted in dev, never in build.`
          );
        }
      }
    };
    const controller = new AbortController();
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    const state: DesktopState = {
      start(signal) {
        starting ??= Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          await hooks?.onStartup?.(
            signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
          );
        });
        return starting;
      },
      stop() {
        stopping ??= Promise.resolve().then(async () => {
          controller.abort();
          await hooks?.onShutdown?.();
        });
        return stopping;
      },
      async validate(mode) {
        await app.modules;
        validate(mode);
        return () => validate(mode);
      },
    };
    // Public configuration disables native promoted Responses. Bun HTML/HMR
    // bypasses dispatch independently and is checked through public route metadata.
    app["~config"] = { ...options, nativeStaticResponse: false };
    app.wrap(
      (next) =>
        (request, ...rest: unknown[]) =>
          state.guard?.(request) ??
          (hooks?.restrictWebToLoopback ? protectLocalWeb(request) : undefined) ??
          next(request, ...rest)
    );
    app
      .setup(() => {
        if (
          hooks?.restrictWebToLoopback &&
          app.server &&
          !LOCAL_HOSTS.has(app.server.hostname ?? "")
        ) {
          throw new Error("restrictWebToLoopback requires a loopback listener hostname.");
        }
        return state.start();
      })
      .cleanup(() => state.stop());
    registerDesktopApp(app, state);
    return app;
  };
}

/** Convenience constructor; desktopApp() also works on an existing typed Elysia root. */
export function createDesktopApp<
  const Prefix extends string = "",
  const Scope extends EventScope = "local",
>(options?: ElysiaConfig<Prefix, Scope>): Elysia<Prefix, Scope> {
  return desktopApp()(new Elysia<Prefix, Scope>(options));
}
