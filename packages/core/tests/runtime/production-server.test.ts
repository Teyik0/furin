import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createBrowserEventsPlugin } from "../../src/server/browser-events/plugin.ts";
import { createFurinEvlog } from "../../src/server/evlog.ts";
import { startProductionServer } from "../../src/server/production-server.ts";

describe("Bun production lifecycle", () => {
  test("separates liveness and readiness while draining in-flight requests", async () => {
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
      preStopDelayMs: 100,
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
      expect((await fetch(`${origin}/slow`)).status).toBe(503);
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
      preStopDelayMs: 200,
      shutdownTimeoutMs: 200,
    });

    try {
      const slow = fetch(`http://localhost:${lifecycle.server.port}/slow`);
      await entered;
      const shutdown = lifecycle.shutdown();
      await Bun.sleep(250);
      resolve();
      expect(await (await slow).text()).toBe("finished");
      await shutdown;
    } finally {
      resolve();
      await lifecycle.shutdown();
    }
  });
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
  } finally {
    firstSocket.close();
    secondSocket.close();
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});
