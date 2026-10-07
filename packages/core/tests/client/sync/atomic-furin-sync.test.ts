import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { type Context, Elysia, t } from "elysia";
import { furin } from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { resetFurinLoggerForTests } from "../../../src/server/logger.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync } from "../../../src/server/sync/sqlite/index.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

test.serial.each(["", "/api"])(
  "furin({ sync }) preserves GET and POST handlers mounted on a plugin at %s",
  async (prefix) => {
    const fixture = createTmpApp("cli-app");
    const cwd = process.cwd();
    const originalDevMode = IS_DEV;
    const sqlite = new Database(":memory:");
    migrateSqliteSync(sqlite);
    const sync = {
      adapter: drizzleSyncAdapter({ db: drizzle(sqlite), namespace: "furin-mount" }),
      principal: () => {
        throw new Error("Mounted handlers own their authentication and mutation semantics");
      },
    };
    try {
      __setDevMode(true);
      __resetCompileContext();
      resetFurinLoggerForTests();
      process.chdir(fixture.path);
      const app = new Elysia()
        .use(
          new Elysia({ prefix }).mount((request) =>
            Response.json(
              { method: request.method, path: new URL(request.url).pathname },
              { headers: { "set-cookie": "session=mounted; HttpOnly" } }
            )
          )
        )
        .use(await furin({ pagesDir: join(fixture.path, "src/pages"), sync }));
      const responses = await Promise.all(
        ["GET", "POST"].map((method) =>
          app.handle(new Request(`http://localhost${prefix}/auth/get-session`, { method }))
        )
      );
      await Promise.all(
        responses.map(async (response, index) => {
          expect(response.status).toBe(200);
          expect(response.headers.getSetCookie()).toEqual(["session=mounted; HttpOnly"]);
          expect(await response.json()).toEqual({
            method: index === 0 ? "GET" : "POST",
            path: "/auth/get-session",
          });
        })
      );
    } finally {
      sqlite.close();
      process.chdir(cwd);
      __setDevMode(originalDevMode);
      __resetCompileContext();
      resetFurinLoggerForTests();
      fixture.cleanup();
    }
  }
);

test.serial(
  "Furin binds parent guards and models to mounted transactional API routes",
  async () => {
    const fixture = createTmpApp("cli-app");
    const cwd = process.cwd();
    const originalDevMode = IS_DEV;
    const sqlite = new Database(":memory:");
    const counter = sqliteTable("counter", { value: integer().notNull() });
    sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
    migrateSqliteSync(sqlite);
    const db = drizzle(sqlite);
    const sync = {
      adapter: drizzleSyncAdapter({ db, namespace: "furin-parent" }),
      principal: () => "user",
    };
    let value = "invalid";
    try {
      __setDevMode(true);
      __resetCompileContext();
      resetFurinLoggerForTests();
      process.chdir(fixture.path);
      const child = new Elysia({ prefix: "/api" })
        .use(furinSync(sync))
        .post("/counter", ({ mutation }) =>
          mutation((tx) => {
            tx.insert(counter).values({ value: 1 }).run();
            return { count: value };
          })
        );
      const app = new Elysia()
        .get("/counter", () => db.select().from(counter).all())
        .use(await furin({ pagesDir: join(fixture.path, "src/pages"), sync }))
        .model("result", t.Object({ count: t.String({ pattern: "^valid$" }) }))
        .guard({ response: "result" })
        .use(child);
      const request = () =>
        new Request("http://localhost/api/counter", {
          method: "POST",
          headers: { "idempotency-key": "one" },
        });
      expect((await app.handle(request())).status).toBe(500);
      expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([]);
      value = "valid";
      const result = await app.handle(request());
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ count: "valid" });
      expect(await (await app.handle(request())).json()).toEqual({ count: "valid" });
      expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
        { value: 1 },
      ]);
    } finally {
      sqlite.close();
      process.chdir(cwd);
      __setDevMode(originalDevMode);
      __resetCompileContext();
      resetFurinLoggerForTests();
      fixture.cleanup();
    }
  }
);

test.serial("independent Furin mounts select their transactional Sync runtime", async () => {
  const fixture = createTmpApp("cli-app");
  const cwd = process.cwd();
  const originalDevMode = IS_DEV;
  const sqlite = new Database(":memory:");
  migrateSqliteSync(sqlite);
  const counter = sqliteTable("counter", { value: integer().notNull() });
  sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
  const db = drizzle(sqlite);
  let authorized = false;
  let firstCalls = 0;
  let secondCalls = 0;
  const first = {
    adapter: drizzleSyncAdapter({ db, namespace: "first-mount" }),
    principal: () => {
      firstCalls += 1;
      return "public";
    },
  };
  const second = {
    adapter: drizzleSyncAdapter({ db, namespace: "second-mount" }),
    principal: ({ status }: Context) => {
      secondCalls += 1;
      if (!authorized) {
        throw status(401);
      }
      return "private";
    },
  };
  try {
    __setDevMode(true);
    __resetCompileContext();
    resetFurinLoggerForTests();
    process.chdir(fixture.path);
    const mount = new Elysia({ prefix: "/second/api" })
      .use(furinSync(second))
      .post("/counter", ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return { saved: true };
        })
      );
    const app = new Elysia()
      .use(
        await furin({ prefix: "/first", pagesDir: join(fixture.path, "src/pages"), sync: first })
      )
      .use(
        await furin({ prefix: "/second", pagesDir: join(fixture.path, "src/pages"), sync: second })
      )
      .use(mount)
      .get("/counter", () => db.select().from(counter).all());
    const request = () =>
      new Request("http://localhost/second/api/counter", {
        method: "POST",
        headers: { "idempotency-key": "independent" },
      });
    expect((await app.handle(request())).status).toBe(401);
    authorized = true;
    expect((await app.handle(request())).status).toBe(200);
    expect((await app.handle(request())).status).toBe(200);
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(3);
    expect(await (await app.handle(new Request("http://localhost/counter"))).json()).toEqual([
      { value: 1 },
    ]);
  } finally {
    sqlite.close();
    process.chdir(cwd);
    __setDevMode(originalDevMode);
    __resetCompileContext();
    resetFurinLoggerForTests();
    fixture.cleanup();
  }
});
