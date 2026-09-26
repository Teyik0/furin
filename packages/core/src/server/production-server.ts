import type { AnyElysia } from "elysia";
import { closeBrowserEventConnections } from "./browser-events/shutdown.ts";
import { waitForPendingISRRevalidations } from "./cache/isr.ts";
import { setRuntimeEvlogWaitUntil } from "./evlog.ts";
import { closeSyncCursorStates, waitForSyncCursorUnsubscriptions } from "./sync/stream.ts";

const DEFAULT_PRE_STOP_DELAY_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const activeShutdowns = new Set<() => Promise<void>>();
const syncDrainsReached = new Set<() => Promise<void>>();

const signalShutdown = (): void => {
  Promise.allSettled([...activeShutdowns].map((shutdown) => shutdown())).then((results) => {
    let code = process.exitCode ?? 0;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[furin] Graceful shutdown failed", result.reason);
        code = 1;
      }
    }
    process.exit(code);
  });
};

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
  let rejecting = false;

  const unregisterWaitUntil = setRuntimeEvlogWaitUntil((emission) => {
    pendingEmissions.add(emission);
    emission.finally(() => pendingEmissions.delete(emission)).catch(() => undefined);
  });

  app
    .wrap((fetch) => (request, ...rest) => {
      const path = new URL(request.url).pathname;
      if (rejecting && path !== "/_furin/health/live" && path !== "/_furin/health/ready") {
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
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Bun.sleep(delayMs);
        rejecting = true;
        const deadline = new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            console.error("[furin] Shutdown deadline exceeded; forcing server stop");
            server.stop(true).catch((error: unknown) => {
              console.error("[furin] Forced server stop failed", error);
            });
            resolve();
          }, timeoutMs);
        });
        const drain = async (): Promise<void> => {
          closeBrowserEventConnections(server);
          server.closeIdleConnections();
          await server.stop();
          await waitForPendingISRRevalidations();
          await Promise.allSettled([...pendingEmissions]);
          syncDrainsReached.add(shutdown);
          if (syncDrainsReached.size === activeShutdowns.size) {
            await closeSyncCursorStates();
          } else {
            await waitForSyncCursorUnsubscriptions();
          }
          await options.onShutdown?.();
        };
        await Promise.race([drain(), deadline]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        activeShutdowns.delete(shutdown);
        syncDrainsReached.delete(shutdown);
        if (activeShutdowns.size === 0) {
          process.off("SIGTERM", signalShutdown);
          process.off("SIGINT", signalShutdown);
        }
        unregisterWaitUntil();
      }
    })();
    return shutdownPromise;
  };

  if (activeShutdowns.size === 0) {
    process.on("SIGTERM", signalShutdown);
    process.on("SIGINT", signalShutdown);
  }
  activeShutdowns.add(shutdown);
  return { server, shutdown };
}
