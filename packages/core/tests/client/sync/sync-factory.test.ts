import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createBrowserEventsPlugin,
  createSseBrowserEventsPlugin,
} from "../../../src/server/browser-events/plugin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { invalidateSync } from "../../../src/server/sync/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";

test.each(["sse", "ws"] as const)(
  "%s prepares the adapter during composition",
  async (transport) => {
    using database = new Database(":memory:");
    migrateSqliteSync(database);
    let calls = 0;
    const sync = {
      adapter: () => {
        calls += 1;
        return sqliteSyncAdapter({ database, namespace: "factory" });
      },
      principal: () => "alice",
    };
    const options = { development: true, sync };
    const app = new Elysia().use(
      transport === "sse"
        ? createSseBrowserEventsPlugin(options)
        : createBrowserEventsPlugin(options)
    );
    expect(calls).toBe(1);
    const response = await app.handle(
      new Request("http://localhost/_furin/events", { method: "HEAD" })
    );
    expect(response.status).toBe(200);
    await invalidateSync(sync, "/message");
    expect(calls).toBe(1);
  }
);

test("out-of-request invalidation never starts an uncomposed factory", async () => {
  let calls = 0;
  const sync = {
    adapter: () => {
      calls += 1;
      throw new Error("Factory must not run");
    },
    principal: () => "alice",
  };
  await expect(invalidateSync(sync, "/message")).rejects.toThrow("Compose furinSync");
  expect(calls).toBe(0);
});

test("factory failures reject composition before the application can listen", () => {
  const sync = {
    adapter: () => {
      throw new Error("Services are not ready");
    },
    principal: () => "alice",
  };
  expect(() => new Elysia().use(furinSync(sync))).toThrow("Services are not ready");
});

test("a development composition cannot bypass production adapter validation", () => {
  using database = new Database(":memory:");
  migrateSqliteSync(database);
  let calls = 0;
  const sync = {
    adapter: () => {
      calls += 1;
      return sqliteSyncAdapter({ database, namespace: "modes" });
    },
    principal: () => "alice",
  };
  createSseBrowserEventsPlugin({ development: true, sync });
  expect(() => createSseBrowserEventsPlugin({ development: false, sync })).toThrow(
    "process-local SyncAdapter"
  );
  expect(calls).toBe(1);
});

test("async factories are rejected during composition", () => {
  using database = new Database(":memory:");
  migrateSqliteSync(database);
  const sync = {
    adapter: () => Promise.resolve(sqliteSyncAdapter({ database, namespace: "async" })),
    principal: () => "alice",
  };
  // @ts-expect-error Factories must be synchronous in TypeScript and at runtime.
  expect(() => new Elysia().use(furinSync(sync))).toThrow("synchronously");
});

test.serial("a composed plugin keeps its mode when the process default changes", async () => {
  using database = new Database(":memory:");
  migrateSqliteSync(database);
  const original = IS_DEV;
  try {
    __setDevMode(true);
    const app = new Elysia()
      .use(
        furinSync({
          adapter: () => sqliteSyncAdapter({ database, namespace: "fixed-mode" }),
          principal: () => "alice",
        })
      )
      .get("/message", () => ({ message: "Ready" }));
    __setDevMode(false);
    const response = await app.handle(new Request("http://localhost/message"));
    expect(response.status).toBe(200);
  } finally {
    __setDevMode(original);
  }
});
