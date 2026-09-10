import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createBrowserEventsPlugin } from "../../../src/server/browser-events/plugin.ts";
import type { SyncAdapter, SyncNotifier } from "../../../src/server/sync/adapter.ts";
import { __resetSyncState } from "../../../src/server/sync/stream.ts";

afterEach(() => {
  __resetSyncState();
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

const notifier: SyncNotifier = {
  publish: () => Promise.resolve(),
  subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
};

test("browser event socket sends the current durable sync cursor", async () => {
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sync: {
          adapter,
          notifier,
          principal: () => "test",
        },
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }

  try {
    const event = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for sync cursor")),
        2000
      );
      socket.addEventListener("message", (message) => {
        clearTimeout(timeout);
        socket.close();
        resolve(String(message.data));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Browser event socket failed"));
      });
    });

    expect(JSON.parse(event)).toEqual({
      channel: "sync",
      data: { cursor: "7" },
      version: 1,
    });
  } finally {
    await app.stop();
  }
});

test("browser event socket remains available when notifier subscription fails", async () => {
  let cursor = "7";
  const recoveringAdapter: SyncAdapter = {
    ...adapter,
    currentCursor: () => Promise.resolve(cursor),
  };
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sync: {
          adapter: recoveringAdapter,
          notifier: {
            publish: () => Promise.resolve(),
            subscribe: () => Promise.reject(new Error("notifier unavailable")),
          },
          principal: () => "test",
        },
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }

  try {
    const events = await new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
      const received: string[] = [];
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for recovered sync cursor")),
        2000
      );
      socket.addEventListener("message", (message) => {
        const serialized = String(message.data);
        received.push(serialized);
        const event = JSON.parse(serialized) as { data?: { cursor?: string } };
        if (event.data?.cursor === "7") {
          cursor = "8";
        } else if (event.data?.cursor === "8") {
          clearTimeout(timeout);
          socket.close();
          resolve(received);
        }
      });
    });

    expect(events.map((event) => JSON.parse(event).data.cursor)).toEqual(["7", "8"]);
  } finally {
    await app.stop();
  }
});

test("browser event socket releases notifier subscriptions when the tab closes", async () => {
  let unsubscribed = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sync: {
          adapter,
          notifier: {
            publish: () => Promise.resolve(),
            subscribe: () =>
              Promise.resolve({
                unsubscribe: () => {
                  unsubscribed += 1;
                  return Promise.resolve();
                },
              }),
          },
          principal: () => "test",
        },
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for sync cursor")),
        2000
      );
      socket.addEventListener("message", () => {
        clearTimeout(timeout);
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    });
    await Bun.sleep(10);

    expect(unsubscribed).toBe(1);
  } finally {
    await app.stop();
  }
});

test("browser event socket releases successful source subscriptions when another fails", async () => {
  let unsubscribed = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sources: [
          {
            subscribe: () => ({
              unsubscribe: () => {
                unsubscribed += 1;
              },
            }),
          },
          {
            subscribe: () => Promise.reject(new Error("source unavailable")),
          },
        ],
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for failed source cleanup")),
        2000
      );
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(unsubscribed).toBe(1);
  } finally {
    await app.stop();
  }
});

test("browser event socket rejects connections above the per-instance limit", async () => {
  const app = new Elysia().use(createBrowserEventsPlugin({})).listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }
  const sockets: WebSocket[] = [];

  try {
    for (let index = 0; index < 100; index += 1) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
      sockets.push(socket);
      // biome-ignore lint/performance/noAwaitInLoops: fill the connection map before opening the overflow socket
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Expected socket to open")), {
          once: true,
        });
      });
    }

    const overflow = new WebSocket(`ws://127.0.0.1:${port}/_furin/events`);
    sockets.push(overflow);
    const rejected = await new Promise<boolean>((resolve) => {
      overflow.addEventListener("open", () => resolve(false), { once: true });
      overflow.addEventListener("error", () => resolve(true), { once: true });
    });
    expect(rejected).toBe(true);
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await app.stop();
  }
});
