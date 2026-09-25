import type { AnyElysia } from "elysia";
import { closeBrowserEventConnections } from "./browser-events/shutdown.ts";
import { waitForPendingISRRevalidations } from "./cache/isr.ts";
import { setRuntimeEvlogWaitUntil } from "./evlog.ts";
import { closeSyncCursorStates } from "./sync/stream.ts";

const DEFAULT_PRE_STOP_DELAY_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface ProductionServerOptions {
  app: AnyElysia;
  idleTimeout?: number;
  onShutdown?: () => Promise<void> | void;
  port: number;
  preStopDelayMs?: number;
  shutdownTimeoutMs?: number;
}

export function startProductionServer(options: ProductionServerOptions): {
  server: Bun.Server<unknown>;
  shutdown: () => Promise<void>;
} {
  const { app } = options;
  const pendingEmissions = new Set<Promise<unknown>>();
  let draining = false;

  setRuntimeEvlogWaitUntil((emission) => {
    pendingEmissions.add(emission);
    emission.finally(() => pendingEmissions.delete(emission)).catch(() => undefined);
  });

  app
    .wrap((fetch) => (request, ...rest) => {
      const path = new URL(request.url).pathname;
      if (draining && !path.startsWith("/_furin/health/")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return fetch(request, ...rest);
    })
    .get("/_furin/health/live", () =>
      Response.json({ status: "alive" }, { headers: { "cache-control": "no-store" } })
    )
    .get("/_furin/health/ready", () =>
      Response.json(
        { status: draining ? "draining" : "ready" },
        { headers: { "cache-control": "no-store" }, status: draining ? 503 : 200 }
      )
    );

  app.listen(
    options.idleTimeout === undefined
      ? options.port
      : { idleTimeout: options.idleTimeout, port: options.port }
  );
  const { server } = app;
  if (!server) {
    throw new Error("[furin] Bun server did not start");
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    draining = true;
    const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const delayMs = options.preStopDelayMs ?? DEFAULT_PRE_STOP_DELAY_MS;
    shutdownPromise = (async () => {
      const timeout = setTimeout(() => {
        server.stop(true).catch((error: unknown) => {
          console.error("[furin] Forced server stop failed", error);
        });
      }, timeoutMs);
      try {
        await Bun.sleep(delayMs);
        closeBrowserEventConnections();
        server.closeIdleConnections();
        await server.stop();
        await waitForPendingISRRevalidations();
        await Promise.allSettled([...pendingEmissions]);
        await closeSyncCursorStates();
        await options.onShutdown?.();
      } finally {
        clearTimeout(timeout);
        process.off("SIGTERM", signalShutdown);
        process.off("SIGINT", signalShutdown);
      }
    })();
    return shutdownPromise;
  };

  const signalShutdown = (): void => {
    shutdown().then(
      () => undefined,
      (error: unknown) => {
        console.error("[furin] Graceful shutdown failed", error);
        process.exitCode = 1;
      }
    );
  };
  process.on("SIGTERM", signalShutdown);
  process.on("SIGINT", signalShutdown);
  return { server, shutdown };
}
