import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import type { FurinSyncOptions, SyncConnectionLease } from "../../../src/server/sync/config.ts";
import {
  createLocalSyncClient,
  invalidateSync,
  type SyncNotifier,
} from "../../../src/server/sync/index.ts";
import { furinSync as serverSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import {
  createSyncChangesPlugin,
  waitForSyncCursorUnsubscriptions,
} from "../../../src/server/sync/stream.ts";
import { furinSync, SyncClientError } from "../../../src/sync-client.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    // biome-ignore lint/performance/noAwaitInLoops: clients release subscriptions before databases close.
    await close();
  }
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for local sync");
    }
    // biome-ignore lint/performance/noAwaitInLoops: observe asynchronous public state.
    await Bun.sleep(5);
  }
}

function fixture(
  onRead?: (value: number, signal: AbortSignal) => Promise<void>,
  connection?: FurinSyncOptions["connection"]
) {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const events = new Set<(cursor: string) => void>();
  const subscriptions = { started: 0, stopped: 0 };
  const notifier: SyncNotifier = {
    recovery: "self",
    publish: (cursor) => {
      for (const listener of events) {
        listener(cursor);
      }
      return Promise.resolve();
    },
    subscribe: (listener) => {
      subscriptions.started += 1;
      events.add(listener);
      return Promise.resolve({
        unsubscribe: () => {
          subscriptions.stopped += 1;
          events.delete(listener);
          return Promise.resolve();
        },
      });
    },
  };
  const adapter = sqliteSyncAdapter({ database, namespace: "local" });
  const sync = {
    connection,
    adapter: () => adapter,
    notifier,
    principal: ({ headers }: { headers: { [name: string]: string | undefined } }) =>
      headers.authorization === "deny" ? "" : (headers.authorization ?? "alice"),
  };
  let value = 0;
  const reads = { state: 0, other: 0 };
  const app = new Elysia()
    .use(serverSync(sync))
    .use(createSyncChangesPlugin(sync))
    .get("/state", async ({ request }) => {
      reads.state += 1;
      const snapshot = value;
      await onRead?.(snapshot, request.signal);
      return { value: snapshot };
    })
    .get("/other", () => {
      reads.other += 1;
      return { value };
    })
    .get("/identity", ({ headers }) => ({ principal: headers.authorization ?? "alice" }))
    .get("/failure", ({ status }) => status(409, { code: "LOCKED" as const }))
    .post("/state", () => {
      value += 1;
      return { value };
    });
  const api = treaty(app).use(furinSync);
  const client = createLocalSyncClient({ app, sync });
  cleanup.push(() => database.close());
  cleanup.push(async () => {
    client.close();
    await waitForSyncCursorUnsubscriptions();
  });
  return { adapter, app, api, client, sync, reads, subscriptions };
}

test("in-process subscriptions follow Eden live queries without a listener, fetch or WebSocket", async () => {
  const { app, api, client } = fixture();
  const { fetch, WebSocket: socket } = globalThis;
  const values: number[] = [];
  try {
    globalThis.fetch = (() => {
      throw new Error("Unexpected network request");
    }) as unknown as typeof fetch;
    globalThis.WebSocket = class {
      constructor() {
        throw new Error("Unexpected socket");
      }
    } as unknown as typeof WebSocket;
    client.subscribe(api.state.get.live(), ({ data }) => {
      if (data) {
        values.push(data.value);
      }
    });
    await until(() => values.at(-1) === 0);
    await api.state.post(undefined, {});
    await until(() => values.at(-1) === 1);
    expect(client.getConnectionState().status).toBe("connected");
    expect(app.server).toBeUndefined();
  } finally {
    globalThis.fetch = fetch;
    globalThis.WebSocket = socket;
  }
});

test("local connections acquire a real authorized context and reauthenticate without journal writes", async () => {
  const leases: AbortController[] = [];
  let releases = 0;
  const seen: string[] = [];
  const { adapter, app, api, sync } = fixture(undefined, (context) => {
    seen.push(context.request.headers.get("authorization") ?? "");
    const lease = new AbortController();
    leases.push(lease);
    return {
      signal: lease.signal,
      release: () => {
        releases += 1;
      },
    };
  });
  let token = "alice";
  const client = createLocalSyncClient({ app, sync, headers: () => ({ authorization: token }) });
  cleanup.push(() => client.close());
  expect((await api.state.get.live()).data).toEqual({ value: 0 });
  expect((await app.handle(new Request("http://e.ly/_furin/sync/changes"))).status).toBe(200);
  expect(seen).toEqual([]);
  let value: string | undefined;
  client.subscribe(api.identity.get.live(), ({ data }) => {
    value = data?.principal;
  });
  await until(() => value === "alice");
  expect(seen).toEqual(["alice"]);
  token = "bob";
  leases[0]?.abort();
  await until(() => value === "bob");
  expect(seen).toEqual(["alice", "bob"]);
  expect(await adapter.currentCursor()).toBe("0");
  expect(releases).toBe(1);
  client.close();
  expect(releases).toBe(2);
});

test("closing during asynchronous local validity acquisition releases the late lease exactly once", async () => {
  const requested = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<SyncConnectionLease>();
  const released = Promise.withResolvers<void>();
  const { api, client, subscriptions } = fixture(undefined, () => {
    requested.resolve();
    return acquired.promise;
  });
  const values: number[] = [];
  let releases = 0;
  client.subscribe(api.state.get.live(), ({ data }) => {
    if (data) {
      values.push(data.value);
    }
  });
  await requested.promise;
  client.close();
  acquired.resolve({
    signal: new AbortController().signal,
    release: () => {
      releases += 1;
      released.resolve();
    },
  });
  await released.promise;
  expect(releases).toBe(1);
  expect(subscriptions.started).toBe(0);
  expect(values).toEqual([]);
});

test("queries share one notifier subscription and background invalidations stay targeted", async () => {
  const { api, client, sync, reads, subscriptions } = fixture();
  let state: number | undefined;
  let other: number | undefined;
  const stop = client.subscribe(api.state.get.live(), ({ data }) => {
    state = data?.value;
  });
  client.subscribe(api.state.get.live(), () => undefined);
  client.subscribe(api.other.get.live(), ({ data }) => {
    other = data?.value;
  });
  await until(() => state === 0 && other === 0);
  expect(subscriptions.started).toBe(1);
  expect(reads).toEqual({ state: 1, other: 1 });
  await invalidateSync(sync, "/state", undefined, { principal: "alice" });
  await until(() => reads.state === 2);
  expect(reads.other).toBe(1);
  stop();
  client.close();
  await waitForSyncCursorUnsubscriptions();
  expect(subscriptions.stopped).toBe(1);
});

test("local query errors preserve Eden's discriminated endpoint values", async () => {
  const { api, client } = fixture();
  let code: "LOCKED" | undefined;
  client.subscribe(api.failure.get.live(), ({ error }) => {
    if (error && !(error instanceof SyncClientError) && error.status === 409) {
      ({ code } = error.value);
    }
  });
  await until(() => code === "LOCKED");
  expect(client.getConnectionState().status).toBe("connected");
});

test("different local applications cannot be mixed despite Eden's identical synthetic origins", async () => {
  const first = fixture();
  const second = fixture();
  expect(() => first.client.subscribe(second.api.state.get.live(), () => undefined)).toThrow(
    "different server"
  );
  const remote = treaty<typeof first.app>("http://e.ly").use(furinSync);
  expect(() => first.client.subscribe(remote.state.get.live(), () => undefined)).toThrow(
    "different server"
  );
  let value: number | undefined;
  second.client.subscribe(second.api.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  await first.api.state.post(undefined, {});
  await Bun.sleep(150);
  expect(value).toBe(0);
});

test("sharing Eden request configuration does not dispatch a query to another local application", async () => {
  const first = fixture();
  const second = fixture();
  await second.api.state.post(undefined, {});
  const config = { headers: { authorization: "alice" } };
  const alice = treaty(first.app, config).use(furinSync);
  const bob = treaty(second.app, config).use(furinSync);
  expect((await alice.state.get.live()).data).toEqual({ value: 0 });
  let value: number | undefined;
  second.client.subscribe(bob.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value !== undefined);
  expect(value).toBe(1);
});

test("local journal and reads use the same verified credentials and suspend on denial", async () => {
  const { app, api, sync, subscriptions, client: alice } = fixture();
  let token = "deny";
  const client = createLocalSyncClient({ app, sync, headers: () => ({ authorization: token }) });
  cleanup.push(async () => {
    client.close();
    await waitForSyncCursorUnsubscriptions();
  });
  let principal: string | undefined;
  client.subscribe(api.identity.get.live(), ({ data }) => {
    principal = data?.principal;
  });
  await until(() => client.getConnectionState().status === "unauthorized");
  expect(client.getConnectionState().error?.status).toBe(401);
  expect(subscriptions.started).toBe(0);
  await Bun.sleep(300);
  expect(client.getConnectionState().status).toBe("unauthorized");
  token = "bob";
  client.reconnect();
  await until(() => principal === "bob");
  expect(client.getConnectionState().status).toBe("connected");
  let localPrincipal: string | undefined;
  alice.subscribe(api.identity.get.live(), ({ data }) => {
    localPrincipal = data?.principal;
  });
  await until(() => localPrincipal === "alice");
  expect(principal).toBe("bob");
});

test("a burst during the first local read is coalesced into one subsequent read", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const { api, client, reads } = fixture(async () => {
    if (first) {
      first = false;
      reading.resolve();
      await release.promise;
    }
  });
  cleanup.push(() => release.resolve());
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
  await Bun.sleep(150);
  release.resolve();
  await until(() => values.at(-1) === 3);
  expect(values).not.toContain(0);
  expect(reads.state).toBe(2);
});

test("closing cancels a local read and releases its notifier even if the handler ignores cancellation", async () => {
  const reading = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const { api, client, subscriptions } = fixture(async (_value, requestSignal) => {
    reading.resolve(requestSignal);
    await release.promise;
  });
  cleanup.push(() => release.resolve());
  const values: number[] = [];
  client.subscribe(api.state.get.live(), ({ data }) => {
    if (data) {
      values.push(data.value);
    }
  });
  const signal = await reading.promise;
  client.close();
  expect(signal.aborted).toBe(true);
  release.resolve();
  await waitForSyncCursorUnsubscriptions();
  await Bun.sleep(20);
  expect(values).toEqual([]);
  expect(subscriptions.stopped).toBe(1);
  expect(client.getConnectionState().status).toBe("closed");
});

test("changing local credentials cannot publish a previous context's pending response", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const { app, api, sync } = fixture(async () => {
    if (first) {
      first = false;
      reading.resolve();
      await release.promise;
    }
  });
  let token = "alice";
  const client = createLocalSyncClient({ app, sync, headers: () => ({ authorization: token }) });
  cleanup.push(async () => {
    release.resolve();
    client.close();
    await waitForSyncCursorUnsubscriptions();
  });
  const values: number[] = [];
  client.subscribe(api.state.get.live(), ({ data }) => {
    if (data) {
      values.push(data.value);
    }
  });
  await reading.promise;
  await api.state.post(undefined, {});
  token = "bob";
  client.reconnect();
  await until(() => values.at(-1) === 1);
  release.resolve();
  await Bun.sleep(20);
  expect(values).not.toContain(0);
  expect(client.getConnectionState().status).toBe("connected");
});

test("a composed application can recover through a custom mounted sync path", async () => {
  const base = fixture();
  const app = new Elysia()
    .use(serverSync(base.sync))
    .group("/local", (group) => group.use(base.app));
  const api = treaty(app).use(furinSync);
  const client = createLocalSyncClient({ app, sync: base.sync, syncPath: "/local/_furin/sync" });
  cleanup.push(async () => {
    client.close();
    await waitForSyncCursorUnsubscriptions();
  });
  let value: number | undefined;
  client.subscribe(api.local.state.get.live(), ({ data }) => {
    value = data?.value;
  });
  await until(() => value === 0);
  await api.local.state.post(undefined, {});
  await until(() => value === 1);
  expect(app.server).toBeUndefined();
});
