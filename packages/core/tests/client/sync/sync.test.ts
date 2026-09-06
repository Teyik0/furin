import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  __resetCacheState,
  _runWithRequestInvalidationScope,
  revalidatePath,
} from "../../../src/server/cache/index.ts";
import type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  SyncAdapter,
  SyncNotifier,
} from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { MAX_SYNC_REPLAY_RESPONSE_BYTES } from "../../../src/server/sync/response.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { __resetSyncState, createSyncStreamPlugin } from "../../../src/server/sync/stream.ts";

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

const syncDatabase = new Database(":memory:");
migrateSqliteSync(syncDatabase);
const syncListeners = new Set<(cursor: string) => void>();
const testNotifier: SyncNotifier = {
  publish(cursor) {
    for (const listener of syncListeners) {
      listener(cursor);
    }
    return Promise.resolve();
  },
  subscribe(listener) {
    syncListeners.add(listener);
    return Promise.resolve({
      unsubscribe() {
        syncListeners.delete(listener);
        return Promise.resolve();
      },
    });
  },
};
const testSync = {
  adapter: sqliteSyncAdapter({ database: syncDatabase, namespace: "sync-plugin-tests" }),
  notifier: testNotifier,
  principal: ({ request }: { request: Request }) => request.headers.get("x-user") ?? "principal",
};

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  timeoutMs: number
): Promise<StreamReadResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    reader.read().then(
      (chunk) => {
        clearTimeout(timeout);
        resolve(chunk);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function resetSyncTestState() {
  __resetCacheState();
  __resetSyncState();
}

test("furinSync uses the injected adapter for reservation and atomic completion", async () => {
  const completed: CompleteMutationInput[] = [];
  const lease: MutationLease = {
    id: "lease-1",
    key: "POST:/cards:injected",
    leaseMs: 30_000,
    principal: "principal",
  };
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: (_input: BeginMutationInput): Promise<BeginMutationResult> =>
      Promise.resolve({ kind: "execute", lease }),
    completeMutation: (input: CompleteMutationInput): Promise<CompleteMutationResult> => {
      completed.push(input);
      return Promise.resolve({ cursor: "1", kind: "committed" });
    },
    currentCursor: () => Promise.resolve("0"),
    readChanges: (_input: ReadChangesInput): Promise<ChangePage> =>
      Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("renewed"),
    scope: "distributed",
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.reject(new Error("notifier unavailable")),
    subscribe: () => Promise.reject(new Error("notifier unavailable")),
  };
  const app = new Elysia()
    .use(furinSync({ adapter, notifier, principal: () => "principal" }))
    .post("/cards", () => ({ ok: true }));

  const response = await app.handle(
    new Request("http://localhost/cards", {
      headers: { "Idempotency-Key": "injected" },
      method: "POST",
    })
  );

  expect(response.status).toBe(200);
  expect(completed).toHaveLength(1);
  expect(completed[0]?.lease).toEqual(lease);
});

test("furinSync durably preserves manual and declarative invalidations", async () => {
  resetSyncTestState();
  const completed: CompleteMutationInput[] = [];
  const lease: MutationLease = {
    id: "lease-combined-invalidations",
    key: "POST:/cards:combined-invalidations",
    leaseMs: 30_000,
    principal: "principal",
  };
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "execute", lease }),
    completeMutation: (input) => {
      completed.push(input);
      return Promise.resolve({ cursor: "1", kind: "committed" });
    },
    currentCursor: () => Promise.resolve("0"),
    readChanges: () => Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("renewed"),
    scope: "distributed",
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  const app = new Elysia().use(furinSync({ adapter, notifier, principal: () => "principal" })).post(
    "/cards",
    () => {
      revalidatePath("/manual", "page");
      revalidatePath("/declared", "layout");
      return { ok: true };
    },
    { sync: { invalidate: { path: "/declared", type: "layout" } } }
  );

  try {
    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: { "Idempotency-Key": "combined-invalidations" },
          method: "POST",
        })
      )
    );

    expect(response.headers.get("x-furin-revalidate")).toBe("/manual,/declared:layout");
    expect(completed[0]?.invalidations).toEqual([
      { kind: "path", path: "/declared", type: "layout" },
      { kind: "path", path: "/manual", type: "page" },
    ]);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync schedules the next lease renewal while the current renewal is pending", async () => {
  const renewal = Promise.withResolvers<"renewed">();
  const route = Promise.withResolvers<void>();
  let renewalCalls = 0;
  const lease: MutationLease = {
    id: "lease-1",
    key: "POST:/cards:slow-renewal",
    leaseMs: 30_000,
    principal: "principal",
  };
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "execute", lease }),
    completeMutation: () => Promise.resolve({ cursor: undefined, kind: "committed" }),
    currentCursor: () => Promise.resolve("0"),
    readChanges: () => Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => {
      renewalCalls += 1;
      return renewal.promise;
    },
    scope: "distributed",
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  const app = new Elysia()
    .use(furinSync({ adapter, notifier, principal: () => "principal" }))
    .post("/cards", async () => {
      await route.promise;
      return { ok: true };
    });
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled: Array<() => void> = [];
  const fakeSetTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [callback, delay, ...callbackArgs] = args;
    if (delay !== 10_000) {
      return originalSetTimeout(...args);
    }
    if (typeof callback !== "function") {
      throw new Error("expected renewal timer callback");
    }
    scheduled.push(() => callback(...callbackArgs));
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  let responsePromise: Promise<Response> | undefined;

  try {
    globalThis.setTimeout = fakeSetTimeout;
    responsePromise = app.handle(
      new Request("http://localhost/cards", {
        headers: { "Idempotency-Key": "slow-renewal" },
        method: "POST",
      })
    );
    for (let attempt = 0; attempt < 20 && scheduled.length === 0; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: wait for Elysia to enter the route handler.
      await Promise.resolve();
    }
    scheduled[0]?.();
    await Promise.resolve();

    expect(renewalCalls).toBe(1);
    expect(scheduled).toHaveLength(2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    renewal.resolve("renewed");
    route.resolve();
    await responsePromise;
  }
});

test("furinSync direct handle completes inside bun:test", async () => {
  resetSyncTestState();
  try {
    const app = new Elysia().use(furinSync(testSync)).post(
      "/cards",
      () => ({
        ok: true,
      }),
      { sync: { invalidate: { path: "/board", type: "layout" } } }
    );

    const response = await app.handle(
      new Request("http://localhost/cards", {
        headers: { "Idempotency-Key": "direct-handle" },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    resetSyncTestState();
  }
}, 1000);

test("furinSync bypasses reads and synchronizes mutations implicitly", async () => {
  resetSyncTestState();
  try {
    let mutationCalls = 0;
    const app = new Elysia()
      .use(furinSync(testSync))
      .get("/boards", () => [{ id: "board-1" }])
      .post("/boards", () => {
        mutationCalls += 1;
        return { id: "board-1" };
      });

    let response = await app.handle(new Request("http://localhost/boards"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "board-1" }]);

    response = await app.handle(
      new Request("http://localhost/boards", {
        method: "POST",
      })
    );
    expect(response.status).toBe(428);
    expect(mutationCalls).toBe(0);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync enforces idempotent mutation semantics directly", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const syncApp = new Elysia()
      .use(furinSync(testSync))
      .post("/synced", () => {
        calls += 1;
        return { calls };
      })
      .post(
        "/opted-out",
        () => {
          calls += 1;
          return { calls };
        },
        { sync: false }
      );

    let response = await syncApp.handle(new Request("http://localhost/synced", { method: "POST" }));
    expect(response.status).toBe(428);
    expect(calls).toBe(0);

    response = await syncApp.handle(new Request("http://localhost/opted-out", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calls: 1 });

    calls = 0;
    const replayApp = new Elysia().use(furinSync(testSync)).post("/cards", () => {
      calls += 1;
      return { calls };
    });
    const replayRequest = () =>
      replayApp.handle(
        new Request("http://localhost/cards", {
          body: JSON.stringify({ title: "First" }),
          headers: { "content-type": "application/json", "Idempotency-Key": "replay" },
          method: "POST",
        })
      );

    response = await replayRequest();
    expect(await response.json()).toEqual({ calls: 1 });
    response = await replayRequest();
    expect(await response.json()).toEqual({ calls: 1 });
    expect(calls).toBe(1);

    response = await replayApp.handle(
      new Request("http://localhost/cards", {
        body: JSON.stringify({ title: "Second" }),
        headers: { "content-type": "application/json", "Idempotency-Key": "replay" },
        method: "POST",
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "FURIN_IDEMPOTENCY_MISMATCH" });

    calls = 0;
    const retryApp = new Elysia().use(furinSync(testSync)).post("/retry", ({ status }) => {
      calls += 1;
      return calls === 1 ? status("Service Unavailable", "retry") : { calls };
    });
    const retryRequest = () =>
      retryApp.handle(
        new Request("http://localhost/retry", {
          headers: { "Idempotency-Key": "retry" },
          method: "POST",
        })
      );
    expect((await retryRequest()).status).toBe(503);
    response = await retryRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calls: 2 });
  } finally {
    resetSyncTestState();
  }
});

test("furinSync scopes replay by the application principal and never replays cookies", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia()
      .use(
        furinSync({
          ...testSync,
          principal: ({ request }) => request.headers.get("x-user") ?? "anonymous",
        })
      )
      .post("/cards", ({ set }) => {
        calls += 1;
        set.headers["set-cookie"] = `request=${calls}; Path=/`;
        return { calls };
      });
    const requestForPrincipal = (principal: string) =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: { "Idempotency-Key": "same", "x-user": principal },
          method: "POST",
        })
      );

    const alice = await requestForPrincipal("alice");
    const bob = await requestForPrincipal("bob");
    const aliceReplay = await requestForPrincipal("alice");

    expect(await alice.json()).toEqual({ calls: 1 });
    expect(await bob.json()).toEqual({ calls: 2 });
    expect(await aliceReplay.json()).toEqual({ calls: 1 });
    expect(aliceReplay.headers.get("set-cookie")).toBeNull();
    expect(calls).toBe(2);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync refuses unbounded Response bodies without re-executing retries", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync(testSync)).post("/download", () => {
      calls += 1;
      return new Response("ok");
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/download", {
          headers: { "Idempotency-Key": "unbounded-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });

    response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });
    expect(calls).toBe(1);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync publishes invalidations for successful mutations with unreplayable responses", async () => {
  resetSyncTestState();
  const completed: CompleteMutationInput[] = [];
  const published: string[] = [];
  const lease: MutationLease = {
    id: "lease-unreplayable-invalidation",
    key: "POST:/download:unreplayable-invalidation",
    leaseMs: 30_000,
    principal: "principal",
  };
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "execute", lease }),
    completeMutation: (input) => {
      completed.push(input);
      return Promise.resolve({ cursor: "7", kind: "committed" });
    },
    currentCursor: () => Promise.resolve("0"),
    readChanges: () => Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("renewed"),
    scope: "distributed",
  };
  const notifier: SyncNotifier = {
    publish: (cursor) => {
      published.push(cursor);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  const app = new Elysia()
    .use(furinSync({ adapter, notifier, principal: () => "principal" }))
    .post("/download", () => new Response("ok"), {
      sync: { invalidate: { path: "/board", type: "layout" } },
    });

  try {
    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/download", {
          headers: { "Idempotency-Key": "unreplayable-invalidation" },
          method: "POST",
        })
      )
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(completed[0]?.invalidations).toEqual([{ kind: "path", path: "/board", type: "layout" }]);
    expect(published).toEqual(["7"]);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync replays bounded Response bodies", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync(testSync)).post("/created", () => {
      calls += 1;
      return new Response("created", {
        headers: { "content-length": "7", "x-route": "created" },
        status: 201,
      });
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/created", {
          headers: { "Idempotency-Key": "bounded-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("created");
    expect(await response.text()).toBe("created");

    response = await request();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("created");
    expect(await response.text()).toBe("created");
    expect(calls).toBe(1);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync refuses oversized Response bodies without re-executing retries", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync(testSync)).post("/large", () => {
      calls += 1;
      return new Response("too large", {
        headers: { "content-length": String(MAX_SYNC_REPLAY_RESPONSE_BYTES + 1) },
      });
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/large", {
          headers: { "Idempotency-Key": "oversized-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });

    response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });
    expect(calls).toBe(1);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync SSE notification completes inside bun:test", async () => {
  resetSyncTestState();
  const app = new Elysia()
    .use(createSyncStreamPlugin(testSync))
    .use(furinSync(testSync))
    .patch("/cards/:cardId", () => ({ ok: true }), {
      sync: { invalidate: { path: "/board", type: "layout" } },
    });

  const streamResponse = await app.handle(new Request("http://localhost/_furin/sync"));
  const reader = streamResponse.body?.getReader();
  if (!reader) {
    throw new Error("Expected stream response body");
  }

  try {
    const connected = await readStreamChunk(reader, "SSE connection prelude", 1000);
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");
    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards/1", {
          headers: { "Idempotency-Key": "direct-sse" },
          method: "PATCH",
        })
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");

    const event = await readStreamChunk(reader, "SSE invalidation event", 1000);
    expect(new TextDecoder().decode(event.value)).toContain("event: furin.sync");
  } finally {
    await reader.cancel();
    resetSyncTestState();
  }
});

test("sync stream closes a client that does not drain its queue", async () => {
  resetSyncTestState();
  const app = new Elysia()
    .use(createSyncStreamPlugin(testSync))
    .use(furinSync(testSync))
    .post("/slow-client", () => ({ ok: true }), {
      sync: { invalidate: { path: "/slow-client", type: "page" } },
    });
  const streamResponse = await app.handle(new Request("http://localhost/_furin/sync"));
  const reader = streamResponse.body?.getReader();
  if (!reader) {
    throw new Error("Expected stream response body");
  }

  try {
    await app.handle(
      new Request("http://localhost/slow-client", {
        headers: { "Idempotency-Key": "slow-client" },
        method: "POST",
      })
    );

    const connected = await readStreamChunk(reader, "queued SSE prelude", 1000);
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");
    expect((await readStreamChunk(reader, "slow client closure", 1000)).done).toBe(true);
  } finally {
    await reader.cancel();
    resetSyncTestState();
  }
});

test("sync stream opens when notifier subscription fails", async () => {
  resetSyncTestState();
  const cursor = "0";
  const adapter: SyncAdapter = {
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "conflict", reason: "in-progress" }),
    completeMutation: () => Promise.resolve({ kind: "lost" }),
    currentCursor: () => Promise.resolve(cursor),
    readChanges: () => Promise.resolve({ changes: [], cursor, hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("lost"),
    scope: "distributed",
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.resolve(),
    subscribe: () => Promise.reject(new Error("notifier unavailable")),
  };
  const app = new Elysia().use(
    createSyncStreamPlugin({ adapter, notifier, principal: () => "principal" })
  );
  const response = await app.handle(new Request("http://localhost/_furin/sync"));
  try {
    expect(response.status).toBe(200);
  } finally {
    resetSyncTestState();
  }
});
