import { mkdir } from "node:fs/promises";
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
  bootstrapPath?: () => string | undefined
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
      `${url.pathname}${url.search}` === (bootstrapPath?.() ?? "/") &&
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
  let path = `/${crypto.randomUUID()}`;
  let origin = "";
  let spent = false;
  let stopped = false;
  let destination = new URL("/", appOrigin);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (spent) {
        return new Response("Gone", { status: 410, headers: { "cache-control": "no-store" } });
      }
      const url = new URL(request.url);
      const requestOrigin = request.headers.get("origin");
      if (
        request.method !== "GET" ||
        url.origin !== origin ||
        url.pathname !== path ||
        (requestOrigin && requestOrigin !== origin && requestOrigin !== appOrigin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      spent = true;
      return new Response(null, {
        status: 303,
        headers: {
          location: destination.href,
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
    destination: () => `${destination.pathname}${destination.search}`,
    createWindowUrl(target?: string) {
      if (stopped) {
        throw new Error("Desktop backend is stopped.");
      }
      const next = new URL(target ?? "/", appOrigin);
      if (next.origin !== appOrigin || next.username || next.password) {
        throw new Error("Desktop bootstrap destination must use the app origin.");
      }
      destination = next;
      path = `/${crypto.randomUUID()}`;
      spent = false;
      return `${origin}${path}`;
    },
    stop() {
      stopped = true;
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

export async function startDesktopBackend(
  load: () => Promise<DesktopAppModule>,
  dataDir: string,
  mode: DesktopMode
): Promise<DesktopBackend> {
  await mkdir(dataDir, { recursive: true });
  process.env.FURIN_APP_DATA_DIR = dataDir;
  const module = await load();
  const app = module.default;
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
    () => bootstrap?.destination()
  );
  let canceled = false;
  const startup = new AbortController();
  try {
    await withDeadline(
      (async () => {
        const validate = await activateDesktopApp(app, guard, mode);
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
        }
        await getDesktopState(app)?.start(startup.signal);
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
      })(),
      30_000,
      "Desktop startup exceeded 30 seconds while waiting for Elysia setup."
    );
    bootstrap = startSessionBootstrap(session, origin);
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
  return {
    origin,
    bootstrapOrigin: bootstrap.origin,
    url: bootstrap.url,
    cookie: `${session.name}=${session.value}`,
    createWindowUrl: (destination?: string) => {
      if (stopped) {
        throw new Error("Desktop backend is stopped.");
      }
      return bootstrap.createWindowUrl(destination);
    },
    stop,
  };
}
