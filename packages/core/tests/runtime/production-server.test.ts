import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import { createBrowserEventsPlugin } from "../../src/server/browser-events/plugin.ts";
import { createFurinEvlog } from "../../src/server/evlog.ts";
import { startProductionServer } from "../../src/server/production-server.ts";
import type { SyncAdapter } from "../../src/server/sync/adapter.ts";
import { subscribeSyncCursor } from "../../src/server/sync/stream.ts";

test.each([
  { code: 7, mode: "success" },
  { code: 1, mode: "failure" },
  { code: 7, mode: "deadline" },
])("signal shutdown exits with lingering handles: $mode", async ({ mode, code }) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { Elysia } from "elysia";
    import { startProductionServer } from "./src/server/production-server.ts";
    setInterval(() => {}, 1000);
    process.exitCode = 7;
    startProductionServer({
      app: new Elysia().get("/", () => "ok"), port: 0,
      preStopDelayMs: 0, shutdownTimeoutMs: 100,
      onShutdown: async () => {
        if (${JSON.stringify(mode)} === "failure") throw new Error("cleanup failed");
        if (${JSON.stringify(mode)} === "deadline") await new Promise(() => {});
      },
    });
    startProductionServer({
      app: new Elysia(), port: 0,
      preStopDelayMs: 0, shutdownTimeoutMs: 1000,
      onShutdown: async () => {
        await Bun.sleep(200);
        console.log("SECOND_SERVER_DRAINED");
      },
    });
    process.emit("SIGTERM");
  `,
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stderr: "pipe", stdout: "pipe" }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 3000);
      }),
    ]);
    expect(result).toBe(code);
    expect(await new Response(child.stdout).text()).toContain("SECOND_SERVER_DRAINED");
    if (mode === "failure") {
      expect(await new Response(child.stderr).text()).toContain("Graceful shutdown failed");
    }
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
});

describe("Bun production lifecycle", () => {
  test("separates liveness and readiness while draining in-flight requests", async () => {
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const app = new Elysia()
      .get("/slow", async () => {
        markEntered();
        await release;
        return "finished";
      })
      .get("/_furin/health/admin", () => "private")
      .get("/", () => "ok");
    const lifecycle = startProductionServer({
      app,
      port: 0,
      preStopDelayMs: 1000,
      shutdownTimeoutMs: 2000,
    });
    const origin = `http://localhost:${lifecycle.server.port}`;

    try {
      expect((await fetch(`${origin}/_furin/health/live`)).status).toBe(200);
      expect((await fetch(`${origin}/_furin/health/ready`)).status).toBe(200);
      const slow = fetch(`${origin}/slow`);
      await entered;
      const shutdown = lifecycle.shutdown();
      expect((await fetch(`${origin}/_furin/health/ready`)).status).toBe(503);
      expect((await fetch(`${origin}/_furin/health/live`)).status).toBe(200);
      expect(await (await fetch(`${origin}/`)).text()).toBe("ok");
      expect((await fetch(`${origin}/_furin/health/admin`)).status).toBe(200);
      resolve();
      expect(await (await slow).text()).toBe("finished");
      await shutdown;
    } finally {
      resolve();
      await lifecycle.shutdown();
    }
  });

  test("starts the connection-drain timeout after the pre-stop delay", async () => {
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const app = new Elysia().get("/slow", async () => {
      markEntered();
      await release;
      return "finished";
    });
    const lifecycle = startProductionServer({
      app,
      port: 0,
      preStopDelayMs: 1000,
      shutdownTimeoutMs: 500,
    });

    try {
      const slow = fetch(`http://localhost:${lifecycle.server.port}/slow`);
      await entered;
      const shutdown = lifecycle.shutdown();
      await Bun.sleep(1050);
      resolve();
      expect(await (await slow).text()).toBe("finished");
      await shutdown;
    } finally {
      resolve();
      await lifecycle.shutdown();
    }
  });
});

test("bounds application cleanup by the shutdown timeout", async () => {
  const { promise: cleanupStarted, resolve: markCleanupStarted } = Promise.withResolvers<void>();
  const { promise: releaseCleanup, resolve } = Promise.withResolvers<void>();
  const lifecycle = startProductionServer({
    app: new Elysia().get("/", () => "ok"),
    onShutdown: () => {
      markCleanupStarted();
      return releaseCleanup;
    },
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 1000,
  });

  try {
    let completed = false;
    const shutdown = lifecycle.shutdown().then(() => {
      completed = true;
      return "stopped";
    });
    await Promise.race([
      cleanupStarted,
      Bun.sleep(1500).then(() => {
        throw new Error("Application cleanup did not start");
      }),
    ]);
    expect(completed).toBe(false);
    const result = await Promise.race([shutdown, Bun.sleep(1400).then(() => "timed-out")]);
    expect(result).toBe("stopped");
  } finally {
    resolve();
    await lifecycle.shutdown();
  }
});

test("a second server does not steal the first server's pending log drains", async () => {
  const { promise: releaseDrain, resolve } = Promise.withResolvers<void>();
  const { promise: drainStarted, resolve: markDrainStarted } = Promise.withResolvers<void>();
  const first = startProductionServer({
    app: new Elysia()
      .use(
        createFurinEvlog({
          drain: async () => {
            markDrainStarted();
            await releaseDrain;
          },
        })
      )
      .get("/", () => "ok"),
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  const second = startProductionServer({
    app: new Elysia().get("/", () => "ok"),
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });

  try {
    await fetch(`http://localhost:${first.server.port}/`);
    await drainStarted;
    let completed = false;
    const shutdown = first.shutdown().then(() => {
      completed = true;
    });
    await Bun.sleep(20);
    expect(completed).toBe(false);
    resolve();
    await shutdown;
  } finally {
    resolve();
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});

test("waits for deferred log drains before application resource cleanup", async () => {
  const { promise: releaseDrain, resolve: resolveDrain } = Promise.withResolvers<void>();
  const { promise: drainStarted, resolve: markDrainStarted } = Promise.withResolvers<void>();
  const order: string[] = [];
  const app = new Elysia()
    .use(
      createFurinEvlog({
        drain: async () => {
          markDrainStarted();
          await releaseDrain;
          order.push("drain");
        },
      })
    )
    .get("/", () => "ok");
  const lifecycle = startProductionServer({
    app,
    onShutdown: () => {
      order.push("shutdown");
    },
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });

  try {
    await fetch(`http://localhost:${lifecycle.server.port}/`);
    await drainStarted;
    let completed = false;
    const shutdown = lifecycle.shutdown().then(() => {
      completed = true;
    });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    resolveDrain();
    await shutdown;
    expect(order).toEqual(["drain", "shutdown"]);
  } finally {
    resolveDrain();
    await lifecycle.shutdown();
  }
});

test("closes Furin browser-event WebSockets before stopping Bun", async () => {
  const app = new Elysia().use(createBrowserEventsPlugin({}));
  const lifecycle = startProductionServer({
    app,
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  const socket = new WebSocket(`ws://localhost:${lifecycle.server.port}/_furin/events`);
  const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<number>();
  socket.addEventListener("open", () => markOpened());
  socket.addEventListener("close", (event) => markClosed(event.code));

  try {
    await opened;
    await lifecycle.shutdown();
    expect(await closed).toBe(1001);
  } finally {
    socket.close();
    await lifecycle.shutdown();
  }
});

test("shutting down one server leaves another server's browser-event sockets open", async () => {
  const first = startProductionServer({
    app: new Elysia().use(createBrowserEventsPlugin({})),
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  const second = startProductionServer({
    app: new Elysia().use(createBrowserEventsPlugin({})),
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.reject(new Error("not used")),
    completeMutation: () => Promise.reject(new Error("not used")),
    currentCursor: () => Promise.resolve("7"),
    readChanges: () => Promise.reject(new Error("not used")),
    renewMutation: () => Promise.reject(new Error("not used")),
    scope: "host-local",
  };
  let publish: (cursor: string) => void = () => undefined;
  const cursors: string[] = [];
  let unsubscribed = false;
  const subscription = await subscribeSyncCursor(
    {
      adapter,
      notifier: {
        publish: () => Promise.resolve(),
        subscribe: (listener) => {
          publish = listener;
          return Promise.resolve({
            unsubscribe: () => {
              unsubscribed = true;
              return Promise.resolve();
            },
          });
        },
      },
      principal: () => "test",
    },
    (cursor) => cursors.push(cursor)
  );
  const firstSocket = new WebSocket(`ws://localhost:${first.server.port}/_furin/events`);
  const secondSocket = new WebSocket(`ws://localhost:${second.server.port}/_furin/events`);
  const firstClosed = new Promise<void>((resolve) =>
    firstSocket.addEventListener("close", () => resolve(), { once: true })
  );

  try {
    await Promise.all(
      [firstSocket, secondSocket].map(
        (socket) =>
          new Promise<void>((resolve) =>
            socket.addEventListener("open", () => resolve(), { once: true })
          )
      )
    );
    await first.shutdown();
    await firstClosed;
    expect(firstSocket.readyState).toBe(WebSocket.CLOSED);
    expect(secondSocket.readyState).toBe(WebSocket.OPEN);
    publish("8");
    expect(unsubscribed).toBe(false);
    expect(cursors).toEqual(["7", "8"]);
  } finally {
    subscription.unsubscribe();
    firstSocket.close();
    secondSocket.close();
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});

test("concurrent server shutdowns close shared Sync cursor subscriptions", async () => {
  const { promise: bothDrained, resolve: markBothDrained } = Promise.withResolvers<void>();
  const { promise: releaseCleanup, resolve: release } = Promise.withResolvers<void>();
  let drains = 0;
  const onShutdown = () => {
    drains += 1;
    if (drains === 2) {
      markBothDrained();
    }
    return releaseCleanup;
  };
  const first = startProductionServer({
    app: new Elysia().get("/", () => "ok"),
    onShutdown,
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  const second = startProductionServer({
    app: new Elysia().get("/", () => "ok"),
    onShutdown,
    port: 0,
    preStopDelayMs: 0,
    shutdownTimeoutMs: 2000,
  });
  let unsubscribed = false;
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.reject(new Error("not used")),
    completeMutation: () => Promise.reject(new Error("not used")),
    currentCursor: () => Promise.resolve("0"),
    readChanges: () => Promise.reject(new Error("not used")),
    renewMutation: () => Promise.reject(new Error("not used")),
    scope: "host-local",
  };
  const subscription = await subscribeSyncCursor(
    {
      adapter,
      notifier: {
        publish: () => Promise.resolve(),
        subscribe: () =>
          Promise.resolve({
            unsubscribe: () => {
              unsubscribed = true;
              return Promise.resolve();
            },
          }),
      },
      principal: () => "test",
    },
    () => undefined
  );

  try {
    const shutdowns = Promise.all([first.shutdown(), second.shutdown()]);
    await bothDrained;
    release();
    await shutdowns;
    expect(unsubscribed).toBe(true);
  } finally {
    release();
    subscription.unsubscribe();
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});
