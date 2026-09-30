import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Elysia, ElysiaStatus, t } from "elysia";
import type { SyncMutation } from "../../../src/server/sync/adapter.ts";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync } from "../../../src/server/sync/sqlite/index.ts";

const counter = sqliteTable("counter", { value: integer().notNull() });

test("bodyless default Responses honor the explicit HTTP status before committing", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "response-set-status" });
  let status = 400;
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", ({ mutation, set }) =>
      mutation((tx) => {
        set.status = status;
        set.headers.location = "/old";
        tx.insert(counter).values({ value: 1 }).run();
        return new Response(null, { headers: { location: "/actual" } });
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(400);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  status = 201;
  const initial = await app.handle(request());
  expect(initial.status).toBe(201);
  expect(initial.headers.get("location")).toBe("/actual");
  const replay = await app.handle(request());
  expect(replay.status).toBe(201);
  expect(replay.headers.get("location")).toBe("/actual");
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 1 },
  ]);
  sqlite.close();
});

test("status response headers survive encoding and exclude cookies only from replay", async () => {
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const adapter = drizzleSyncAdapter({ db: drizzle(sqlite), namespace: "status-headers" });
  const app = new Elysia().use(furinSync({ adapter, principal: () => "user" })).post(
    "/counter",
    {
      response: {
        201: t.Object({
          id: t
            .Codec(t.Number())
            .Decode((id) => id + 1)
            .Encode((id) => id - 1),
        }),
      },
    },
    ({ mutation, set }) =>
      mutation(() => {
        set.headers.location = "/old";
        set.status = 400;
        return new ElysiaStatus(
          201,
          { id: 2 },
          {
            location: "/counter/1",
            "x-test": "kept",
            "set-cookie": "session=x",
          }
        );
      })
  );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  const initial = await app.handle(request());
  expect(initial.status).toBe(201);
  expect(initial.headers.get("location")).toBe("/counter/1");
  expect(initial.headers.getSetCookie()).toEqual(["session=x"]);
  expect(await initial.json()).toEqual({ id: 1 });
  const replay = await app.handle(request());
  expect(replay.status).toBe(201);
  expect(replay.headers.get("location")).toBe("/counter/1");
  expect(replay.headers.get("x-test")).toBe("kept");
  expect(replay.headers.getSetCookie()).toEqual([]);
  expect(await replay.json()).toEqual({ id: 1 });
  sqlite.close();
});

test("bodyless mutation responses keep cookies on the initial response only", async () => {
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const adapter = drizzleSyncAdapter({ db: drizzle(sqlite), namespace: "initial-cookie" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/session", ({ mutation }) =>
      mutation(
        () =>
          new Response(null, {
            status: 303,
            headers: { location: "/", "set-cookie": "session=x; HttpOnly" },
          })
      )
    );
  const request = () =>
    new Request("http://localhost/session", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  const initial = await app.handle(request());
  expect(initial.status).toBe(303);
  expect(initial.headers.getSetCookie()).toEqual(["session=x; HttpOnly"]);
  const replay = await app.handle(request());
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe("/");
  expect(replay.headers.getSetCookie()).toEqual([]);
  sqlite.close();
});

test("a returned Error rolls back and releases its key like a thrown error", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "returned-error" });
  const failures = new Set(["business"]);
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return failures.has("business") ? new Error("business failure") : { count: 1 };
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  failures.clear();
  expect(await (await app.handle(request())).json()).toEqual({ count: 1 });
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 1 },
  ]);
  sqlite.close();
});

test.each([
  ["/counter", "/counter/"],
  ["/café", "/caf%C3%A9"],
])("native aliases for %s validate before commit", async (path, alias) => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: alias });
  let value = "bad" as unknown as number;
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/rows", () => db.select().from(counter).all())
    .post(path, { response: t.Number() }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return value;
      })
    );
  const request = () =>
    new Request(`http://localhost${alias}`, {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/rows"))).json()).toEqual([]);
  value = 1;
  expect(await (await app.handle(request())).json()).toBe(1);
  expect(await (await app.handle(new Request("http://localhost/rows"))).json()).toEqual([
    { value: 1 },
  ]);
  sqlite.close();
});

test("replacement routes validate against the last registered response schema", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "replacement-route" });
  let count = 1;
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", { response: t.Object({ count: t.Number() }) }, () => ({ count: 99 }))
    .post(
      "/counter",
      { response: t.Object({ count: t.Number({ minimum: 10 }) }) },
      ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: count }).run();
          return { count };
        })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  count = 10;
  expect(await (await app.handle(request())).json()).toEqual({ count: 10 });
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 10 },
  ]);
  sqlite.close();
});

test("unbound parent response guards cannot silently commit a child mutation", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "parent-response-guard" });
  let calls = 0;
  const child = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/counter", ({ mutation }) =>
      mutation((tx) => {
        calls += 1;
        tx.insert(counter).values({ value: 1 }).run();
        return { count: "bad" };
      })
    );
  const app = new Elysia()
    .get("/counter", () => db.select().from(counter).all())
    .guard({ response: t.Object({ count: t.Number() }) })
    .use(child);
  const response = await app.handle(
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    })
  );
  expect(response.status).toBe(500);
  expect(calls).toBe(0);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  sqlite.close();
});

test("numeric status and code fields in a successful DTO commit and replay", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "dto-status-fields" });
  let calls = 0;
  const app = new Elysia()
    .get("/counter", () => db.select().from(counter).all())
    .use(furinSync({ adapter, principal: () => "user" }))
    .post(
      "/counter",
      { response: t.Object({ status: t.Number(), code: t.Number() }) },
      ({ mutation }) =>
        mutation((tx) => {
          calls += 1;
          tx.insert(counter).values({ value: 1 }).run();
          return { status: 1, code: 42 };
        })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(200);
  expect((await app.handle(request())).status).toBe(200);
  expect(calls).toBe(1);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 1 },
  ]);
  sqlite.close();
});

test("merged Standard Schema response guards roll back invalid business results", async () => {
  const minimumCount = {
    "~standard": {
      version: 1 as const,
      vendor: "atomic-sync-test",
      validate(value: unknown) {
        if (
          typeof value === "object" &&
          value !== null &&
          "count" in value &&
          typeof value.count === "number" &&
          value.count >= 10
        ) {
          return { value: { count: value.count } };
        }
        return { issues: [{ message: "minimum 10" }] };
      },
    },
  };
  const native = new Elysia()
    .guard({ schema: "merge", response: minimumCount })
    .guard({ schema: "merge", response: t.Object({ count: t.Number() }) })
    .post("/counter", () => ({ count: 1 }));
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await native.handle(request())).status).toBe(500);

  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "merged-response-guards" });
  const app = new Elysia()
    .get("/counter", () => db.select().from(counter).all())
    .use(furinSync({ adapter, principal: () => "user" }))
    .guard({ schema: "merge", response: minimumCount })
    .guard({ schema: "merge", response: t.Object({ count: t.Number() }) })
    .post("/counter", ({ mutation }: { mutation: SyncMutation<typeof adapter> }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return { count: 1 };
      })
    );
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  sqlite.close();
});

test("merged response guard codecs encode once, matching native Elysia", async () => {
  let encodes = 0;
  const response = t
    .Codec(t.Number())
    .Decode((value) => value + 1)
    .Encode((value) => {
      encodes += 1;
      return value - 1;
    });
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  const native = new Elysia().guard({ schema: "merge", response }).post("/counter", () => 10);
  const expected = await (await native.handle(request())).json();
  expect(encodes).toBe(1);
  encodes = 0;
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const adapter = drizzleSyncAdapter({ db: drizzle(sqlite), namespace: "guard-codec" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .guard({ schema: "merge", response })
    .post("/counter", ({ mutation }) => mutation(() => 10));
  expect(await (await app.handle(request())).json()).toEqual(expected);
  expect(await (await app.handle(request())).json()).toEqual(expected);
  expect(encodes).toBe(1);
  sqlite.close();
});

test("replays short-circuit a generic application error fallback", async () => {
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "error-fallback" });
  let calls = 0;
  const app = new Elysia()
    .error("global", () => Response.json({ error: "fallback" }, { status: 500 }))
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/mutation", ({ mutation }) =>
      mutation(() => {
        calls += 1;
        return { calls };
      })
    );
  const request = () =>
    new Request("http://localhost/mutation", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  const initial = await app.handle(request());
  const replay = await app.handle(request());
  expect(initial.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await initial.json());
  expect(calls).toBe(1);
  sqlite.close();
});

test("separate route plugins validate against their own response schemas", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "separate-plugins" });
  const sync = furinSync({ adapter, principal: () => "user" });
  const first = new Elysia()
    .use(sync)
    .post("/first", { response: t.Object({ count: t.Number() }) }, ({ mutation }) =>
      mutation(() => ({ count: 1 }))
    );
  const second = new Elysia()
    .use(sync)
    .post("/second", { response: t.Object({ title: t.String() }) }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return { title: 42 } as unknown as { title: string };
      })
    );
  const app = new Elysia({ prefix: "/api" })
    .use(sync)
    .use(first)
    .use(second)
    .get("/counter", () => db.select().from(counter).all());
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/first", {
          method: "POST",
          headers: { "idempotency-key": "valid" },
        })
      )
    ).status
  ).toBe(200);
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/second", {
          method: "POST",
          headers: { "idempotency-key": "one" },
        })
      )
    ).status
  ).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/api/counter"))).json()).toEqual([]);
  sqlite.close();
});

test("method-specific response schemas take precedence over ALL routes", async () => {
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "method-priority" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .all("/mutation", { response: t.Object({ count: t.Number() }) }, ({ mutation }) =>
      mutation(() => ({ count: 1 }))
    )
    .post("/mutation", { response: t.Object({ title: t.String() }) }, ({ mutation }) =>
      mutation(() => ({ title: "specific" }))
    );
  const response = await app.handle(
    new Request("http://localhost/mutation", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ title: "specific" });
  sqlite.close();
});

test("ALL routes validate mutation responses before committing", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "all-route" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .all(
      "/mutation",
      { response: t.Object({ count: t.Number() }), sync: { invalidate: { tags: ["counter"] } } },
      ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return { count: "invalid" } as unknown as { count: number };
        })
    )
    .get("/counter", () => db.select().from(counter).all());
  expect(
    (
      await app.handle(
        new Request("http://localhost/mutation", {
          method: "POST",
          headers: { "idempotency-key": "one" },
        })
      )
    ).status
  ).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  sqlite.close();
});

test("notifications observe the committed business write from another connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-atomic-"));
  const sqlite = new Database(join(directory, "db.sqlite"));
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const reader = new Database(join(directory, "db.sqlite"), { readonly: true });
  const db = drizzle(sqlite);
  const observer = drizzle(reader);
  const adapter = drizzleSyncAdapter({ db, namespace: "notification" });
  let observed = 0;
  const notifier = {
    publish: () => {
      observed = observer.select().from(counter).all().length;
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  try {
    const app = new Elysia()
      .use(furinSync({ adapter, notifier, principal: () => "user" }))
      .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return { count: 1 };
        })
      );
    expect(
      (
        await app.handle(
          new Request("http://localhost/counter", {
            method: "POST",
            headers: { "idempotency-key": "one" },
          })
        )
      ).status
    ).toBe(200);
    expect(observed).toBe(1);
  } finally {
    reader.close();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("losing a lease cannot commit a business write", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  sqlite.run(
    "CREATE TRIGGER expire_lease AFTER INSERT ON counter BEGIN UPDATE furin_sync_mutations SET lease_expires_at = 0; END"
  );
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "lease" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return { count: 1 };
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(503);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  sqlite.run("DROP TRIGGER expire_lease");
  expect((await app.handle(request())).status).toBe(200);
  sqlite.close();
});

test("serialization failure rolls back business writes and releases the idempotency key", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "serialization" });
  const circularResults = new Set(["enabled"]);
  interface Result {
    count: number;
    self?: Result;
  }
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        const result: Result = { count: 1 };
        if (circularResults.has("enabled")) {
          result.self = result;
        }
        return result;
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  circularResults.clear();
  expect((await app.handle(request())).status).toBe(200);
  sqlite.close();
});

test("a journal failure rolls back the business write and publishes no invalidation", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  sqlite.run(
    "CREATE TRIGGER deny_journal BEFORE INSERT ON furin_sync_changes BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END"
  );
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "journal-failure" });
  let publishes = 0;
  const notifier = {
    publish: () => {
      publishes += 1;
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  const app = new Elysia()
    .use(furinSync({ adapter, notifier, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post(
      "/counter",
      { sync: { invalidate: { path: "/counter", type: "page" } } },
      ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return { count: 1 };
        })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  const failure = await app.handle(request());
  expect(failure.status).toBe(500);
  expect(failure.headers.has("x-furin-sync")).toBe(false);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  expect(publishes).toBe(0);
  sqlite.run("DROP TRIGGER deny_journal");
  const initial = await app.handle(request());
  const replay = await app.handle(request());
  expect(initial.status).toBe(200);
  expect(replay.headers.get("x-furin-sync")).toBe("1");
  expect(replay.headers.get("x-furin-revalidate")).toBe("/counter");
  expect(publishes).toBe(1);
  sqlite.close();
});

test("response codecs encode once inside the transaction and replay the encoded response", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "codec" });
  const responseSchema = t
    .Codec(t.Number())
    .Decode((value) => value + 1)
    .Encode((value) => value - 1);
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/counter", { response: responseSchema }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return 10;
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      method: "POST",
      headers: { "idempotency-key": "one" },
    });
  expect(await (await app.handle(request())).json()).toBe(9);
  expect(await (await app.handle(request())).json()).toBe(9);
  sqlite.close();
});

test("prefixed nested plugins validate named response schemas before committing", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "nested" });
  const plugin = new Elysia()
    .model("result", t.Object({ count: t.Number() }))
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/counter", { response: "result" }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return { count: "invalid" } as unknown as { count: number };
      })
    );
  const app = new Elysia({ prefix: "/api" })
    .use(furinSync({ adapter, principal: () => "user" }))
    .use(plugin)
    .get("/counter", () => db.select().from(counter).all());
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/counter", {
          method: "POST",
          headers: { "idempotency-key": "one" },
        })
      )
    ).status
  ).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/api/counter"))).json()).toEqual([]);
  sqlite.close();
});

test("an atomic mutation replays its response without repeating the business write", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "atomic" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        return { count: tx.select().from(counter).all().length };
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      headers: { "idempotency-key": "one" },
      method: "POST",
    });
  expect(await (await app.handle(request())).json()).toEqual({ count: 1 });
  expect(await (await app.handle(request())).json()).toEqual({ count: 1 });
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 1 },
  ]);
  expect(await adapter.currentCursor()).toBe("1");
  sqlite.close();
});

test("response schema failure rolls back the business write before commit", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "validation" });
  const app = new Elysia()
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post(
      "/counter",
      { response: t.Object({ count: t.Number() }), sync: { invalidate: { tags: ["counter"] } } },
      ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return { count: "invalid" } as unknown as { count: number };
        })
    );
  const response = await app.handle(
    new Request("http://localhost/counter", {
      headers: { "idempotency-key": "one" },
      method: "POST",
    })
  );
  expect(response.status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  sqlite.close();
});

test("a business failure releases its key even with an application error fallback", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const adapter = drizzleSyncAdapter({ db, namespace: "rollback" });
  const failures = new Set(["business"]);
  const app = new Elysia()
    .error("global", () => Response.json({ error: "fallback" }, { status: 500 }))
    .use(furinSync({ adapter, principal: () => "user" }))
    .get("/counter", () => db.select().from(counter).all())
    .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
      mutation((tx) => {
        tx.insert(counter).values({ value: 1 }).run();
        if (failures.has("business")) {
          throw new Error("business failure");
        }
        return { ok: true };
      })
    );
  const request = () =>
    new Request("http://localhost/counter", {
      headers: { "idempotency-key": "one" },
      method: "POST",
    });
  expect((await app.handle(request())).status).toBe(500);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
  expect(await adapter.currentCursor()).toBe("0");
  failures.clear();
  expect((await app.handle(request())).status).toBe(200);
  expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
    { value: 1 },
  ]);
  sqlite.close();
});
