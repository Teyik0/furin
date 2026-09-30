import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { furin } from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { resetFurinLoggerForTests } from "../../../src/server/logger.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync } from "../../../src/server/sync/sqlite/index.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

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
