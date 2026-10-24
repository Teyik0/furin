import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { createBrowserEventsPlugin } from "../../../src/server/browser-events/plugin.ts";
import type { FurinSyncOptions } from "../../../src/server/sync/config.ts";
import { furinSync as serverSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { closeSyncCursorStates, createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";
import { createSyncClient, furinSync, SyncClientError } from "../../../src/sync-client.ts";

const RuntimeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: { headers: Headers }): WebSocket;
};

const cleanup: (() => void | Promise<void>)[] = [];
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for sync");
    }
    // biome-ignore lint/performance/noAwaitInLoops: wait for observable asynchronous state.
    await Bun.sleep(5);
  }
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    // biome-ignore lint/performance/noAwaitInLoops: close clients before their server and database.
    await close();
  }
});

function fixture(
  onRead?: (value: number) => Promise<void>,
  auth?: Partial<Pick<FurinSyncOptions, "connection" | "principal">>
) {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const sync = {
    adapter: sqliteSyncAdapter({ database, namespace: "standalone" }),
    connection: auth?.connection,
    principal:
      auth?.principal ??
      (({ headers }: { headers: { [name: string]: string | undefined } }) =>
        headers.authorization === "deny"
          ? ""
          : ((headers.authorization ?? "alice").split(":")[0] ?? "")),
  };
  let value = 0;
  let permitted = true;
  const reads = { state: 0, other: 0 };
  const routes = new Elysia()
    .use(serverSync(sync))
    .use(createSyncChangesPlugin(sync))
    .get("/login", () =>
      Response.json(
        { signedIn: true },
        { headers: { "set-cookie": "session=alice; HttpOnly; SameSite=Lax; Path=/" } }
      )
    )
    .get("/state", async () => {
      reads.state += 1;
      const snapshot = value;
      await onRead?.(snapshot);
      return { value: snapshot };
    })
    .get("/other", () => {
      reads.other += 1;
      return { value };
    })
    .get("/fallible", ({ status }) =>
      value === 0 ? { value } : status(409, { code: "LOCKED" as const })
    )
    .get("/identity", ({ headers }) => ({ principal: headers.authorization ?? "alice" }))
    .get("/denied", ({ status }) => status(403, { code: "DENIED" as const }))
    .get("/restricted", ({ status }) =>
      permitted ? { value } : status(403, { code: "RESOURCE_DENIED" as const })
    )
    .post("/state", () => {
      value += 1;
      return { value };
    });
  const app = routes
    .use(createBrowserEventsPlugin({ development: true, sync }))
    .listen({ port: 0, hostname: "127.0.0.1" });
  cleanup.push(async () => {
    await app.stop(true);
    await closeSyncCursorStates();
    database.close();
  });
  const url = app.server?.url.origin;
  if (!url) {
    throw new Error("Expected a listening server");
  }
  const api = treaty<typeof routes>(url).use(furinSync);
  const client = createSyncClient({ url });
  cleanup.push(() => client.close());
  return {
    api,
    client,
    url,
    reads,
    sync,
    routes,
    setPermission: (allowed: boolean) => {
      permitted = allowed;
    },
  };
}

test("a standalone subscriber receives the initial value and subsequent journaled changes", async () => {
  const { api, client } = fixture();
  const values: number[] = [];
  const stop = client.subscribe(api.state.get.live(), ({ data }) => {
    if (data) {
      values.push(data.value);
    }
  });
  await until(() => values.at(-1) === 0);
  await api.state.post(undefined, {});
  await until(() => values.at(-1) === 1);
  expect(client.getConnectionState().status).toBe("connected");
  stop();
});

test("multiple queries share one connection and recover missed changes after a disconnect", async () => {
  const { api, url, reads } = fixture();
  const sockets: WebSocket[] = [];
  const cursors: string[] = [];
  const client = createSyncClient({
    url,
    fetcher: ((input, init) => {
      cursors.push(new URL(String(input)).searchParams.get("after") ?? "missing");
      return fetch(input, init);
    }) as typeof fetch,
    createWebSocket: (address) => {
      const socket = new WebSocket(address);
      sockets.push(socket);
      return socket;
    },
  });
  cleanup.push(() => client.close());
  let state: number | undefined;
  let other: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    state = data?.value;
  });
  client.subscribe(api.other.get.live(), ({ data }) => {
    other = data?.value;
  });
  client.subscribe(api.state.get.live(), () => undefined);
  await until(() => state === 0 && other === 0);
  expect(sockets).toHaveLength(1);
  expect(reads).toEqual({ state: 1, other: 1 });
  await api.state.post(undefined, {});
  await until(() => state === 1);
  sockets[0]?.close();
  await until(() => client.getConnectionState().status === "reconnecting");
  await api.state.post(undefined, {});
  await until(() => state === 2 && client.getConnectionState().status === "connected");
  expect(sockets).toHaveLength(2);
  expect(cursors).toContain("1");
  expect(reads.other).toBe(1);
});

test("subscribers receive Eden's typed endpoint errors", async () => {
  const { api, client } = fixture();
  await api.state.post(undefined, {});
  const errors: string[] = [];
  client.subscribe(api.fallible.get.live(), ({ error }) => {
    if (error && !(error instanceof SyncClientError) && error.status === 409) {
      errors.push(error.value.code);
    }
  });
  await until(() => errors.includes("LOCKED"));
  expect(errors).toContain("LOCKED");
});

test("servers and authentication contexts have independent connections and caches", async () => {
  const first = fixture();
  const second = fixture();
  const identities = new Map<string, string>();
  const clients = ["alice", "bob"].map((principal) => {
    const client = createSyncClient({
      url: first.url,
      headers: { authorization: principal },
      createWebSocket: (url, headers) => new RuntimeWebSocket(url, { headers }),
    });
    cleanup.push(() => client.close());
    client.subscribe(first.api.identity.get.live(), ({ data }) => {
      if (data) {
        identities.set(principal, data.principal);
      }
    });
    return client;
  });
  await until(() => identities.size === 2);
  expect(Object.fromEntries(identities)).toEqual({ alice: "alice", bob: "bob" });
  expect(() => clients[0]?.subscribe(second.api.state.get.live(), () => undefined)).toThrow(
    "different server"
  );
  let value: number | undefined;
  second.client.subscribe(second.api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  await first.api.state.post(undefined, {});
  await Bun.sleep(300);
  expect(value).toBe(0);
});

test("access refusal stops retrying until credentials are explicitly renewed", async () => {
  const { api, url } = fixture();
  let token = "deny";
  let requests = 0;
  const client = createSyncClient({
    url,
    headers: () => ({ authorization: token }),
    createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
    fetcher: ((input, init) => {
      requests += 1;
      return fetch(input, init);
    }) as typeof fetch,
  });
  cleanup.push(() => client.close());
  let principal: string | undefined;
  const states: string[] = [];
  client.subscribeConnection((state) => states.push(state.status));
  client.subscribe(api.identity.get.live(), ({ data }) => {
    principal = data?.principal;
  });
  await until(() => client.getConnectionState().status === "unauthorized");
  expect(client.getConnectionState().error?.status).toBe(401);
  await Bun.sleep(350);
  expect(requests).toBe(1);
  expect(principal).toBeUndefined();
  token = "bob";
  client.reconnect();
  await until(() => principal === "bob");
  expect(states).toContain("unauthorized");
  expect(client.getConnectionState().status).toBe("connected");
});

test("credentials can be renewed synchronously from the connection listener", async () => {
  const { api, url } = fixture();
  let token = "deny";
  const client = createSyncClient({
    url,
    headers: () => ({ authorization: token }),
    createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
  });
  cleanup.push(() => client.close());
  client.subscribeConnection(({ status }) => {
    if (status === "unauthorized") {
      token = "bob";
      client.reconnect();
    }
  });
  let principal: string | undefined;
  client.subscribe(api.identity.get.live(), ({ data }) => {
    principal = data?.principal;
  });
  await until(() => principal === "bob");
  expect(client.getConnectionState().status).toBe("connected");
});

test("a network interruption retries and reports a distinct connection state", async () => {
  const { api, url } = fixture();
  const failures = [new TypeError("offline")];
  const client = createSyncClient({
    url,
    fetcher: ((input, init) => {
      const error = failures.pop();
      if (error) {
        return Promise.reject(error);
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
  cleanup.push(() => client.close());
  let value: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => client.getConnectionState().status === "reconnecting");
  expect(client.getConnectionState().error?.status).toBeUndefined();
  await until(() => value === 0);
  expect(client.getConnectionState().status).toBe("connected");
});

test("credential renewal preserves the same principal's cached data and journal cursor", async () => {
  const { api, url } = fixture();
  let token = "alice:1";
  const cursors: string[] = [];
  let recovered: string | undefined;
  const client = createSyncClient({
    url,
    headers: () => ({ authorization: token }),
    createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
    fetcher: (async (input, init) => {
      cursors.push(new URL(String(input)).searchParams.get("after") ?? "missing");
      const response = await fetch(input, init);
      recovered = (await response.clone().json()).cursor;
      return response;
    }) as typeof fetch,
  });
  cleanup.push(() => client.close());
  const values: (string | undefined)[] = [];
  client.subscribe(api.identity.get.live(), ({ data }) => values.push(data?.principal));
  await until(() => values.at(-1) === "alice:1");
  await api.state.post(undefined, {});
  await until(() => recovered === "1");
  const index = values.length;
  const requests = cursors.length;
  token = "alice:2";
  client.reconnect({ preserveCache: true });
  expect(client.getConnectionState().reason).toBe("credentials");
  expect(values.slice(index)).not.toContain(undefined);
  await until(() => values.at(-1) === "alice:2");
  expect(values.slice(index)).not.toContain(undefined);
  expect(cursors[requests]).toBe("1");
});

test.each(["bob", "alice/tenant-two"])(
  "server identity changes to %s clear retained snapshots before new reads",
  async (nextPrincipal) => {
    const { routes, url } = fixture();
    let principal = "alice";
    let snapshot: string | undefined;
    const beforeNewRead: (string | undefined)[] = [];
    const api = treaty<typeof routes>(url, {
      fetcher: ((input, init) => {
        if (new Headers(init?.headers).get("authorization") === nextPrincipal) {
          beforeNewRead.push(snapshot);
        }
        return fetch(input, init);
      }) as typeof fetch,
    }).use(furinSync);
    const client = createSyncClient({
      url,
      headers: () => ({ authorization: principal }),
      createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
    });
    cleanup.push(() => client.close());
    const values: (string | undefined)[] = [];
    client.subscribe(api.identity.get.live(), ({ data }) => {
      snapshot = data?.principal;
      values.push(snapshot);
    });
    await until(() => values.at(-1) === "alice");
    const index = values.length;
    principal = nextPrincipal;
    client.reconnect({ preserveCache: true });
    await until(() => values.at(-1) === nextPrincipal);
    expect(values.slice(index)).toContain(undefined);
    expect(beforeNewRead).toEqual([undefined]);
  }
);

test("server access-context changes reacquire credentials and reevaluate reads without a journal write", async () => {
  const leases: AbortController[] = [];
  let releases = 0;
  const { api, url, sync } = fixture(undefined, {
    connection: () => {
      const lease = new AbortController();
      leases.push(lease);
      return {
        signal: lease.signal,
        release: () => {
          releases += 1;
        },
      };
    },
  });
  let token = "alice:1";
  const client = createSyncClient({
    url,
    headers: () => ({ authorization: token }),
    createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
  });
  cleanup.push(() => client.close());
  const values: (string | undefined)[] = [];
  client.subscribe(api.identity.get.live(), ({ data }) => values.push(data?.principal));
  await until(() => values.at(-1) === "alice:1");
  token = "alice:2";
  const index = values.length;
  leases[0]?.abort();
  await until(() => values.at(-1) === "alice:2");
  expect(values.slice(index)).toContain(undefined);
  expect(await sync.adapter.currentCursor()).toBe("0");
  expect(leases).toHaveLength(2);
  expect(releases).toBe(1);
});

test("a permission change without a write removes forbidden data and keeps other queries live", async () => {
  const leases: AbortController[] = [];
  const { api, client, sync, setPermission } = fixture(undefined, {
    connection: () => {
      const lease = new AbortController();
      leases.push(lease);
      return { signal: lease.signal, release: () => undefined };
    },
  });
  let restricted: number | undefined;
  let errorCode: string | undefined;
  let other: number | undefined;
  client.subscribe(api.restricted.get.live(), ({ data, error }) => {
    restricted = data?.value;
    if (error && !(error instanceof SyncClientError) && error.status === 403) {
      errorCode = error.value.code;
    }
  });
  client.subscribe(api.state.get.live(), ({ data }) => {
    other = data?.value;
  });
  await until(() => restricted === 0 && other === 0);
  setPermission(false);
  leases[0]?.abort();
  await until(() => errorCode === "RESOURCE_DENIED");
  expect(restricted).toBeUndefined();
  expect(await sync.adapter.currentCursor()).toBe("0");
  expect(client.getConnectionState().status).toBe("connected");
  await api.state.post(undefined, {});
  await until(() => other === 1);
});

test.each(["revocation", "expiration"])(
  "%s without activity stops retries after reauthentication is denied",
  async (reason) => {
    const lease = new AbortController();
    const sessions = new Set(["alice"]);
    let checks = 0;
    const { api, client } = fixture(undefined, {
      principal: () => {
        checks += 1;
        return sessions.has("alice") ? "alice" : "";
      },
      connection: () => ({ signal: lease.signal, release: () => undefined }),
    });
    let value: number | undefined;
    client.subscribe(api.state.get.live(), ({ data }) => {
      value = data?.value;
    });
    await until(() => value === 0);
    sessions.delete("alice");
    lease.abort(reason);
    await until(() => client.getConnectionState().status === "unauthorized");
    const deniedChecks = checks;
    await Bun.sleep(350);
    expect(checks).toBe(deniedChecks);
    expect(value).toBeUndefined();
  }
);

test("a principal resolver rejecting a signed-out session produces an authentication refusal", async () => {
  const { api, client } = fixture(undefined, {
    principal: () => {
      throw new Error("Session expired");
    },
  });
  client.subscribe(api.state.get.live(), () => undefined);
  await until(() => client.getConnectionState().status === "unauthorized");
  expect(client.getConnectionState().error?.status).toBe(401);
});

test("HttpOnly session cookies authenticate recovery, event connections and subscribed reads", async () => {
  let cookieAtConnection: string | null | undefined;
  const { api, url } = fixture(undefined, {
    principal: ({ request }) => (request.headers.get("cookie") === "session=alice" ? "alice" : ""),
    connection: ({ request }) => {
      cookieAtConnection = request.headers.get("cookie");
    },
  });
  const login = await fetch(`${url}/login`);
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  // Bun's host supplies the cookie jar; browsers send this cookie without exposing it to JS.
  const cookie = setCookie.split(";")[0] ?? "";
  const client = createSyncClient({
    url,
    headers: () => ({ cookie }),
    createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
  });
  cleanup.push(() => client.close());
  let value: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  expect(cookieAtConnection).toBe("session=alice");
  expect(client.getConnectionState().status).toBe("connected");
});

test("a late recovery response cannot restore an old identity after ineffective cancellation", async () => {
  const { api, url } = fixture();
  let principal = "alice";
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  let sockets = 0;
  const client = createSyncClient({
    url,
    headers: () => ({ authorization: principal }),
    createWebSocket: (address, headers) => {
      sockets += 1;
      return new RuntimeWebSocket(address, { headers });
    },
    fetcher: (async (input, init) => {
      const response = await fetch(input, { ...init, signal: undefined });
      if (first) {
        first = false;
        started.resolve();
        await release.promise;
      }
      return response;
    }) as typeof fetch,
  });
  cleanup.push(() => {
    release.resolve();
    client.close();
  });
  let value: string | undefined;
  client.subscribe(api.identity.get.live(), ({ data }) => {
    value = data?.principal;
  });
  await started.promise;
  principal = "bob";
  client.reconnect();
  await until(() => value === "bob");
  release.resolve();
  await Bun.sleep(25);
  expect(value).toBe("bob");
  expect(sockets).toBe(1);
  expect(client.getConnectionState().status).toBe("connected");
});

test("unsubscribe stops reads and a new observer immediately receives the shared cached value", async () => {
  const { api, client, reads } = fixture();
  let value: number | undefined;
  const stop = client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  let cached: number | undefined;
  const stopSecond = client.subscribe(api.state.get.live(), ({ data }) => {
    cached = data?.value;
  });
  expect(cached).toBe(0);
  stop();
  stopSecond();
  await api.state.post(undefined, {});
  await Bun.sleep(300);
  expect(value).toBe(0);
  expect(reads.state).toBe(1);
});

test("reconnection retries an interrupted read even when the journal has no new changes", async () => {
  const { routes, url } = fixture();
  let first = true;
  const api = treaty<typeof routes>(url, {
    fetcher: ((input, init) => {
      if (first) {
        first = false;
        return Promise.reject(new TypeError("offline"));
      }
      return fetch(input, init);
    }) as typeof fetch,
  }).use(furinSync);
  const sockets: WebSocket[] = [];
  const client = createSyncClient({
    url,
    createWebSocket: (address) => {
      const socket = new WebSocket(address);
      sockets.push(socket);
      return socket;
    },
  });
  cleanup.push(() => client.close());
  let value: number | undefined;
  let failed = false;
  client.subscribe(api.state.get.live(), ({ data, error }) => {
    value = data?.value;
    failed ||= error !== null;
  });
  await until(() => failed);
  sockets[0]?.close();
  await until(() => sockets.length === 2 && client.getConnectionState().status === "connected");
  await until(() => value === 0);
});

test("a forbidden resource reports its typed denial while other subscriptions continue", async () => {
  const { api, client } = fixture();
  const errors: string[] = [];
  let value: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  client.subscribe(api.denied.get.live(), ({ error }) => {
    if (error && !(error instanceof SyncClientError) && error.status === 403) {
      errors.push(error.value.code);
    }
  });
  await until(() => errors.includes("DENIED"));
  expect(client.getConnectionState().status).toBe("connected");
  await api.state.post(undefined, {});
  await until(() => value === 1);
});

test("one-shot live reads and creating an idle client do not start a persistent connection", async () => {
  const { api, url } = fixture();
  let sockets = 0;
  const client = createSyncClient({
    url,
    createWebSocket: (address) => {
      sockets += 1;
      return new WebSocket(address);
    },
  });
  cleanup.push(() => client.close());
  expect((await api.state.get.live()).data).toEqual({ value: 0 });
  expect(sockets).toBe(0);
  expect(client.getConnectionState().status).toBe("idle");
  expect(() => createSyncClient({ url, headers: { authorization: "token" } })).toThrow(
    "createWebSocket"
  );
});

test("closing during a read cancels requests, releases the socket and stops all listeners", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { routes, url } = fixture(async () => {
    reading.resolve();
    await release.promise;
  });
  let signal: AbortSignal | null | undefined;
  const api = treaty<typeof routes>(url, {
    fetcher: ((input, init) => {
      signal = init?.signal;
      return fetch(input, init);
    }) as typeof fetch,
  }).use(furinSync);
  let socket: WebSocket | undefined;
  const client = createSyncClient({
    url,
    createWebSocket: (address) => {
      socket = new WebSocket(address);
      return socket;
    },
  });
  cleanup.push(() => client.close());
  const values: number[] = [];
  let notifications = 0;
  client.subscribe(api.state.get.live(), ({ data }) => {
    notifications += 1;
    if (data) {
      values.push(data.value);
    }
  });
  await reading.promise;
  client.close();
  expect(signal?.aborted).toBe(true);
  const before = notifications;
  release.resolve();
  await until(() => socket?.readyState === WebSocket.CLOSED);
  await Bun.sleep(350);
  expect(values).toEqual([]);
  expect(notifications).toBe(before);
  expect(client.getConnectionState().status).toBe("closed");
  expect(() => client.subscribe(api.state.get.live(), () => undefined)).toThrow("closed");
});

test("closing during asynchronous socket creation closes the late socket without starting a read", async () => {
  const { api, url, reads } = fixture();
  const created = Promise.withResolvers<WebSocket>();
  const release = Promise.withResolvers<void>();
  const client = createSyncClient({
    url,
    createWebSocket: async (address) => {
      const socket = new WebSocket(address);
      created.resolve(socket);
      await release.promise;
      return socket;
    },
  });
  cleanup.push(() => {
    release.resolve();
    client.close();
  });
  client.subscribe(api.state.get.live(), () => undefined);
  const socket = await created.promise;
  client.close();
  release.resolve();
  await until(() => socket.readyState === WebSocket.CLOSED);
  expect(reads.state).toBe(0);
  expect(client.getConnectionState().status).toBe("closed");
});

test("an asynchronous socket factory can return after the initial sync notification", async () => {
  const { api, url } = fixture();
  const client = createSyncClient({
    url,
    createWebSocket: async (address) => {
      const socket = new WebSocket(address);
      await new Promise<void>((resolve) => {
        socket.addEventListener("message", () => resolve(), { once: true });
      });
      return socket;
    },
  });
  cleanup.push(() => client.close());
  let value: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  await api.state.post(undefined, {});
  await until(() => value === 1);
  expect(client.getConnectionState().status).toBe("connected");
});

test("an asynchronous socket factory returning a closed socket triggers reconnection", async () => {
  const { api, url } = fixture();
  let sockets = 0;
  const client = createSyncClient({
    url,
    createWebSocket: async (address) => {
      sockets += 1;
      const socket = new WebSocket(address);
      if (sockets === 1) {
        await new Promise<void>((resolve) => {
          socket.addEventListener("open", () => socket.close(), { once: true });
          socket.addEventListener("close", () => resolve(), { once: true });
        });
      }
      return socket;
    },
  });
  cleanup.push(() => client.close());
  let value: number | undefined;
  client.subscribe(api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  expect(sockets).toBe(2);
  expect(client.getConnectionState().status).toBe("connected");
});

test.each([
  { denied: false, nextPrincipal: "bob" },
  { denied: true, nextPrincipal: "bob" },
  { denied: false, nextPrincipal: "alice/tenant-two" },
  { denied: true, nextPrincipal: "alice/tenant-two" },
])(
  "changing to $nextPrincipal fences old responses despite ineffective cancellation (old denial: $denied)",
  async ({ denied, nextPrincipal }) => {
    const { routes, url } = fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cancelled = false;
    let first = true;
    let token = "alice";
    const api = treaty<typeof routes>(url, {
      fetcher: (async (input, init) => {
        const response = await fetch(input, init);
        if (first) {
          first = false;
          init?.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
            },
            { once: true }
          );
          reading.resolve();
          await release.promise;
          if (denied) {
            return Response.json({ code: "OLD_CONTEXT" }, { status: 401 });
          }
        }
        return response;
      }) as typeof fetch,
    }).use(furinSync);
    const client = createSyncClient({
      url,
      headers: () => ({ authorization: token }),
      createWebSocket: (address, headers) => new RuntimeWebSocket(address, { headers }),
    });
    cleanup.push(() => {
      release.resolve();
      client.close();
    });
    const values: string[] = [];
    client.subscribe(api.identity.get.live(), ({ data }) => {
      if (data) {
        values.push(data.principal);
      }
    });
    await reading.promise;
    token = nextPrincipal;
    client.reconnect();
    await until(() => values.at(-1) === nextPrincipal);
    release.resolve();
    await Bun.sleep(30);
    expect(cancelled).toBe(true);
    expect(values).not.toContain("alice");
    expect(values.at(-1)).toBe(nextPrincipal);
    expect(client.getConnectionState().status).toBe("connected");
  }
);

test("a change during the initial read discards the obsolete response and reads again", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  const { api, client } = fixture(async () => {
    reads += 1;
    if (reads === 1) {
      reading.resolve();
      await release.promise;
    }
  });
  const values: number[] = [];
  client.subscribe(api.state.get.live(), ({ data }) => {
    if (data) {
      values.push(data.value);
    }
  });
  await reading.promise;
  await Promise.all([
    api.state.post(undefined, {}),
    api.state.post(undefined, {}),
    api.state.post(undefined, {}),
  ]);
  // All writes are journaled while the old read is still in flight.
  await Bun.sleep(300);
  release.resolve();
  await until(() => values.at(-1) === 3);
  expect(values).not.toContain(0);
  expect(reads).toBe(2);
});
