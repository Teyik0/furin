import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { RedisClient, SQL } from "bun";
import { type Context, Elysia } from "elysia";
import type { SyncAdapter } from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { postgresSyncAdapter } from "../../../src/server/sync/postgres/index.ts";
import { redisSyncAdapter } from "../../../src/server/sync/redis/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";

interface JournalFixture {
  adapter: SyncAdapter;
  initialCursor: string;
}

async function verifyPrincipalCatchUp(fixture: JournalFixture): Promise<void> {
  const options = {
    adapter: fixture.adapter,
    principal: ({ request, status }: Context) => {
      const principal = request.headers.get("authorization");
      if (!principal) {
        throw status(401);
      }
      return principal;
    },
  };
  const app = new Elysia()
    .use(furinSync(options))
    .use(createSyncChangesPlugin(options))
    .post(
      "/update/:owner",
      {
        sync: {
          invalidate: (context: Context) => ({
            path: `/private/${context.params.owner}`,
            type: "page",
          }),
        },
      },
      () => ({ success: true })
    );
  const write = (principal: string, key: string) =>
    app.handle(
      new Request(`http://localhost/update/${principal}`, {
        method: "POST",
        headers: { authorization: principal, "idempotency-key": key },
      })
    );
  const read = (principal: string, after: string) =>
    app.handle(
      new Request(`http://localhost/_furin/sync/changes?after=${after}&limit=1`, {
        headers: { authorization: principal },
      })
    );
  expect((await write("alice", "one")).status).toBe(200);
  expect((await write("alice", "two")).status).toBe(200);
  const first = await (await read("alice", fixture.initialCursor)).json();
  expect(first).toMatchObject({
    changes: [{ invalidations: [{ kind: "path", path: "/private/alice", type: "page" }] }],
    hasMore: true,
    reset: false,
  });
  const second = await (await read("alice", first.cursor)).json();
  expect(second).toMatchObject({
    changes: [{ invalidations: [{ path: "/private/alice" }] }],
    hasMore: false,
    reset: false,
  });
  expect(second.cursor).not.toBe(first.cursor);
  const bob = await (await read("bob", fixture.initialCursor)).text();
  expect(JSON.parse(bob)).toEqual({
    changes: [],
    cursor: second.cursor,
    hasMore: false,
    reset: true,
  });
  expect(bob).not.toContain("/private/alice");
  expect((await write("bob", "three")).status).toBe(200);
  const alice = await (await read("alice", second.cursor)).text();
  expect(JSON.parse(alice)).toMatchObject({ changes: [], hasMore: false, reset: true });
  expect(alice).not.toContain("/private/bob");
  const anonymous = await app.handle(new Request("http://localhost/_furin/sync/changes"));
  expect(anonymous.status).toBe(401);
}

test.skipIf(process.env.FURIN_SYNC_POSTGRES_URL === undefined)(
  "PostgreSQL catch-up filters principal provenance through real HTTP",
  async () => {
    const sql = new SQL(process.env.FURIN_SYNC_POSTGRES_URL as string);
    const namespace = crypto.randomUUID();
    try {
      await sql.file(
        fileURLToPath(new URL("../../../src/server/sync/postgres/migration.sql", import.meta.url))
      );
      await verifyPrincipalCatchUp({
        adapter: postgresSyncAdapter({ sql, namespace }),
        initialCursor: "0",
      });
    } finally {
      try {
        await sql.begin(async (transaction) => {
          await transaction`DELETE FROM furin_sync.changes WHERE namespace = ${namespace}`;
          await transaction`DELETE FROM furin_sync.mutations WHERE namespace = ${namespace}`;
          await transaction`DELETE FROM furin_sync.streams WHERE namespace = ${namespace}`;
        });
      } finally {
        await sql.close();
      }
    }
  }
);

test.skipIf(process.env.FURIN_SYNC_REDIS_URL === undefined)(
  "Redis catch-up filters principal provenance through real HTTP",
  async () => {
    const client = new RedisClient(process.env.FURIN_SYNC_REDIS_URL as string);
    const namespace = crypto.randomUUID();
    try {
      await verifyPrincipalCatchUp({
        adapter: redisSyncAdapter({ client, namespace }),
        initialCursor: "0-0",
      });
    } finally {
      try {
        let cursor = "0";
        do {
          // biome-ignore lint/performance/noAwaitInLoops: Redis scan cursors are sequential.
          const [next, keys] = (await client.send("SCAN", [
            cursor,
            "MATCH",
            `furin:sync:{${encodeURIComponent(namespace)}}:*`,
            "COUNT",
            "100",
          ])) as [string, string[]];
          cursor = next;
          if (keys.length > 0) {
            await client.send("DEL", keys);
          }
        } while (cursor !== "0");
      } finally {
        client.close();
      }
    }
  }
);
