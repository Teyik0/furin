import { type AnyElysia, Elysia } from "elysia";
import { BunAdapter, isHTMLBundle } from "elysia/adapter/bun";
import type {
  DefinitionBase,
  ElysiaConfig,
  EphemeralType,
  EventScope,
  MetadataBase,
  RouteBase,
  SingletonBase,
} from "elysia/types";
import type { ApplicationRuntime, DesktopAppOptions } from "./capabilities";
import {
  type DesktopMode,
  type DesktopState,
  getDesktopEntry,
  getDesktopHost,
  getDesktopState,
  registerDesktopApp,
} from "./registry";

export type {
  AdmissionContext,
  DesktopAppOptions,
  DesktopContext,
  DesktopListen,
  DesktopWindowOptions,
} from "./capabilities";

/** Dependency-only provider: no root registration, listener or native SDK initialization. */
export const desktopContext = new Elysia({
  name: "@teyik0/furin-electrobun/desktop-context",
}).derive("global", () => ({ desktop: getDesktopHost() }));

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

/** Install on the original root before listening, ahead of application dispatch. */
export function desktopApp(hooks?: DesktopAppOptions) {
  return <
    const Prefix extends string,
    const Scope extends EventScope,
    const Singleton extends SingletonBase,
    const Definitions extends DefinitionBase,
    const Metadata extends MetadataBase,
    const Routes extends RouteBase,
    const Ephemeral extends EphemeralType,
    const Volatile extends EphemeralType,
  >(
    app: Elysia<Prefix, Scope, Singleton, Definitions, Metadata, Routes, Ephemeral, Volatile>
  ) => {
    if (app.server) {
      throw new Error("Install desktopApp() before listening.");
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
    let stopping: Promise<void> | undefined;
    let ready: Promise<void> | undefined;
    let available = false;
    const closed = Promise.withResolvers<void>();
    const entry = getDesktopEntry();
    const listening = entry ? Promise.withResolvers<void>() : undefined;
    const state: DesktopState = {
      closed: closed.promise,
      guard: entry?.guard,
      hooks,
      listening: listening?.promise,
      runtime: entry?.runtime,
      stop() {
        closed.resolve();
        stopping ??= Promise.resolve();
        return stopping;
      },
      ready() {
        ready ??= Promise.resolve().then(() => {
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
    if (entry && listening) {
      listening.promise.catch(() => undefined);
      const { listen } = app;
      app.listen = (listenOptions, callback) => {
        if (stopping) {
          throw new Error("Desktop application is stopped.");
        }
        // Validate synchronous native routes before Bun can open the socket.
        validate(entry.mode);
        return listen.call(app, listenOptions, (server) => {
          try {
            validate(entry.mode);
            callback?.(server);
            listening.resolve();
          } catch (error) {
            listening.reject(error);
            Promise.resolve(server.stop(true)).catch(console.error);
          }
        });
      };
    }
    app.wrap((next) => (request, ...rest: unknown[]) => {
      const denied = protectNetworkDispatch(request, rest, app, state);
      if (denied) {
        return denied;
      }
      if (stopping || state.paused || (state.guard && !available)) {
        return new Response("Application unavailable", { status: 503 });
      }
      return next(request, ...rest);
    });
    // Elysia applies the first HOC outermost. Keep its origin metadata paired
    // when moving admission ahead of wrappers inherited from earlier plugins.
    const { hoc, hocOrigin } = app["~ext"] ?? {};
    hoc?.unshift(...hoc.splice(-1));
    hocOrigin?.unshift(...hocOrigin.splice(-1));
    app
      .onStart(async () => {
        try {
          if (entry) {
            await state.validate(entry.mode);
          }
          if (
            hooks?.restrictWebToLoopback &&
            app.server &&
            !LOCAL_HOSTS.has(app.server.hostname ?? "")
          ) {
            throw new Error("restrictWebToLoopback requires a loopback listener hostname.");
          }
          if (!state.guard && app.server) {
            await state.ready?.();
          }
        } catch (error) {
          listening?.reject(error);
          throw error;
        }
      })
      .onStop(() => state.stop());
    registerDesktopApp(app, state);
    return app.use(desktopContext);
  };
}

/** Convenience constructor; desktopApp() also works on an existing typed Elysia root. */
export function createDesktopApp<
  const Prefix extends string = "",
  const Scope extends EventScope = "local",
>(options?: ElysiaConfig<Prefix, Scope>) {
  return desktopApp()(new Elysia<Prefix, Scope>(options));
}

/** Read the managed native context from ordinary Elysia lifecycle hooks. */
export function getApplicationRuntime(app: object): ApplicationRuntime {
  return getDesktopState(app)?.runtime ?? { kind: "server" };
}
