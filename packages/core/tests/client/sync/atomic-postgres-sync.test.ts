import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Elysia } from "elysia";
import { createMemoryPageCache } from "../../../src/server/cache/page-cache.ts";
import {
  resetPageCacheAdapter,
  setPageCacheAdapter,
} from "../../../src/server/cache/page-cache-state.ts";
import { defaultInstanceBucket } from "../../../src/server/instance.ts";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import {
  postgresSyncAdapter,
  postgresSyncNotifier,
} from "../../../src/server/sync/postgres/index.ts";
import { prismaSyncAdapter } from "../../../src/server/sync/prisma/index.ts";
import { PrismaClient } from "../../fixtures/sync-prisma/generated/index.js";

const url = process.env.FURIN_SYNC_POSTGRES_URL;
const counter = pgTable("furin_atomic_counter", {
  id: text().primaryKey(),
  value: integer().notNull(),
});
const migration = await Bun.file(
  new URL("../../../src/server/sync/postgres/migration.sql", import.meta.url)
).text();

function request(path: string, key: string) {
  return new Request(`http://localhost/${path}`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}

test.skipIf(!url)("ORM adapters reject notifiers reading a different namespace", async () => {
  const sql = new SQL(url ?? "");
  const adapter = drizzleSyncAdapter({ db: drizzle(sql), namespace: crypto.randomUUID() });
  const notifier = postgresSyncNotifier({ sql, namespace: crypto.randomUUID() });
  try {
    expect(() =>
      new Elysia().use(furinSync({ adapter, notifier, principal: () => "user" }))
    ).toThrow("notification channels do not match");
  } finally {
    await sql.close();
  }
});

test.skipIf(!url)("a locked native transaction retains its lease until commit", async () => {
  const sql = new SQL(url ?? "");
  await sql.unsafe(migration);
  const namespace = crypto.randomUUID();
  const adapter = drizzleSyncAdapter({ db: drizzle(sql), namespace });
  const reservation = await adapter.beginMutation({
    key: "one",
    principal: "user",
    fingerprint: "one",
  });
  if (reservation.kind !== "execute") {
    throw new Error("Expected mutation lease");
  }
  let renewal: Promise<"lost" | "renewed"> | undefined;
  try {
    await sql`UPDATE furin_sync.mutations SET lease_expires_at = clock_timestamp() + interval '300 milliseconds' WHERE namespace = ${namespace}`;
    const result = await adapter.executeMutation(reservation.lease, async () => {
      renewal = adapter.renewMutation(reservation.lease);
      await Bun.sleep(400);
      return {
        value: 1,
        invalidations: [{ kind: "tags", tags: [namespace] }],
        response: { status: 200, headers: [], body: new TextEncoder().encode("1") },
      };
    });
    expect(result.kind).toBe("committed");
    expect(await adapter.currentCursor()).toBe("1");
    expect(await renewal).toBe("lost");
    expect(
      (await adapter.beginMutation({ key: "one", principal: "user", fingerprint: "one" })).kind
    ).toBe("replay");
  } finally {
    await renewal;
    await sql.close();
  }
});

test.skipIf(!url)(
  "Drizzle PostgreSQL shares its transaction with the journal and replays concurrent requests",
  async () => {
    const sql = new SQL(url ?? "");
    await sql.unsafe(migration);
    await sql`CREATE TABLE IF NOT EXISTS furin_atomic_counter (id text PRIMARY KEY, value integer NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`;
    const db = drizzle(sql);
    const namespace = crypto.randomUUID();
    const adapter = drizzleSyncAdapter({ db, namespace });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    try {
      const app = new Elysia()
        .use(furinSync({ adapter, principal: () => "user" }))
        .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, ({ mutation }) =>
          mutation(async (tx) => {
            calls += 1;
            const [row] = await tx.insert(counter).values({ id: namespace, value: 1 }).returning();
            entered.resolve();
            await finish.promise;
            return row;
          })
        );
      const first = app.handle(request("counter", "one"));
      await entered.promise;
      const second = await Promise.race([
        app.handle(request("counter", "one")),
        Bun.sleep(5000).then(() => {
          throw new Error("Duplicate request blocked behind the business transaction");
        }),
      ]);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: "FURIN_MUTATION_IN_PROGRESS" });
      finish.resolve();
      const result = await first;
      expect(result.status).toBe(200);
      const replay = await app.handle(request("counter", "one"));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(await result.json());
      expect(calls).toBe(1);
      expect(await adapter.currentCursor()).toBe("1");
    } finally {
      finish.resolve();
      await sql`DELETE FROM furin_atomic_counter WHERE id = ${namespace}`;
      await sql.close();
    }
  }
);

test.skipIf(!url)(
  "PostgreSQL ORM notifications observe committed writes and invalidated cache",
  async () => {
    const sql = new SQL(url ?? "");
    await sql.unsafe(migration);
    await sql`CREATE TABLE IF NOT EXISTS furin_atomic_counter (id text PRIMARY KEY, value integer NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`;
    const namespace = crypto.randomUUID();
    const db = drizzle(sql);
    const adapter = drizzleSyncAdapter({ db, namespace });
    const cache = createMemoryPageCache();
    const identity = {
      buildId: "atomic",
      key: namespace,
      mode: "isr" as const,
      path: "/counter",
      scope: "",
      tags: [namespace],
    };
    const lease = await cache.acquire({ identity, leaseMs: 1000 });
    if (!lease) {
      throw new Error("Expected cache lease");
    }
    await cache.commit({
      identity,
      lease,
      entry: { cachedAt: Date.now(), payload: "stale", revalidate: null },
    });
    setPageCacheAdapter(defaultInstanceBucket(), cache);
    let observation: Promise<void> | undefined;
    const notifier = {
      notificationChannel: postgresSyncAdapter({ namespace, sql }).notificationChannel,
      publish: () => {
        observation = Promise.all([
          sql<{ value: number }[]>`SELECT value FROM furin_atomic_counter WHERE id = ${namespace}`,
          cache.read(identity),
        ]).then(([rows, entry]) => {
          expect(rows).toEqual([{ value: 1 }]);
          expect(entry).toBeNull();
        });
        return observation;
      },
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    };
    try {
      const app = new Elysia()
        .use(furinSync({ adapter, notifier, principal: () => "user" }))
        .post("/counter", { sync: { invalidate: { tags: [namespace] } } }, ({ mutation }) =>
          mutation(async (tx) => {
            await tx.insert(counter).values({ id: namespace, value: 1 });
            return { value: 1 };
          })
        );
      expect((await app.handle(request("counter", "one"))).status).toBe(200);
      expect(observation).toBeDefined();
      await observation;
    } finally {
      resetPageCacheAdapter(defaultInstanceBucket());
      await sql`DELETE FROM furin_atomic_counter WHERE id = ${namespace}`;
      await sql.close();
    }
  }
);

test.skipIf(!url)(
  "Prisma 7 keeps native transaction model types and rolls back business failures",
  async () => {
    const sql = new SQL(url ?? "");
    await sql.unsafe(migration);
    await sql`CREATE TABLE IF NOT EXISTS furin_atomic_counter (id text PRIMARY KEY, value integer NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`;
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const namespace = crypto.randomUUID();
    const adapter = prismaSyncAdapter({ client, namespace });
    const failures = new Set(["business"]);
    let calls = 0;
    let nativeResult = false;
    try {
      const app = new Elysia()
        .use(furinSync({ adapter, principal: () => "user" }))
        .post("/counter", { sync: { invalidate: { tags: ["counter"] } } }, async ({ mutation }) => {
          const row = await mutation(async (tx) => {
            calls += 1;
            const card = await tx.atomicCounter.create({ data: { id: namespace, value: 1 } });
            if (failures.has("business")) {
              throw new Error("business failure");
            }
            return card;
          });
          nativeResult = row.createdAt instanceof Date;
          return row;
        });
      expect((await app.handle(request("counter", "one"))).status).toBe(500);
      expect(await client.atomicCounter.count({ where: { id: namespace } })).toBe(0);
      expect(await adapter.currentCursor()).toBe("0");
      failures.clear();
      const initial = await app.handle(request("counter", "one"));
      expect(initial.status).toBe(200);
      expect(nativeResult).toBe(true);
      nativeResult = false;
      const replay = await app.handle(request("counter", "one"));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(await initial.json());
      expect(nativeResult).toBe(false);
      expect(calls).toBe(2);
      expect(await adapter.currentCursor()).toBe("1");
    } finally {
      await client.atomicCounter.deleteMany({ where: { id: namespace } });
      await client.$disconnect();
      await sql.close();
    }
  }
);

test.skipIf(!url)(
  "async atomic mutations store bounded Response bodies before commit",
  async () => {
    const sql = new SQL(url ?? "");
    const namespace = crypto.randomUUID();
    try {
      await sql.unsafe(migration);
      await sql`CREATE TABLE IF NOT EXISTS furin_atomic_counter (id text PRIMARY KEY, value integer NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`;
      const adapter = drizzleSyncAdapter({ db: drizzle(sql), namespace });
      const oversized = new Set(["response"]);
      let calls = 0;
      const app = new Elysia()
        .use(furinSync({ adapter, principal: () => "user" }))
        .post("/counter", ({ mutation }) =>
          mutation(async (tx) => {
            calls += 1;
            await tx.insert(counter).values({ id: namespace, value: 1 });
            return oversized.has("response")
              ? new Response("x".repeat(1024 * 1024 + 1), {
                  headers: { "content-length": String(1024 * 1024 + 1) },
                })
              : Response.json(
                  { value: 1 },
                  { status: 202, headers: { "set-cookie": "saved=1", "content-length": "11" } }
                );
          })
        );
      expect((await app.handle(request("counter", "one"))).status).toBe(500);
      expect(
        await sql`SELECT value FROM furin_atomic_counter WHERE id = ${namespace}`
      ).toHaveLength(0);
      expect(await adapter.currentCursor()).toBe("0");
      oversized.clear();
      const initial = await app.handle(request("counter", "one"));
      expect(initial.status).toBe(202);
      expect(initial.headers.get("set-cookie")).toBe("saved=1");
      expect(await initial.json()).toEqual({ value: 1 });
      const replay = await app.handle(request("counter", "one"));
      expect(replay.status).toBe(202);
      expect(replay.headers.get("set-cookie")).toBeNull();
      expect(await replay.json()).toEqual({ value: 1 });
      expect(calls).toBe(2);
    } finally {
      await sql`DELETE FROM furin_atomic_counter WHERE id = ${namespace}`;
      await sql.close();
    }
  }
);
