import { mkdir } from "node:fs/promises";
import type { ApplicationRuntime } from "./capabilities";
import { activateDesktopApp, type DesktopMode, getDesktopState } from "./registry";

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
  cleanup: (handler: () => void) => unknown;
  listen: (
    options: { hostname: string; port: number; development: boolean },
    callback: (server: { port?: number; stop: (force: boolean) => void | Promise<void> }) => void
  ) => DesktopApp;
  server?: { port?: number };
  stop: (closeActiveConnections: boolean) => Promise<void> | undefined;
}

export interface DesktopAppModule {
  default: DesktopApp;
  onShutdown?: () => void | Promise<void>;
  onStartup?: (signal: AbortSignal) => void | Promise<void>;
}

/** In-process host capabilities. Never expose the cookie to browser scripts or logs. */
export interface DesktopBackend {
  bootstrapOrigin: string;
  cookie: string;
  createWindowUrl: (destination?: string) => string;
  origin: string;
  stop: () => Promise<void>;
  url: string;
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

export function withStartupDeadline<T>(pending: Promise<T>): Promise<T> {
  return withDeadline(pending, 30_000, "Desktop service recovery exceeded 30 seconds.");
}

export async function startDesktopBackend(
  load: () => Promise<DesktopAppModule>,
  dataDir: string,
  mode: DesktopMode,
  runtime?: ApplicationRuntime
): Promise<DesktopBackend> {
  await mkdir(dataDir, { recursive: true });
  process.env.FURIN_APP_DATA_DIR = dataDir;
  const module = await load();
  const app = module.default;
  const state = app ? getDesktopState(app) : undefined;
  if (state) {
    state.runtime = runtime;
  }
  if (!app || typeof app.listen !== "function" || typeof app.stop !== "function") {
    throw new Error("Desktop server must default-export an Elysia app.");
  }
  let bootstrap: ReturnType<typeof startSessionBootstrap> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= withShutdownDeadline(
      (async () => {
        try {
          await app.stop(true);
        } finally {
          try {
            await getDesktopState(app)?.stop();
          } finally {
            await module.onShutdown?.();
          }
        }
      })()
    ).finally(async () => {
      await bootstrap?.stop();
    });
    return stopped;
  };
  if (app.server) {
    await stop();
    throw new Error("Desktop app is already listening. Guard web boot with if (import.meta.main).");
  }
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
  let canceled = false;
  const startup = new AbortController();
  try {
    return await withDeadline(
      (async () => {
        const validate = await activateDesktopApp(app, guard, mode);
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
        }
        await getDesktopState(app)?.start(startup.signal);
        if (runtime?.kind === "desktop") {
          runtime.signal?.throwIfAborted();
        }
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
        }
        await module.onStartup?.(startup.signal);
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
        }
        if (app.server) {
          throw new Error("onStartup must not open a listener; the desktop host owns listening.");
        }
        await new Promise<void>((resolve, reject) => {
          app.cleanup(() => {
            reject(
              new Error(
                "Elysia stopped before desktop startup completed; check source setup errors."
              )
            );
          });
          const listening = app.listen(
            { hostname: "127.0.0.1", port: 0, development: mode === "dev" },
            (server) => {
              try {
                validate();
                resolve();
              } catch (error) {
                // Stop the native listener in this callback, before readiness or
                // another event-loop turn can expose a late native HTML route.
                Promise.resolve(server.stop(true)).catch(console.error);
                reject(error);
              }
            }
          );
          if (!listening.server?.port) {
            throw new Error("Elysia did not create a desktop server.");
          }
          origin = `http://127.0.0.1:${listening.server.port}`;
        });
        bootstrap = startSessionBootstrap(session, origin);
        const activeBootstrap = bootstrap;
        const backend: DesktopBackend = {
          origin,
          bootstrapOrigin: activeBootstrap.origin,
          url: activeBootstrap.url,
          cookie: `${session.name}=${session.value}`,
          createWindowUrl(destination) {
            if (stopped) {
              throw new Error("Desktop backend is stopped.");
            }
            return activeBootstrap.createWindowUrl(destination);
          },
          stop,
        };
        await state?.ready?.(backend);
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
        }
        if (runtime?.kind === "desktop") {
          runtime.signal?.throwIfAborted();
        }
        return backend;
      })(),
      30_000,
      "Desktop startup exceeded 30 seconds while waiting for Elysia setup."
    );
  } catch (error) {
    canceled = true;
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
