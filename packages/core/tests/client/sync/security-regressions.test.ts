import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { type Context, Elysia } from "elysia";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";

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
        expect(JSON.parse(body)).toEqual({
          changes: [],
          cursor: "1",
          hasMore: false,
          reset: true,
        });
        expect(body).not.toContain("victim@example.test");
        expect(body).not.toContain("/documents/private-id");
      })
    );
    expect(principalCalls).toBe(4);
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
