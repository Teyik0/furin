import { mkdir } from "node:fs/promises";
import type { ElysiaConfig } from "elysia/types";
import type { ApplicationRuntime } from "./capabilities";
import {
  activateDesktopApp,
  type DesktopEntry,
  type DesktopMode,
  getDesktopState,
  withDesktopEntry,
} from "./registry";

export function getExternalUrl(
  detail: unknown,
  localOrigins: readonly string[]
): string | undefined {
  try {
    const value: unknown =
      typeof detail === "string" && detail.startsWith("{") ? JSON.parse(detail) : detail;
    const candidate =
      typeof value === "object" && value !== null && "url" in value ? value.url : value;
    if (typeof candidate !== "string") {
      return undefined;
    }
    const url = new URL(candidate);
    if (
      !localOrigins.includes(url.origin) &&
      ["https:", "http:", "mailto:"].includes(url.protocol)
    ) {
      return url.href;
    }
  } catch {
    // Malformed native event details cannot grant navigation capabilities.
  }
}

export interface DesktopSession {
  name: string;
  value: string;
}

const LISTEN_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::"]);

export function createSessionGuard(
  session: DesktopSession,
  origin: () => string,
  bootstrapOrigin?: () => string | undefined,
  bootstrapAllows?: (destination: string) => boolean
) {
  return (request: Request): Response | undefined => {
    const url = new URL(request.url);
    const expected = origin();
    const requestOrigin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    const referer = request.headers.get("referer");
    let refererOrigin: string | undefined;
    if (referer) {
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        return new Response("Forbidden", { status: 403 });
      }
    }
    // Only the private listener's initial document redirect may cross ports.
    const bootstrapNavigation =
      request.method === "GET" &&
      (bootstrapAllows?.(`${url.pathname}${url.search}`) ??
        (url.pathname === "/" && url.search === "")) &&
      request.headers.get("sec-fetch-mode") === "navigate" &&
      request.headers.get("sec-fetch-dest") === "document" &&
      site === "same-site" &&
      refererOrigin !== undefined &&
      referer === `${refererOrigin}/` &&
      refererOrigin === bootstrapOrigin?.();
    if (
      url.origin !== expected ||
      (requestOrigin && requestOrigin !== expected) ||
      site === "cross-site" ||
      (refererOrigin !== undefined && refererOrigin !== expected && !bootstrapNavigation) ||
      (site === "same-site" && !requestOrigin && !bootstrapNavigation)
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    if (
      !request.headers
        .get("cookie")
        ?.split(";")
        .some((part) => part.trim() === `${session.name}=${session.value}`)
    ) {
      return new Response("Forbidden", { status: 403 });
    }
  };
}

function startSessionBootstrap(session: DesktopSession, appOrigin: string) {
  const path = `/${crypto.randomUUID()}`;
  let origin = "";
  let stopped = false;
  const tokens = new Map<string, { destination: URL; spent: boolean; issued: number }>();
  tokens.set(path, { destination: new URL("/", appOrigin), spent: false, issued: Date.now() });
  const prune = () => {
    for (const [key, token] of tokens) {
      if (Date.now() - token.issued > 60_000) {
        tokens.delete(key);
      }
    }
    while (tokens.size > 128) {
      const first = tokens.keys().next().value;
      if (first) {
        tokens.delete(first);
      }
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      prune();
      const url = new URL(request.url);
      const token = tokens.get(url.pathname);
      if (token?.spent || [...tokens.values()].every((value) => value.spent)) {
        return new Response("Gone", { status: 410, headers: { "cache-control": "no-store" } });
      }
      const requestOrigin = request.headers.get("origin");
      if (
        request.method !== "GET" ||
        url.origin !== origin ||
        !token ||
        url.search !== "" ||
        (requestOrigin && requestOrigin !== origin && requestOrigin !== appOrigin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      token.spent = true;
      return new Response(null, {
        status: 303,
        headers: {
          location: token.destination.href,
          "set-cookie": `${session.name}=${session.value}; HttpOnly; SameSite=Strict; Path=/`,
          "cache-control": "no-store",
          "referrer-policy": "origin",
        },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    url: `${origin}${path}`,
    allows(destination: string) {
      prune();
      return [...tokens.values()].some(
        (token) =>
          token.spent && `${token.destination.pathname}${token.destination.search}` === destination
      );
    },
    createWindowUrl(target?: string) {
      if (stopped) {
        throw new Error("Desktop backend is stopped.");
      }
      const next = new URL(target ?? "/", appOrigin);
      if (next.origin !== appOrigin || next.username || next.password) {
        throw new Error("Desktop bootstrap destination must use the app origin.");
      }
      const key = `/${crypto.randomUUID()}`;
      tokens.set(key, { destination: next, spent: false, issued: Date.now() });
      prune();
      return `${origin}${key}`;
    },
    stop() {
      stopped = true;
      tokens.clear();
      return server.stop(true);
    },
  };
}

export interface DesktopApp {
  "~config"?: Pick<ElysiaConfig<string, "local">, "serve">;
  listen: (
    options: {
      hostname: string;
      port: number;
      development: boolean;
    },
    callback: (server: { port?: number; stop: (force: boolean) => void | Promise<void> }) => void
  ) => DesktopApp;
  onStop: (handler: () => void) => unknown;
  server?: { hostname?: string; port?: number; url: URL };
  stop: (closeActiveConnections: boolean) => Promise<void> | undefined;
}

export interface DesktopAppModule {
  default?: DesktopApp;
}

/** In-process host capabilities. Never expose the cookie to browser scripts or logs. */
export interface DesktopBackend {
  /** Empty when the window receives its session natively instead of through the bootstrap. */
  bootstrapOrigin: string;
  cookie: string;
  createWindowUrl: (destination?: string) => string;
  origin: string;
  /** Present only for a TLS listener: install it in the window's cookie store before navigation. */
  session?: DesktopSession & { secure: true };
  stop: () => Promise<void>;
  url: string;
}

async function withCancellation<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return pending;
  }
  const aborted = Promise.withResolvers<never>();
  const cancel = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    return await Promise.race([pending, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function withDeadline<T>(pending: Promise<T>, duration: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, duration);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One fixed grace period shared by runtime cleanup and owned-process supervision. */
export function withShutdownDeadline<T>(pending: Promise<T>): Promise<T> {
  return withDeadline(
    pending,
    5000,
    "Desktop shutdown exceeded 5 seconds; forced termination is required."
  );
}

function createBackend(
  origin: string,
  session: DesktopSession,
  bootstrap: ReturnType<typeof startSessionBootstrap> | undefined,
  stop: () => Promise<void>,
  isStopped: () => boolean
): DesktopBackend {
  const cookie = `${session.name}=${session.value}`;
  const createWindowUrl = (destination?: string) => {
    if (isStopped()) {
      throw new Error("Desktop backend is stopped.");
    }
    if (bootstrap) {
      return bootstrap.createWindowUrl(destination);
    }
    const next = new URL(destination ?? "/", origin);
    if (next.origin !== origin || next.username || next.password) {
      throw new Error("Desktop window destination must use the app origin.");
    }
    return next.href;
  };
  if (bootstrap) {
    return {
      origin,
      bootstrapOrigin: bootstrap.origin,
      url: bootstrap.url,
      cookie,
      createWindowUrl,
      stop,
    };
  }
  // A cross-scheme bootstrap redirect is cross-site; the host installs this cookie natively.
  return {
    origin,
    bootstrapOrigin: "",
    url: `${origin}/`,
    cookie,
    session: { ...session, secure: true },
    createWindowUrl,
    stop,
  };
}

/** Opens the application's own listener; the native window always connects through loopback. */
function listenDesktop(
  app: DesktopApp,
  mode: DesktopMode,
  validate: () => void,
  listeningReady: PromiseWithResolvers<void>
): string {
  const serve = app["~config"]?.serve;
  const hostname = serve?.hostname ?? "127.0.0.1";
  if (serve?.unix !== undefined || !LISTEN_HOSTS.has(hostname)) {
    throw new Error("The desktop listener must include the loopback interface.");
  }
  const listening = app.listen(
    {
      hostname,
      port: Number(serve?.port ?? 0),
      development: mode === "dev",
    },
    (server) => {
      try {
        validate();
        listeningReady.resolve();
      } catch (error) {
        // Stop the native listener in this callback, before readiness or
        // another event-loop turn can expose a late native HTML route.
        Promise.resolve(server.stop(true)).catch(console.error);
        listeningReady.reject(error);
      }
    }
  );
  if (!listening.server?.port) {
    throw new Error("Elysia did not create a desktop server.");
  }
  return `${listening.server.url.protocol}//127.0.0.1:${listening.server.port}`;
}

export async function startDesktopBackend(
  load: () => Promise<DesktopAppModule>,
  dataDir: string,
  mode: DesktopMode,
  runtime?: ApplicationRuntime
): Promise<DesktopBackend> {
  const nativeSignal = runtime?.kind === "desktop" ? runtime.signal : undefined;
  nativeSignal?.throwIfAborted();
  await mkdir(dataDir, { recursive: true });
  nativeSignal?.throwIfAborted();
  process.env.FURIN_APP_DATA_DIR = dataDir;
  // One startup budget, starting before the application import evaluates.
  const deadline = Date.now() + 30_000;
  let module: DesktopAppModule | undefined;
  let app: DesktopApp | undefined;
  let bootstrap: ReturnType<typeof startSessionBootstrap> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= withShutdownDeadline(
      (async () => {
        try {
          await (app ?? entry.app)?.stop(true);
        } finally {
          await (app ? getDesktopState(app) : entry.state)?.stop();
        }
      })()
    ).finally(async () => {
      await bootstrap?.stop();
    });
    return stopped;
  };
  const session = {
    name: `furin_desktop_${crypto.randomUUID().replaceAll("-", "")}`,
    value: crypto.randomUUID(),
  };
  let origin = "";
  const guard = createSessionGuard(
    session,
    () => origin,
    () => bootstrap?.origin,
    (destination) => bootstrap?.allows(destination) ?? false
  );
  const entry: DesktopEntry = { guard, mode, runtime };
  const startup = new AbortController();
  const listeningReady = Promise.withResolvers<void>();
  try {
    module = await withDesktopEntry(entry, () =>
      withDeadline(
        withCancellation(load(), nativeSignal),
        30_000,
        "Desktop startup exceeded 30 seconds while importing the application."
      )
    );
    app = module.default ?? entry.app;
    if (!app || typeof app.listen !== "function" || typeof app.stop !== "function") {
      throw new Error("Desktop entry must install desktopApp() or default-export an Elysia app.");
    }
    const state = getDesktopState(app);
    if (state) {
      state.runtime = runtime;
    }
    if (app.server && !state?.listening) {
      throw new Error(
        "Desktop app is already listening. Guard web boot with if (import.meta.main)."
      );
    }
    const activeApp = app;
    const loaded = module;
    // The plugin registered cleanup before any request could seal Elysia.
    state?.closed?.then(async () => {
      try {
        await activeApp.stop(true);
      } catch (error) {
        listeningReady.reject(error);
        return;
      }
      listeningReady.reject(
        new Error("Elysia stopped before desktop startup completed; check source setup errors.")
      );
    });
    listeningReady.promise.catch(() => undefined);
    return await withDeadline(
      withCancellation(
        (async () => {
          const validate = await activateDesktopApp(activeApp, guard, mode);
          startup.signal.throwIfAborted();
          nativeSignal?.throwIfAborted();
          startup.signal.throwIfAborted();
          const ownsListening = !!state?.listening && (!!activeApp.server || !loaded.default);
          if (!ownsListening && activeApp.server) {
            throw new Error("The desktop host owns listening.");
          }
          if (ownsListening) {
            await Promise.race([state.listening, listeningReady.promise]);
            const { server } = activeApp;
            if (!(server?.port && LISTEN_HOSTS.has(server.hostname ?? ""))) {
              throw new Error("The desktop listener must include the loopback interface.");
            }
            origin = `${server.url.protocol}//127.0.0.1:${server.port}`;
          } else {
            origin = listenDesktop(activeApp, mode, validate, listeningReady);
            await listeningReady.promise;
          }
          if (origin.startsWith("http:")) {
            bootstrap = startSessionBootstrap(session, origin);
          }
          const backend = createBackend(origin, session, bootstrap, stop, () => !!stopped);
          await state?.ready?.();
          startup.signal.throwIfAborted();
          nativeSignal?.throwIfAborted();
          return backend;
        })(),
        nativeSignal
      ),
      deadline - Date.now(),
      "Desktop startup exceeded 30 seconds while waiting for Elysia setup."
    );
  } catch (error) {
    if (!nativeSignal?.aborted || error !== nativeSignal.reason) {
      // Cleanup or the SDK's synchronous quit may prevent a later rethrow from printing.
      console.error("[furin-electrobun] Desktop startup failed:", error);
    }
    startup.abort(error);
    try {
      await stop();
    } catch (cleanupError) {
      // biome-ignore lint/style/useErrorCause: Startup is the primary cause; cleanup is preserved in the errors array.
      throw new AggregateError(
        [error, cleanupError],
        "Desktop startup failed and cleanup also failed.",
        { cause: error }
      );
    }
    throw error;
  }
}
