// biome-ignore-all lint/suspicious/noUnusedExpressions: assertions verify public type inference.

import type { Database } from "bun:sqlite";
import { test } from "bun:test";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Elysia } from "elysia";
import { expectTypeOf } from "expect-type";
import type { SyncMutation, SyncTransaction } from "../../src/server/sync/adapter.ts";
import {
  type DrizzleSqliteSyncAdapter,
  drizzleSyncAdapter,
} from "../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../src/server/sync/plugin.ts";
import { prismaSyncAdapter } from "../../src/server/sync/prisma/index.ts";
import type { Prisma, PrismaClient } from "../fixtures/sync-prisma/generated/index.js";

const counter = sqliteTable("typed_counter", { value: integer().notNull() });
const schema = { counter };
type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

function typedApp(db: Db) {
  const adapter = drizzleSyncAdapter({ db, namespace: "types" });
  return new Elysia({ prefix: "/api" })
    .get("/existing", () => ({ existing: true }))
    .use(furinSync({ adapter, principal: () => "user" }))
    .post("/counter", ({ mutation }) =>
      mutation((tx) => {
        const result = tx.query.counter.findFirst().sync();
        const value: number | undefined = result?.value;
        return { value };
      })
    );
}

function prismaAdapter(client: PrismaClient) {
  return prismaSyncAdapter({ client, namespace: "types" });
}

function typedFactoryApp(db: Db) {
  return new Elysia()
    .use(
      furinSync({
        adapter: () => drizzleSyncAdapter({ db, namespace: "factory-types" }),
        principal: () => "user",
      })
    )
    .post("/counter", ({ mutation }) => {
      const invalid = () => {
        // @ts-expect-error Factory inference must still forbid async SQLite callbacks.
        mutation(async (tx) => tx.query.counter.findFirst());
      };
      expectTypeOf(invalid).toBeFunction();
      return mutation((tx) => {
        expectTypeOf(tx).toEqualTypeOf<SyncTransaction<DrizzleSqliteSyncAdapter<Db>>>();
        return { value: tx.query.counter.findFirst().sync()?.value };
      });
    });
}

function typedAsyncFactoryApp(client: PrismaClient) {
  return new Elysia()
    .use(
      furinSync({
        adapter: () => prismaAdapter(client),
        principal: () => "user",
      })
    )
    .post("/async", ({ mutation }) =>
      mutation((tx) => {
        expectTypeOf(tx).toEqualTypeOf<Prisma.TransactionClient>();
        return Promise.resolve({ value: Boolean(tx) });
      })
    );
}

function invalidSyncCallback(mutation: SyncMutation<DrizzleSqliteSyncAdapter<Db>>) {
  // @ts-expect-error SQLite callbacks cannot keep a synchronous transaction open across await.
  mutation(async (tx) => tx.query.counter.findFirst());
}
expectTypeOf(invalidSyncCallback).toBeFunction();

test("atomic mutation preserves native transactions, existing routes and Eden success payloads", () => {
  type Routes = ReturnType<typeof typedApp>["~Routes"];
  expectTypeOf<Routes["api"]["existing"]["get"]["response"][200]>().toEqualTypeOf<{
    existing: boolean;
  }>();
  expectTypeOf<Routes["api"]["counter"]["post"]["response"][200]>().toEqualTypeOf<{
    value: number | undefined;
  }>();
  expectTypeOf<
    SyncTransaction<ReturnType<typeof prismaAdapter>>
  >().toEqualTypeOf<Prisma.TransactionClient>();
});

test("adapter factories preserve sync and async transactions and Eden payloads", () => {
  type Routes = ReturnType<typeof typedFactoryApp>["~Routes"];
  expectTypeOf<Routes["counter"]["post"]["response"][200]>().toEqualTypeOf<{
    value: number | undefined;
  }>();
  type AsyncRoutes = ReturnType<typeof typedAsyncFactoryApp>["~Routes"];
  expectTypeOf<AsyncRoutes["async"]["post"]["response"][200]>().toEqualTypeOf<{ value: boolean }>();
});
