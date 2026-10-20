import { type AnyElysia, Elysia } from "elysia";
import { BunAdapter, isHTMLBundle } from "elysia/adapter/bun";
import type { ElysiaConfig, EventScope } from "elysia/types";
import type { DesktopAppOptions } from "./capabilities";
import { type DesktopMode, type DesktopState, registerDesktopApp } from "./registry";

export type {
  AdmissionContext,
  DesktopAppOptions,
  DesktopListen,
  NativeOperation,
} from "./capabilities";

const HMR_ENTRY = /(?:^|\/)_bun_hmr_entry(?:\/index\.html)?$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOOPBACK_PEERS =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const networkKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/network-requests/v1");
const shared = globalThis as typeof globalThis & { [networkKey]?: WeakSet<Request> };
const networkRequests = (shared[networkKey] ??= new WeakSet<Request>());

/** Requests received by the application's own listener; Eden/app.handle dispatch is in-process. */
export function dispatchKind(request: Request): "network" | "in-process" {
  return networkRequests.has(request) ? "network" : "in-process";
}

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

function protectNetworkDispatch(
  request: Request,
  rest: unknown[],
  app: AnyElysia,
  state: DesktopState
): Response | undefined {
  // Eden/app.handle calls fetch with one argument. Bun's listener supplies
  // its Server as the second argument, including compiled/AOT dispatch.
  if (rest.length === 0) {
    return;
  }
  const admission = state.hooks?.admission;
  if ((state.guard || admission) && (!app.server || rest[0] !== app.server)) {
    return new Response("Forbidden", { status: 403 });
  }
  networkRequests.add(request);
  if (state.hooks?.restrictWebToLoopback) {
    const denied = protectLocalWeb(request);
    if (denied) {
      return denied;
    }
  }
  const denied = state.guard?.(request);
  if (!(admission && app.server)) {
    return denied;
  }
  const peerAddress = app.server.requestIP(request)?.address;
  return admission(request, {
    desktopHost: state.guard !== undefined,
    desktopSession:
      state.guard !== undefined &&
      denied === undefined &&
      peerAddress !== undefined &&
      LOOPBACK_PEERS.test(peerAddress),
    peerAddress,
  });
}

/** Install on the original root before application wrappers or plugins. */
export function desktopApp(hooks?: DesktopAppOptions) {
  return <App extends AnyElysia>(app: App): App => {
    if (app["~ext"]?.hoc?.length || app.server) {
      throw new Error("Install desktopApp() before application wrappers and before listening.");
    }
    const { "~config": options } = app;
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
    let { signal } = controller;
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let ready: Promise<void> | undefined;
    let available = false;
    const closed = Promise.withResolvers<void>();
    const state: DesktopState = {
      closed: closed.promise,
      hooks,
      start(parent) {
        starting ??= Promise.resolve().then(async () => {
          const native = state.runtime?.kind === "desktop" ? state.runtime.signal : undefined;
          signal = AbortSignal.any([
            controller.signal,
            ...(parent ? [parent] : []),
            ...(native ? [native] : []),
          ]);
          signal.throwIfAborted();
          await hooks?.onStartup?.({
            signal,
            runtime: state.runtime ?? { kind: "server" },
          });
        });
        return starting;
      },
      stop() {
        closed.resolve();
        stopping ??= Promise.resolve().then(async () => {
          controller.abort();
          await hooks?.onShutdown?.({
            signal: controller.signal,
            runtime: state.runtime ?? { kind: "server" },
          });
        });
        return stopping;
      },
      ready(backend) {
        ready ??= Promise.resolve().then(async () => {
          await hooks?.onReady?.({
            backend,
            signal,
            runtime: state.runtime ?? { kind: "server" },
          });
          available = true;
        });
        return ready;
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
    app.wrap((next) => (request, ...rest: unknown[]) => {
      const denied = protectNetworkDispatch(request, rest, app, state);
      if (denied) {
        return denied;
      }
      if (stopping || state.paused || ((state.guard || starting) && !available)) {
        return new Response("Application unavailable", { status: 503 });
      }
      return next(request, ...rest);
    });
    app
      .onStart(async () => {
        if (
          hooks?.restrictWebToLoopback &&
          app.server &&
          !LOCAL_HOSTS.has(app.server.hostname ?? "")
        ) {
          throw new Error("restrictWebToLoopback requires a loopback listener hostname.");
        }
        await state.start();
        if (!state.guard && app.server) {
          await state.ready?.({ origin: app.server.url.origin });
        }
      })
      .onStop(() => state.stop());
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
