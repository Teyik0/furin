import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { type Context, Elysia } from "elysia";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";
import { queryTag } from "../../../src/shared/sync-query.ts";

function testSync() {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  return {
    database,
    options: {
      adapter: sqliteSyncAdapter({ database, namespace: crypto.randomUUID() }),
      principal: () => "alice",
    },
  };
}

test("successful JSON status and code fields do not disable mutation replay", async () => {
  const { database, options } = testSync();
  let executions = 0;
  const app = new Elysia().use(furinSync(options)).post("/result", () => {
    executions += 1;
    return { status: 500, code: 404 };
  });
  const send = () =>
    app.handle(
      new Request("http://localhost/result", {
        method: "POST",
        headers: { "idempotency-key": "dto" },
      })
    );
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: retries must run after the original completes.
      const response = await send();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 500, code: 404 });
    }
    expect(executions).toBe(1);
  } finally {
    database.close();
  }
});

test("unreplayable response retries keep the JSON fallback's representation headers", async () => {
  const { database, options } = testSync();
  let executions = 0;
  const app = new Elysia().use(furinSync(options)).post("/download", () => {
    executions += 1;
    return new Response("oversized", {
      headers: {
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
      },
    });
  });
  const send = () =>
    app.handle(
      new Request("http://localhost/download", {
        method: "POST",
        headers: { "idempotency-key": "fallback" },
      })
    );
  try {
    const first = await send();
    const replay = await send();
    const payloads = await Promise.all([first, replay].map((response) => response.json()));
    for (const response of [first, replay]) {
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();
    }
    for (const payload of payloads) {
      expect(payload).toMatchObject({ code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE" });
    }
    expect(executions).toBe(1);
  } finally {
    database.close();
  }
});

test.each([42, true, "plain text", { ok: true }, [1]] as const)(
  "mutation replay preserves its native HTTP content type: %s",
  async (value) => {
    const { database, options } = testSync();
    const app = new Elysia().use(furinSync(options)).post("/primitive", () => value);
    const send = () =>
      app.handle(
        new Request("http://localhost/primitive", {
          method: "POST",
          headers: { "idempotency-key": "primitive" },
        })
      );
    try {
      const first = await send();
      const replay = await send();
      expect(replay.headers.get("content-type")).toBe(first.headers.get("content-type"));
      expect(await replay.text()).toBe(await first.text());
    } finally {
      database.close();
    }
  }
);

test.each([201, 303, 500] as const)(
  "Response replay preserves the effective HTTP status %s",
  async (status) => {
    const { database, options } = testSync();
    let executions = 0;
    const app = new Elysia().use(furinSync(options)).post("/response", ({ set }) => {
      executions += 1;
      set.status = status;
      set.headers.location = "/configured";
      return new Response(null, { headers: { location: "/returned" } });
    });
    const send = () =>
      app.handle(
        new Request("http://localhost/response", {
          method: "POST",
          headers: { "idempotency-key": "response" },
        })
      );
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: retries must run after the original completes.
        const response = await send();
        expect(response.status).toBe(status);
        expect(response.headers.get("location")).toBe("/returned");
      }
      expect(executions).toBe(status < 400 ? 1 : 2);
    } finally {
      database.close();
    }
  }
);

test("bodyless status responses replay without serializing the status wrapper", async () => {
  const { database, options } = testSync();
  const app = new Elysia()
    .use(furinSync(options))
    .post("/empty", ({ status }) => status(201, null));
  const send = () =>
    app.handle(
      new Request("http://localhost/empty", {
        method: "POST",
        headers: { "idempotency-key": "empty" },
      })
    );
  try {
    const first = await send();
    const replay = await send();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(await first.text());
    expect(replay.headers.get("content-type")).toBe(first.headers.get("content-type"));
  } finally {
    database.close();
  }
});

test("mounted mutation uses its own Sync principal and adapter", async () => {
  const first = testSync();
  const second = testSync();
  const parentReservations = spyOn(first.options.adapter, "beginMutation");
  const parentCompletions = spyOn(first.options.adapter, "completeMutation");
  const childReservations = spyOn(second.options.adapter, "beginMutation");
  const childCompletions = spyOn(second.options.adapter, "completeMutation");
  let authorized = false;
  let executions = 0;
  const child = new Elysia({ prefix: "/child" })
    .use(
      furinSync({
        ...second.options,
        principal: ({ status }: Context) => {
          if (!authorized) {
            throw status(401);
          }
          return "bob";
        },
      })
    )
    .post("/private", () => {
      executions += 1;
      return { secret: "child" };
    });
  const app = new Elysia().use(furinSync(first.options)).use(child);
  const send = () =>
    app.handle(
      new Request("http://localhost/child/private", {
        method: "POST",
        headers: { "idempotency-key": "ownership" },
      })
    );
  try {
    expect((await send()).status).toBe(401);
    expect(executions).toBe(0);
    expect(parentReservations).not.toHaveBeenCalled();
    expect(childReservations).not.toHaveBeenCalled();
    authorized = true;
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(executions).toBe(1);
    expect(childReservations).toHaveBeenCalledTimes(2);
    expect(childCompletions).toHaveBeenCalledTimes(1);
    expect(parentReservations).not.toHaveBeenCalled();
    expect(parentCompletions).not.toHaveBeenCalled();
  } finally {
    parentReservations.mockRestore();
    parentCompletions.mockRestore();
    childReservations.mockRestore();
    childCompletions.mockRestore();
    first.database.close();
    second.database.close();
  }
});

test("Unicode and comma invalidation paths survive mutation completion and replay", async () => {
  const { database, options } = testSync();
  const paths = ["/東京", "/items/first,second", "/literal%20"];
  let executions = 0;
  const app = new Elysia().use(furinSync(options)).post(
    "/paths",
    {
      sync: { invalidate: paths.map((path) => ({ path, type: "page" as const })) },
    },
    () => {
      executions += 1;
      return { success: true };
    }
  );
  const send = () =>
    app.handle(
      new Request("http://localhost/paths", {
        method: "POST",
        headers: { "idempotency-key": "paths" },
      })
    );
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: retries must run after the original completes.
      const response = await send();
      expect(response.status).toBe(200);
      expect(
        response.headers.get("x-furin-revalidate")?.split(",").map(decodeURIComponent)
      ).toEqual(paths);
    }
    expect(executions).toBe(1);
  } finally {
    database.close();
  }
});

test("reordered values of repeated query parameters cannot replay another request", async () => {
  const { database, options } = testSync();
  const app = new Elysia().use(furinSync(options)).post("/choice", ({ request }) => ({
    choice: new URL(request.url).searchParams.get("choice"),
  }));
  try {
    const send = (query: string) =>
      app.handle(
        new Request(`http://localhost/choice?${query}`, {
          headers: { "idempotency-key": "same" },
          method: "POST",
        })
      );
    expect((await send("choice=first&choice=second")).status).toBe(200);
    expect((await send("choice=second&choice=first")).status).toBe(409);
  } finally {
    database.close();
  }
});

test("Unicode query scopes survive read and invalidation response headers", async () => {
  const { database, options } = testSync();
  const identity = { id: "board.cards", scope: { boardId: "東京🌸" } } as const;
  const app = new Elysia()
    .use(furinSync(options))
    .get("/places", { sync: identity }, () => [])
    .post("/places", { sync: { invalidate: [identity] } }, () => ({ success: true }));
  try {
    const read = await app.handle(new Request("http://localhost/places"));
    expect(read.status).toBe(200);
    expect(JSON.parse(read.headers.get("x-furin-query") ?? "null")).toMatchObject(identity);
    const write = await app.handle(
      new Request("http://localhost/places", {
        headers: { "idempotency-key": "unicode" },
        method: "POST",
      })
    );
    expect(write.status).toBe(200);
    expect(JSON.parse(write.headers.get("x-furin-queries") ?? "null")).toEqual([identity]);
  } finally {
    database.close();
  }
});

test("change catch-up authorizes requests and keeps other users' resources private", async () => {
  const { database, options } = testSync();
  let principalCalls = 0;
  const sync = {
    ...options,
    principal: ({ request, status }: Context) => {
      principalCalls += 1;
      const principal = request.headers.get("authorization");
      if (!principal) {
        throw status(401);
      }
      return principal;
    },
  };
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post(
      "/private",
      {
        sync: {
          invalidate: [
            { id: "board.cards", scope: { boardId: "victim@example.test" } },
            { path: "/documents/private-id", type: "page" },
          ],
        },
      },
      () => ({ success: true })
    );
  try {
    const write = await app.handle(
      new Request("http://localhost/private", {
        headers: { authorization: "alice", "idempotency-key": "private" },
        method: "POST",
      })
    );
    expect(write.status).toBe(200);
    const anonymous = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(anonymous.status).toBe(401);
    await Promise.all(
      ["alice", "bob"].map(async (principal) => {
        const response = await app.handle(
          new Request("http://localhost/_furin/sync/changes?after=0", {
            headers: { authorization: principal },
          })
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        if (principal === "alice") {
          expect(JSON.parse(body)).toMatchObject({
            changes: [
              {
                cursor: "1",
                invalidations: [
                  {
                    kind: "tags",
                    tags: [
                      queryTag({ id: "board.cards", scope: { boardId: "victim@example.test" } }),
                    ],
                  },
                  { kind: "path", path: "/documents/private-id", type: "page" },
                ],
              },
            ],
            cursor: "1",
            hasMore: false,
            reset: false,
          });
        } else {
          expect(JSON.parse(body)).toEqual({
            changes: [],
            cursor: "1",
            hasMore: false,
            reset: true,
          });
          expect(body).not.toContain("victim@example.test");
          expect(body).not.toContain("/documents/private-id");
        }
      })
    );
    expect(principalCalls).toBe(4);
  } finally {
    database.close();
  }
});

test("principal catch-up paginates ordered changes without losing the next cursor", async () => {
  const { database, options } = testSync();
  const app = new Elysia()
    .use(furinSync(options))
    .use(createSyncChangesPlugin(options))
    .post("/update", { sync: { path: "/board", type: "page" } }, () => ({ success: true }));
  try {
    for (const key of ["one", "two", "three"]) {
      // biome-ignore lint/performance/noAwaitInLoops: journal cursors must be allocated in order.
      const response = await app.handle(
        new Request("http://localhost/update", {
          method: "POST",
          headers: { "idempotency-key": key },
        })
      );
      expect(response.status).toBe(200);
    }
    const first = await (
      await app.handle(new Request("http://localhost/_furin/sync/changes?after=0&limit=2"))
    ).json();
    expect(first).toMatchObject({ cursor: "2", hasMore: true, reset: false });
    expect(first.changes.map((change: { cursor: string }) => change.cursor)).toEqual(["1", "2"]);
    const second = await (
      await app.handle(new Request("http://localhost/_furin/sync/changes?after=2&limit=2"))
    ).json();
    expect(second).toMatchObject({ cursor: "3", hasMore: false, reset: false });
    expect(second.changes.map((change: { cursor: string }) => change.cursor)).toEqual(["3"]);
  } finally {
    database.close();
  }
});

test("historical journal rows without principal provenance trigger a private reset", async () => {
  const { database, options } = testSync();
  const app = new Elysia()
    .use(furinSync(options))
    .use(createSyncChangesPlugin(options))
    .post("/update", { sync: { path: "/private/history", type: "page" } }, () => ({
      success: true,
    }));
  try {
    await app.handle(
      new Request("http://localhost/update", {
        method: "POST",
        headers: { "idempotency-key": "history" },
      })
    );
    // Represent rows written by an older deployment, including during rolling upgrades.
    database.run("UPDATE furin_sync_changes SET principal_hash = NULL");
    const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await response.json()).toEqual({
      changes: [],
      cursor: "1",
      hasMore: false,
      reset: true,
    });
  } finally {
    database.close();
  }
});

test.each([
  ["POST", false],
  ["POST", true],
  ["*", false],
  ["*", true],
] as const)(
  "%s mutations authorize before reservation and replay (precompiled: %s)",
  async (method, precompiled) => {
    const { database, options } = testSync();
    const reservations = spyOn(options.adapter, "beginMutation");
    let authorized = false;
    let authorizationCalls = 0;
    let executions = 0;
    const app = new Elysia().use(furinSync(options)).method(
      method,
      "/private",
      {
        beforeHandle({ status }) {
          authorizationCalls += 1;
          if (!authorized) {
            return status(403);
          }
        },
      },
      () => {
        executions += 1;
        return { secret: "private result" };
      }
    );
    if (precompiled) {
      app.compile();
    }
    const send = () =>
      app.handle(
        new Request("http://localhost/private", {
          headers: { "idempotency-key": "replay" },
          method: "POST",
        })
      );
    try {
      expect((await send()).status).toBe(403);
      expect(reservations).not.toHaveBeenCalled();
      expect(executions).toBe(0);
      authorized = true;
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect(reservations).toHaveBeenCalledTimes(2);
      expect(executions).toBe(1);
      authorized = false;
      expect((await send()).status).toBe(403);
      expect(reservations).toHaveBeenCalledTimes(2);
      expect(authorizationCalls).toBe(4);
    } finally {
      reservations.mockRestore();
      database.close();
    }
  }
);

test("an unbound parent cannot execute a standalone child mutation outside Sync", async () => {
  const { database, options } = testSync();
  let executions = 0;
  const child = new Elysia().use(furinSync(options)).post("/private", () => {
    executions += 1;
    return { success: true };
  });
  const app = new Elysia().use(child);
  try {
    const response = await app.handle(
      new Request("http://localhost/private", {
        headers: { "idempotency-key": "unbound" },
        method: "POST",
      })
    );
    expect(response.status).toBe(500);
    expect(executions).toBe(0);
  } finally {
    database.close();
  }
});

test.each([false, true])(
  "mounted mutation replays respect the final parent's guard (precompiled: %s)",
  async (precompiled) => {
    const { database, options } = testSync();
    let authorized = true;
    let executions = 0;
    const child = new Elysia().use(furinSync(options)).post("/private", () => {
      executions += 1;
      return { secret: "private result" };
    });
    const app = new Elysia()
      .use(furinSync(options))
      .beforeHandle(({ status }) => {
        if (!authorized) {
          return status(403);
        }
      })
      .use(child);
    if (precompiled) {
      app.compile();
    }
    const send = () =>
      app.handle(
        new Request("http://localhost/private", {
          headers: { "idempotency-key": "parent-replay" },
          method: "POST",
        })
      );
    try {
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect(executions).toBe(1);
      authorized = false;
      expect((await send()).status).toBe(403);
      expect(executions).toBe(1);
    } finally {
      database.close();
    }
  }
);
