import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createBrowserEventsPlugin,
  createSseBrowserEventsPlugin,
} from "../../../src/server/browser-events/plugin.ts";
import type { SyncAdapter, SyncNotifier } from "../../../src/server/sync/adapter.ts";
import type { FurinSyncOptions, SyncConnectionLease } from "../../../src/server/sync/config.ts";
import { __resetSyncState } from "../../../src/server/sync/stream.ts";

afterEach(() => {
  __resetSyncState();
});

const adapter: SyncAdapter = {
  abortMutation: () => Promise.resolve(),
  appendInvalidations: () => Promise.resolve("0"),
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

test.each(["sse", "ws"] as const)(
  "%s checks cookie authentication over HEAD without acquiring a connection lease",
  async (transport) => {
    let acquired = 0;
    const sync = {
      adapter,
      notifier,
      principal: ({ request }: { request: Request }) =>
        request.headers.get("cookie") === "session=valid" ? "alice" : "",
      connection: (): undefined => {
        acquired += 1;
      },
    };
    const app = new Elysia().use(
      transport === "sse"
        ? createSseBrowserEventsPlugin({ development: true, sync })
        : createBrowserEventsPlugin({ development: true, sync })
    );
    expect(
      (await app.handle(new Request("http://localhost/_furin/events", { method: "HEAD" }))).status
    ).toBe(401);
    expect(
      (
        await app.handle(
          new Request("http://localhost/_furin/events", {
            method: "HEAD",
            headers: { cookie: "session=valid" },
          })
        )
      ).status
    ).toBe(200);
    expect(acquired).toBe(0);
  }
);

async function validityConnection(
  transport: "sse" | "ws",
  connection: FurinSyncOptions["connection"]
) {
  const sync = { adapter: () => adapter, notifier, principal: () => "alice", connection };
  if (transport === "sse") {
    const app = new Elysia().use(createSseBrowserEventsPlugin({ development: true, sync }));
    const response = await app.handle(new Request("http://localhost/_furin/events"));
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected an SSE response body");
    }
    return {
      close: () => reader.cancel(),
      next: async () => new TextDecoder().decode((await reader.read()).value),
    };
  }
  const app = new Elysia()
    .use(createBrowserEventsPlugin({ development: true, sync }))
    .listen({ port: 0, hostname: "127.0.0.1" });
  const origin = app.server?.url.origin;
  if (!origin) {
    throw new Error("Expected a listening server");
  }
  const socket = new WebSocket(`${origin.replace("http", "ws")}/_furin/events`);
  const queue: string[] = [];
  let pending: ((value: string) => void) | undefined;
  socket.addEventListener("message", (event) => {
    const value = String(event.data);
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(value);
    } else {
      queue.push(value);
    }
  });
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve());
  return {
    close: async () => {
      socket.close();
      await closed.promise;
      await app.stop(true);
    },
    next: () => {
      const value = queue.shift();
      return value === undefined
        ? new Promise<string>((resolve) => {
            pending = resolve;
          })
        : Promise.resolve(value);
    },
  };
}

test.each(["sse", "ws"] as const)(
  "%s releases a lease acquired after the connection closes",
  async (transport) => {
    const requested = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<SyncConnectionLease>();
    const released = Promise.withResolvers<void>();
    let releases = 0;
    const event = await validityConnection(transport, () => {
      requested.resolve();
      return acquired.promise;
    });
    await requested.promise;
    await event.close();
    acquired.resolve({
      signal: new AbortController().signal,
      release: () => {
        releases += 1;
        released.resolve();
      },
    });
    await released.promise;
    expect(releases).toBe(1);
  }
);

test.each(["sse", "ws"] as const)(
  "%s immediately handles an already interrupted validity signal",
  async (transport) => {
    const access = new AbortController();
    access.abort();
    let releases = 0;
    const event = await validityConnection(transport, () => ({
      signal: access.signal,
      release: () => {
        releases += 1;
      },
    }));
    try {
      if (transport === "sse") {
        await event.next();
      }
      expect(await event.next()).toContain('"context":"changed"');
    } finally {
      await event.close();
    }
    expect(releases).toBe(1);
  }
);

test.each(["sse", "ws"] as const)(
  "%s releases validity on a normal connection close",
  async (transport) => {
    let releases = 0;
    const event = await validityConnection(transport, () => ({
      signal: new AbortController().signal,
      release: () => {
        releases += 1;
      },
    }));
    if (transport === "sse") {
      await event.next();
    }
    expect(await event.next()).toContain('"cursor":"7"');
    await event.close();
    expect(releases).toBe(1);
  }
);

test.each(["sse", "ws"] as const)(
  "%s completes transport cleanup if application release throws",
  async (transport) => {
    let releases = 0;
    const event = await validityConnection(transport, () => ({
      signal: new AbortController().signal,
      release: () => {
        releases += 1;
        throw new Error("Application cleanup failed");
      },
    }));
    if (transport === "sse") {
      await event.next();
    }
    await event.next();
    await event.close();
    expect(releases).toBe(1);
  }
);

test("SSE signals an access-context change without a journal write and releases its lease once", async () => {
  const access = new AbortController();
  let releases = 0;
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      development: true,
      sync: {
        adapter,
        notifier,
        principal: () => "alice",
        connection: () => ({
          signal: access.signal,
          release: () => {
            releases += 1;
          },
        }),
      },
    })
  );
  const response = await app.handle(new Request("http://localhost/_furin/events"));
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected an SSE response body");
  }
  try {
    await reader.read();
    await reader.read();
    access.abort();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"context":"changed"');
    expect((await reader.read()).done).toBe(true);
    expect(releases).toBe(1);
  } finally {
    await reader.cancel();
  }
  expect(releases).toBe(1);
}, 1000);

test("SSE delivers sync cursors through app.handle without a listening server", async () => {
  let notify: ((cursor: string) => void) | undefined;
  let unsubscribed = false;
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      development: true,
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
    development: true,
    sync: { adapter, notifier, principal: () => "test" },
  });
  const admin = new Elysia({ prefix: "/admin" }).use(
    createSseBrowserEventsPlugin({
      development: true,
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

function userPrincipal({ request }: { request: Request }): string {
  const user = new URL(request.url).searchParams.get("user");
  if (user === null) {
    throw new Error("Unauthenticated");
  }
  return user;
}

test("SSE tells a browser to retry when connection capacity is full", async () => {
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      development: true,
      sync: { adapter, notifier, principal: userPrincipal },
    })
  );
  const connections = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      app.handle(new Request(`http://localhost/_furin/events?user=user-${index}`))
    )
  );
  try {
    expect(connections.map((response) => response.status)).toEqual(new Array(100).fill(200));
    const retry = await app.handle(new Request("http://localhost/_furin/events?user=late"));
    expect(retry.status).toBe(200);
    expect(retry.headers.get("content-type")).toStartWith("text/event-stream");
    expect(await retry.text()).toContain("retry: 5000");
  } finally {
    await Promise.all(connections.map((response) => response.body?.cancel()));
  }
});

test.each([
  ["an empty principal", () => ""],
  [
    "a throwing principal",
    () => {
      throw new Error("Unauthenticated");
    },
  ],
])("SSE rejects %s before reading the sync cursor", async (_, principal) => {
  let cursorReads = 0;
  let subscriptions = 0;
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      development: true,
      sync: {
        adapter: {
          ...adapter,
          currentCursor: () => {
            cursorReads += 1;
            return Promise.resolve("7");
          },
        },
        notifier: {
          publish: () => Promise.resolve(),
          subscribe: () => {
            subscriptions += 1;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
          },
        },
        principal,
      },
    })
  );
  const response = await app.handle(new Request("http://localhost/_furin/events"));
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("cursor");
  expect(cursorReads).toBe(0);
  expect(subscriptions).toBe(0);
});

test("SSE caps one principal without exhausting capacity for others", async () => {
  const app = new Elysia().use(
    createSseBrowserEventsPlugin({
      development: true,
      sync: { adapter, notifier, principal: userPrincipal },
    })
  );
  const connections = await Promise.all(
    Array.from({ length: 10 }, () =>
      app.handle(new Request("http://localhost/_furin/events?user=alice"))
    )
  );
  try {
    const retry = await app.handle(new Request("http://localhost/_furin/events?user=alice"));
    expect(await retry.text()).toBe("retry: 5000\n\n");
    const other = await app.handle(new Request("http://localhost/_furin/events?user=bob"));
    connections.push(other);
    const reader = other.body?.getReader();
    await reader?.read();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"cursor":"7"');
    reader?.releaseLock();
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
        development: true,
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
      development: true,
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
  // Elysia may drop the body of a request aborted while its principal resolves.
  const reader = response.body?.getReader();
  expect(reader === undefined || (await reader.read()).done).toBe(true);
  expect(subscribed).toBe(false);
});

test("browser event socket sends the current durable sync cursor", async () => {
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
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

test("WebSocket signals context changes and releases its application lease once", async () => {
  const access = new AbortController();
  let releases = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
        sync: {
          adapter,
          notifier,
          principal: () => "alice",
          connection: () => ({
            signal: access.signal,
            release: () => {
              releases += 1;
            },
          }),
        },
      })
    )
    .listen({ port: 0, hostname: "127.0.0.1" });
  const origin = app.server?.url.origin;
  if (!origin) {
    throw new Error("Expected a listening server");
  }
  const socket = new WebSocket(`${origin.replace("http", "ws")}/_furin/events`);
  const initial = Promise.withResolvers<void>();
  const changed = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("message", (event) => {
    if (JSON.parse(String(event.data)).data.context === "changed") {
      changed.resolve(String(event.data));
    } else {
      initial.resolve();
    }
  });
  socket.addEventListener("close", () => closed.resolve());
  try {
    await initial.promise;
    access.abort();
    expect(await changed.promise).toContain('"context":"changed"');
    await closed.promise;
    expect(releases).toBe(1);
  } finally {
    socket.close();
    await app.stop(true);
  }
}, 1000);

test("browser event socket remains available when notifier subscription fails", async () => {
  let cursor = "7";
  const recoveringAdapter: SyncAdapter = {
    ...adapter,
    currentCursor: () => Promise.resolve(cursor),
  };
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
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
        development: true,
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
  let validityReleased = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
        sync: {
          adapter,
          notifier,
          principal: () => "alice",
          connection: () => ({
            signal: new AbortController().signal,
            release: () => {
              validityReleased += 1;
            },
          }),
        },
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
    expect(validityReleased).toBe(1);
  } finally {
    await app.stop();
  }
});

function connect(url: string): Promise<{ opened: boolean; socket: WebSocket }> {
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    socket.addEventListener("open", () => resolve({ opened: true, socket }), { once: true });
    socket.addEventListener("error", () => resolve({ opened: false, socket }), { once: true });
  });
}

test("browser event socket rejects an unauthenticated upgrade before subscribing", async () => {
  let cursorReads = 0;
  const app = new Elysia().use(
    createBrowserEventsPlugin({
      development: true,
      sync: {
        adapter: {
          ...adapter,
          currentCursor: () => {
            cursorReads += 1;
            return Promise.resolve("7");
          },
        },
        notifier,
        principal: userPrincipal,
      },
    })
  );
  const response = await app.handle(
    new Request("http://localhost/_furin/events", {
      headers: {
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        upgrade: "websocket",
      },
    })
  );
  expect(response.status).toBe(401);
  expect(cursorReads).toBe(0);
});

test("browser event socket caps one principal without exhausting capacity for others", async () => {
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
        sync: { adapter, notifier, principal: userPrincipal },
      })
    )
    .listen(0);
  const base = `ws://127.0.0.1:${app.server?.port}/_furin/events`;
  const sockets: WebSocket[] = [];
  try {
    const alice = await Promise.all(
      Array.from({ length: 10 }, () => connect(`${base}?user=alice`))
    );
    sockets.push(...alice.map(({ socket }) => socket));
    expect(alice.every(({ opened }) => opened)).toBe(true);
    const overflow = await connect(`${base}?user=alice`);
    const bob = await connect(`${base}?user=bob`);
    sockets.push(overflow.socket, bob.socket);
    expect(overflow.opened).toBe(false);
    expect(bob.opened).toBe(true);
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await app.stop();
  }
});

test("browser event socket caps one peer address when no principal is configured", async () => {
  const app = new Elysia().use(createBrowserEventsPlugin({ development: true })).listen(0);
  const base = `ws://127.0.0.1:${app.server?.port}/_furin/events`;
  const sockets: WebSocket[] = [];
  try {
    const peers = await Promise.all(Array.from({ length: 10 }, () => connect(base)));
    sockets.push(...peers.map(({ socket }) => socket));
    expect(peers.every(({ opened }) => opened)).toBe(true);
    const overflow = await connect(base);
    sockets.push(overflow.socket);
    expect(overflow.opened).toBe(false);
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await app.stop();
  }
});

test("an unauthenticated development socket keeps source events without sync cursors", async () => {
  let cursorReads = 0;
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
        sources: [
          {
            subscribe: (listener) => {
              listener({
                channel: "devtools",
                data: { type: "ready" } as never,
                version: 1,
              });
              return { unsubscribe: () => undefined };
            },
          },
        ],
        sync: {
          adapter: {
            ...adapter,
            currentCursor: () => {
              cursorReads += 1;
              return Promise.resolve("7");
            },
          },
          notifier,
          principal: userPrincipal,
        },
      })
    )
    .listen(0);
  try {
    const { socket } = await connect(`ws://127.0.0.1:${app.server?.port}/_furin/events`);
    const event = await new Promise<string>((resolve) =>
      socket.addEventListener("message", (message) => resolve(String(message.data)), {
        once: true,
      })
    );
    socket.close();
    expect(JSON.parse(event).channel).toBe("devtools");
    await Bun.sleep(10);
    expect(cursorReads).toBe(0);
  } finally {
    await app.stop();
  }
});

test("browser event socket rejects connections above the per-instance limit", async () => {
  const app = new Elysia()
    .use(
      createBrowserEventsPlugin({
        development: true,
        sync: { adapter, notifier, principal: userPrincipal },
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event test server to listen");
  }
  const sockets: WebSocket[] = [];

  try {
    for (let index = 0; index < 100; index += 1) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_furin/events?user=user-${index}`);
      sockets.push(socket);
      // biome-ignore lint/performance/noAwaitInLoops: fill the connection map before opening the overflow socket
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Expected socket to open")), {
          once: true,
        });
      });
    }

    const overflow = new WebSocket(`ws://127.0.0.1:${port}/_furin/events?user=late`);
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
        development: true,
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
        sync: { adapter, notifier, principal: userPrincipal },
      })
    )
    .listen(0);
  const port = app.server?.port;
  if (port === undefined) {
    throw new Error("Expected browser event burst test server to listen");
  }
  const sockets = Array.from(
    { length: 120 },
    (_, index) => new WebSocket(`ws://127.0.0.1:${port}/_furin/events?user=user-${index}`)
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
