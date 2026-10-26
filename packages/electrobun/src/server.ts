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
  DesktopWindowOptions,
} from "./capabilities";

/** Dependency-only provider: no root registration, listener or native SDK initialization. */
export const desktopContext = new Elysia({
  name: "@teyik0/furin-electrobun/desktop-context",
}).derive("global", () => ({ desktop: getDesktopHost() }));

export type DesktopAppContext<Singleton extends SingletonBase> = Singleton["decorator"] & {
  store: Singleton["store"];
};

type DesktopFactory<Singleton extends SingletonBase> = (
  context: DesktopAppContext<Singleton>
) => DesktopAppOptions;

// Inferring the invariant Elysia class fails for request-aware macros; read its type slots instead.
type DesktopApplication<App extends AnyElysia> = ReturnType<
  typeof installDesktopApp<
    App["~Prefix"],
    NonNullable<NonNullable<App["~config"]>["as"]>,
    App["~Singleton"],
    App["~Definitions"],
    App["~Metadata"],
    App["~Routes"],
    App["~Ephemeral"],
    App["~Volatile"]
  >
>;

const desktopFactory = Symbol("desktopFactory");

interface DesktopPlugin<Singleton extends SingletonBase> {
  <App extends AnyElysia & { "~Singleton": Singleton }>(app: App): DesktopApplication<App>;
  readonly [desktopFactory]: DesktopFactory<Singleton>;
}

declare module "elysia" {
  interface Elysia<
    BasePath extends string,
    Scope extends EventScope,
    Singleton extends SingletonBase,
    Definitions extends DefinitionBase,
    Metadata extends MetadataBase,
    Routes extends RouteBase,
    Ephemeral extends EphemeralType,
    Volatile extends EphemeralType,
  > {
    // biome-ignore lint/style/useConsistentMethodSignatures: Overload Elysia's existing method to infer desktop factory context.
    use(plugin: DesktopPlugin<Singleton>): DesktopApplication<this>;
  }
}

function configurationContext<Singleton extends SingletonBase>(
  app: AnyElysia
): DesktopAppContext<Singleton> {
  return {
    ...app["~ext"]?.decorator,
    store: app["~ext"]?.store ?? {},
  } as DesktopAppContext<Singleton>;
}

export function desktopApp(
  options?: DesktopAppOptions
): <App extends AnyElysia>(app: App) => DesktopApplication<App>;
export function desktopApp<Singleton extends SingletonBase>(
  configure: DesktopFactory<Singleton>
): DesktopPlugin<Singleton>;
export function desktopApp<App extends AnyElysia>(
  app: App,
  configure: DesktopFactory<App["~Singleton"]>
): DesktopApplication<App>;
export function desktopApp<Singleton extends SingletonBase>(
  optionsOrApp?: DesktopAppOptions | DesktopFactory<Singleton> | AnyElysia,
  configure?: DesktopFactory<Singleton>
): unknown {
  if (configure) {
    const app = optionsOrApp as AnyElysia;
    return installDesktopApp(app, configure);
  }
  if (typeof optionsOrApp === "function") {
    return Object.assign((app: AnyElysia) => installDesktopApp(app, optionsOrApp), {
      [desktopFactory]: optionsOrApp,
    });
  }
  return (app: AnyElysia) => installDesktopApp(app, optionsOrApp as DesktopAppOptions | undefined);
}

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
  const peerAddress = app.server?.requestIP(request)?.address;
  const bootstrap = state.webBootstrap?.(request, peerAddress);
  if (bootstrap) {
    return bootstrap;
  }
  const denied = state.guard?.(request);
  if (!(admission && app.server)) {
    return denied;
  }
  return admission(request, {
    desktopHost: state.guard !== undefined && !state.webDevelopment,
    desktopSession:
      state.guard !== undefined &&
      denied === undefined &&
      peerAddress !== undefined &&
      LOOPBACK_PEERS.test(peerAddress),
    peerAddress,
  });
}

/** Install on the original root before listening, ahead of application dispatch. */
function installDesktopApp<
  const Prefix extends string,
  const Scope extends EventScope,
  const Singleton extends SingletonBase,
  const Definitions extends DefinitionBase,
  const Metadata extends MetadataBase,
  const Routes extends RouteBase,
  const Ephemeral extends EphemeralType,
  const Volatile extends EphemeralType,
>(
  app: Elysia<Prefix, Scope, Singleton, Definitions, Metadata, Routes, Ephemeral, Volatile>,
  configuration: DesktopAppOptions | DesktopFactory<Singleton> | undefined
) {
  if (app.server) {
    throw new Error("Install desktopApp() before listening.");
  }
  const hooks =
    typeof configuration === "function"
      ? configuration(configurationContext<Singleton>(app))
      : configuration;
  const validate = (
    mode: DesktopMode,
    listenOptions?: Parameters<AnyElysia["listen"]>[0]
  ): void => {
    const options = app["~config"];
    if (options?.adapter !== undefined && options.adapter !== BunAdapter) {
      throw new Error(
        "Desktop requires Elysia's default Bun adapter; custom adapters cannot guarantee session dispatch."
      );
    }
    if (
      options?.serve?.routes !== undefined ||
      (typeof listenOptions === "object" && listenOptions.routes !== undefined)
    ) {
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
    webDevelopment: entry?.webDevelopment,
    webBootstrap: entry?.webBootstrap,
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
  app["~config"] = { ...app["~config"], nativeStaticResponse: false };
  if (entry && listening) {
    listening.promise.catch(() => undefined);
    const { listen } = app;
    app.listen = (listenOptions, callback) => {
      if (stopping) {
        throw new Error("Desktop application is stopped.");
      }
      // Validate synchronous native routes before Bun can open the socket.
      validate(entry.mode, listenOptions);
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
