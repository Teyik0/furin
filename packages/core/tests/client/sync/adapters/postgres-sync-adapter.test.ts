import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { postgresSyncAdapter } from "../../../../src/server/sync/postgres/index.ts";
import { testSyncAdapterConformance } from "../../../helpers/sync-adapter-conformance.ts";

const databaseUrl = process.env.FURIN_SYNC_POSTGRES_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const succeededResponseCheckPattern = /furin_sync_mutations_succeeded_response_check/;

test("bounds PostgreSQL mutation keys before binding them", async () => {
  const boundValues: unknown[] = [];
  const transaction = ((_: TemplateStringsArray, ...values: unknown[]) => {
    boundValues.push(...values);
    return Promise.resolve([]);
  }) as unknown as SQL;
  const sql = {
    begin<Result>(callback: (tx: SQL) => Promise<Result>): Promise<Result> {
      return callback(transaction);
    },
  } as unknown as SQL;
  const adapter = postgresSyncAdapter({ namespace: "bounded-keys", sql });
  const key = `POST:/cards/${"segment/".repeat(500)}:idempotency-key`;
  const principal = "principal";
  const rawMutationKey = `${principal.length}:${principal}${key}`;
  const digest = new Bun.CryptoHasher("sha256").update(rawMutationKey).digest("hex");

  expect(await adapter.beginMutation({ fingerprint: "fingerprint", key, principal })).toMatchObject(
    { kind: "execute" }
  );
  expect(boundValues).toContain(digest);
  expect(boundValues).not.toContain(rawMutationKey);
  expect(boundValues).not.toContain(`bounded-keys:${rawMutationKey}`);
});

test("requests a reset when retention prunes history while changes are read", async () => {
  let retentionCommitted = false;
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM furin_sync.changes")) {
      await Promise.resolve();
      retentionCommitted = true;
      return [{ cursor: 2, invalidations: [] }];
    }
    return [
      {
        current_cursor: 2,
        oldest_cursor: retentionCommitted ? 2 : 1,
      },
    ];
  }) as unknown as SQL;
  const adapter = postgresSyncAdapter({ namespace: "retention-race", sql });

  expect(await adapter.readChanges({ after: "0", limit: 10 })).toEqual({
    changes: [],
    cursor: "2",
    hasMore: false,
    reset: true,
  });
});

describeWithPostgres("PostgresSyncAdapter", () => {
  const sql = new SQL(databaseUrl as string);
  const namespace = "postgres-conformance";
  const adapter = postgresSyncAdapter({ namespace, sql });

  beforeAll(async () => {
    const migration = await Bun.file(
      new URL("../../../../src/server/sync/postgres/migration.sql", import.meta.url)
    ).text();
    await sql.unsafe(migration);
  });

  beforeEach(async () => {
    await sql`DELETE FROM furin_sync.changes WHERE namespace IN (${namespace}, 'other-namespace')`;
    await sql`DELETE FROM furin_sync.streams WHERE namespace IN (${namespace}, 'other-namespace')`;
    await sql`DELETE FROM furin_sync.mutations WHERE namespace IN (${namespace}, 'other-namespace')`;
  });

  afterAll(async () => {
    await sql.close();
  });

  testSyncAdapterConformance(() => adapter);

  test("rejects succeeded mutations without replay data", async () => {
    try {
      await sql`
        INSERT INTO furin_sync.mutations (
          namespace, mutation_key, mutation_id, fingerprint, state,
          lease_expires_at, expires_at
        ) VALUES (
          ${namespace}, 'invalid-succeeded', ${crypto.randomUUID()}, 'fingerprint', 'succeeded',
          clock_timestamp(), clock_timestamp() + interval '1 day'
        )
      `;
      throw new Error("Expected the replay-data constraint to reject the mutation");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toMatch(succeededResponseCheckPattern);
    }
  });

  test("atomically persists replay response and invalidations", async () => {
    const mutation = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(mutation.kind).toBe("execute");
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }

    const result = await adapter.completeMutation({
      invalidations: [{ kind: "path", path: "/projects", type: "page" }],
      lease: mutation.lease,
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(result).toEqual({ cursor: "1", kind: "committed" });

    const replay = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(replay).toEqual({
      kind: "replay",
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(await adapter.readChanges({ after: "0", limit: 10 })).toEqual({
      changes: [
        {
          cursor: "1",
          invalidations: [{ kind: "path", path: "/projects", type: "page" }],
        },
      ],
      cursor: "1",
      hasMore: false,
      reset: false,
    });
  });

  test("supports mutation keys larger than a PostgreSQL btree entry", async () => {
    const key = Array.from({ length: 300 }, () => crypto.randomUUID()).join(":");
    const response = {
      body: new TextEncoder().encode("created"),
      headers: [["content-type", "text/plain"]] as const,
      status: 201,
    };
    const mutation = await adapter.beginMutation({
      fingerprint: "large-key-fingerprint",
      key,
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }

    expect(await adapter.renewMutation(mutation.lease)).toBe("renewed");
    expect(
      await adapter.completeMutation({
        invalidations: [],
        lease: mutation.lease,
        response,
      })
    ).toEqual({ cursor: undefined, kind: "committed" });
    expect(
      await adapter.beginMutation({
        fingerprint: "large-key-fingerprint",
        key,
        principal: "user",
      })
    ).toEqual({ kind: "replay", response });
  });

  test("allows one owner and rejects a previous owner after lease takeover", async () => {
    const first = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    expect(
      await adapter.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "in-progress" });

    await sql`
      UPDATE furin_sync.mutations
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE namespace = ${namespace}
    `;
    expect(
      await adapter.beginMutation({
        fingerprint: "other-fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
    const replacement = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(replacement.kind).toBe("execute");
    expect(await adapter.renewMutation(first.lease)).toBe("lost");
    expect(
      await adapter.completeMutation({
        invalidations: [],
        lease: first.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      })
    ).toEqual({ kind: "lost" });
  });

  test("keeps namespaces isolated", async () => {
    const other = postgresSyncAdapter({ namespace: "other-namespace", sql });
    const mutation = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(mutation.kind).toBe("execute");
    expect(await other.currentCursor()).toBe("0");
    expect(
      await other.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
  });

  test("orders concurrent completions from separate replicas", async () => {
    const replica = postgresSyncAdapter({ namespace, sql });
    const reservations = await Promise.all([
      adapter.beginMutation({ fingerprint: "one", key: "one", principal: "user" }),
      replica.beginMutation({ fingerprint: "two", key: "two", principal: "user" }),
    ]);
    const [first, second] = reservations;
    if (first?.kind !== "execute" || second?.kind !== "execute") {
      throw new Error("Expected two executable mutations");
    }
    const completed = await Promise.all([
      adapter.completeMutation({
        invalidations: [{ kind: "path", path: "/one", type: "page" }],
        lease: first.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      }),
      replica.completeMutation({
        invalidations: [{ kind: "path", path: "/two", type: "page" }],
        lease: second.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      }),
    ]);
    expect(
      completed.flatMap((result) => (result.kind === "committed" ? [result.cursor] : [])).sort()
    ).toEqual(["1", "2"]);
    expect((await adapter.readChanges({ after: "0", limit: 10 })).changes).toHaveLength(2);
  });
});
