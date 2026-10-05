import { mkdir } from "node:fs/promises";
import { activateDesktopApp, type DesktopMode } from "./registry";

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

export function createSessionGuard(session: DesktopSession, origin: () => string) {
  return (request: Request): Response | undefined => {
    const url = new URL(request.url);
    const expected = origin();
    const requestOrigin = request.headers.get("origin");
    if (
      url.origin !== expected ||
      (requestOrigin && requestOrigin !== expected) ||
      request.headers.get("sec-fetch-site") === "cross-site"
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
  let spent = false;
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
          location: `${appOrigin}/`,
          "set-cookie": `${session.name}=${session.value}; HttpOnly; SameSite=Strict; Path=/`,
          "cache-control": "no-store",
        },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, url: `${origin}${path}`, stop: () => server.stop(true) };
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
) {
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
          await module.onShutdown?.();
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
  const guard = createSessionGuard(session, () => origin);
  let canceled = false;
  try {
    await withDeadline(
      (async () => {
        const validate = await activateDesktopApp(app, guard, mode);
        if (canceled) {
          throw new Error("Desktop startup was canceled.");
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
  return { origin, bootstrapOrigin: bootstrap.origin, url: bootstrap.url, stop };
}
