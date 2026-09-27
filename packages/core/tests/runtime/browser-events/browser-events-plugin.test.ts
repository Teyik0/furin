import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createBrowserEventsPlugin,
  createSseBrowserEventsPlugin,
} from "../../../src/server/browser-events/plugin.ts";
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

test("SSE delivers sync cursors through app.handle without a listening server", async () => {
  let notify: ((cursor: string) => void) | undefined;
  let unsubscribed = false;
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      sync: {
        adapter,
        notifier: {
          publish: () => Promise.resolve(),
          subscribe(listener) {
            notify = listener;
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
    })
  );
  const response = await app.handle(new Request("http://localhost/_furin/events"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected an SSE response body");
  }
  try {
    const initial = await reader.read();
    const cursor = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toBe(": connected\n\n");
    expect(new TextDecoder().decode(cursor.value)).toContain('"cursor":"7"');
    notify?.("8");
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain('"cursor":"8"');
  } finally {
    await reader.cancel();
  }
  expect(unsubscribed).toBe(true);
});

test("SSE routes stay independent when Furin apps use different prefixes", async () => {
  const root = createSseBrowserEventsPlugin({
    sync: { adapter, notifier, principal: () => "test" },
  });
  const admin = new Elysia({ prefix: "/admin" }).use(
    createSseBrowserEventsPlugin({
      sync: {
        adapter: { ...adapter, currentCursor: () => Promise.resolve("9") },
        notifier,
        principal: () => "test",
      },
    })
  );
  const app = new Elysia().use(root).use(admin);
  const rootResponse = await app.handle(new Request("http://localhost/_furin/events"));
  const adminResponse = await app.handle(new Request("http://localhost/admin/_furin/events"));
  const rootReader = rootResponse.body?.getReader();
  const adminReader = adminResponse.body?.getReader();
  if (!(rootReader && adminReader)) {
    throw new Error("Expected both SSE response bodies");
  }
  try {
    await rootReader.read();
    await adminReader.read();
    const rootCursor = await rootReader.read();
    const adminCursor = await adminReader.read();
    expect(new TextDecoder().decode(rootCursor.value)).toContain('"cursor":"7"');
    expect(new TextDecoder().decode(adminCursor.value)).toContain('"cursor":"9"');
  } finally {
    await rootReader.cancel();
    await adminReader.cancel();
  }
});

test("SSE tells a browser to retry when connection capacity is full", async () => {
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      sync: { adapter, notifier, principal: () => "test" },
    })
  );
  const connections = await Promise.all(
    Array.from({ length: 100 }, () => app.handle(new Request("http://localhost/_furin/events")))
  );
  try {
    const retry = await app.handle(new Request("http://localhost/_furin/events"));
    expect(retry.status).toBe(200);
    expect(retry.headers.get("content-type")).toStartWith("text/event-stream");
    expect(await retry.text()).toContain("retry: 5000");
  } finally {
    await Promise.all(connections.map((response) => response.body?.cancel()));
  }
});

test.serial("SSE expires and releases its notifier subscription", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  let unsubscribed = false;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [callback, delay] = args;
    if (delay === 60_000 && typeof callback === "function") {
      expire = () => callback();
    }
    return originalSetTimeout(...args);
  }) as typeof setTimeout;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const app = new Elysia().use(
      createSseBrowserEventsPlugin({
        sync: {
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
      })
    );
    const response = await app.handle(new Request("http://localhost/_furin/events"));
    reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected an SSE response body");
    }
    await reader.read();
    await reader.read();
    if (!expire) {
      throw new Error("Expected an SSE connection lifetime timer");
    }
    expire();
    expect((await reader.read()).done).toBe(true);
    expect(unsubscribed).toBe(true);
  } finally {
    await reader?.cancel();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("SSE closes a request that was already aborted", async () => {
  let subscribed = false;
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      sync: {
        adapter,
        notifier: {
          publish: () => Promise.resolve(),
          subscribe: () => {
            subscribed = true;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
          },
        },
        principal: () => "test",
      },
    })
  );
  const abort = new AbortController();
  abort.abort();
  const response = await app.handle(
    new Request("http://localhost/_furin/events", { signal: abort.signal })
  );
  const reader = response.body?.getReader();
  expect((await reader?.read())?.done).toBe(true);
  expect(subscribed).toBe(false);
});

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

test("a reconnect burst never subscribes sources above the connection limit", async () => {
  let activeSubscriptions = 0;
  let maximumSubscriptions = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        sources: [
          {
            subscribe: () => {
              activeSubscriptions += 1;
              maximumSubscriptions = Math.max(maximumSubscriptions, activeSubscriptions);
              return {
                unsubscribe: () => {
                  activeSubscriptions -= 1;
                },
              };
            },
          },
        ],
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event burst test server to listen");
  }
  const sockets = Array.from(
    { length: 120 },
    () => new WebSocket(`ws://127.0.0.1:${port}/_furin/events`)
  );

  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.addEventListener("open", () => resolve(), { once: true });
              socket.addEventListener("error", () => resolve(), { once: true });
              socket.addEventListener("close", () => resolve(), { once: true });
            })
        )
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the browser event reconnect burst")),
          2000
        );
      }),
    ]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
    await Bun.sleep(20);

    expect(maximumSubscriptions).toBeLessThanOrEqual(100);
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await app.stop();
  }
});
