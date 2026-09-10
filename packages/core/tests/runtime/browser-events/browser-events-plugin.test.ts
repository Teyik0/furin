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
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sync: {
          adapter,
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
    });

    expect(JSON.parse(event)).toMatchObject({ channel: "sync", data: { cursor: "7" } });
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
