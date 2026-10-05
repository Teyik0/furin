import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Elysia } from "elysia";
import { furin } from "../../../src/furin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync } from "../../../src/server/sync/sqlite/index.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

const counter = sqliteTable("counter", { value: integer().notNull() });

test.each(["", "/api"])(
  "furin sync preserves opaque mounts at prefix '%s' and inner atomic replay",
  async (prefix) => {
    const fixture = createTmpApp("cli-app");
    const sqlite = new Database(":memory:");
    sqlite.run("CREATE TABLE counter (value INTEGER NOT NULL)");
    migrateSqliteSync(sqlite);
    const db = drizzle(sqlite);
    const sync = {
      adapter: drizzleSyncAdapter({ db, namespace: "mounted-sync" }),
      principal: () => "user",
    };
    const path = prefix ? "/counter" : "/api/counter";
    const inner = new Elysia()
      .use(furinSync(sync))
      .get(path, ({ request }) => ({
        path: new URL(request.url).pathname,
        rows: db.select().from(counter).all(),
      }))
      .post(path, ({ mutation }) =>
        mutation((tx) => {
          tx.insert(counter).values({ value: 1 }).run();
          return new Response(null, {
            status: 201,
            headers: { "x-inner": "kept" },
          });
        })
      );
    const previousDevMode = IS_DEV;
    __setDevMode(true);
    try {
      const outer = new Elysia()
        .use(new Elysia({ prefix }).mount(async (request) => await inner.handle(request)))
        .use(await furin({ pagesDir: join(fixture.path, "src/pages"), sync }));
      const read = () => outer.handle(new Request("http://localhost/api/counter"));
      const initial = await read();
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ path, rows: [] });
      const write = () =>
        outer.handle(
          new Request("http://localhost/api/counter", {
            method: "POST",
            headers: { "idempotency-key": "one" },
          })
        );
      expect(
        (
          await outer.handle(
            new Request("http://localhost/api/counter", {
              method: "POST",
            })
          )
        ).status
      ).toBe(428);
      const committed = await write();
      expect(committed.status).toBe(201);
      expect(committed.headers.get("x-inner")).toBe("kept");
      expect(await committed.text()).toBe("");
      const replay = await write();
      expect(replay.status).toBe(201);
      expect(replay.headers.get("x-inner")).toBe("kept");
      expect(await replay.text()).toBe("");
      expect(await (await read()).json()).toEqual({ path, rows: [{ value: 1 }] });
    } finally {
      __setDevMode(previousDevMode);
      sqlite.close();
      fixture.cleanup();
    }
  }
);
