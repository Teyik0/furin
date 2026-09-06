import type { SQL } from "bun";
import type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
  SyncInvalidation,
} from "../adapter.ts";

const CHANGE_RETENTION = 1000;
const LEASE_MS = 30_000;
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

export interface PostgresSyncAdapterOptions {
  namespace: string;
  sql: SQL;
}

interface MutationRow {
  expired: boolean;
  fingerprint: string;
  mutation_id: string;
  response_body: Uint8Array | null;
  response_headers: [string, string][] | null;
  response_status: number | null;
  state: "in-progress" | "succeeded";
}

interface CursorRow {
  current_cursor: string | number | bigint;
  oldest_cursor: string | number | bigint;
}

interface ChangeRow {
  cursor: string | number | bigint;
  invalidations: SyncInvalidation[];
}

function mutationKey(input: Pick<MutationLease, "key" | "principal">): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${input.principal.length}:${input.principal}${input.key}`)
    .digest("hex");
}

function storedResponse(row: MutationRow): StoredResponse {
  if (row.response_body === null || row.response_headers === null || row.response_status === null) {
    throw new Error("[furin-sync-postgres] Succeeded mutation has no replay response.");
  }
  return {
    body: new Uint8Array(row.response_body),
    headers: row.response_headers,
    status: row.response_status,
  };
}

export class PostgresSyncAdapter implements SyncAdapter {
  readonly scope = "distributed" as const;
  private readonly namespace: string;
  private readonly sql: SQL;

  constructor(options: PostgresSyncAdapterOptions) {
    if (options.namespace.length === 0) {
      throw new Error("[furin-sync-postgres] namespace must not be empty.");
    }
    this.namespace = options.namespace;
    this.sql = options.sql;
  }

  beginMutation(input: BeginMutationInput): Promise<BeginMutationResult> {
    return this.sql.begin(async (tx) => {
      const key = mutationKey(input);
      await tx`
        DELETE FROM furin_sync.mutations
        WHERE ctid IN (
          SELECT ctid FROM furin_sync.mutations
          WHERE
            (state = 'succeeded' AND expires_at <= clock_timestamp())
            OR (
              state = 'in-progress'
              AND lease_expires_at <= clock_timestamp()
              AND expires_at <= clock_timestamp()
            )
          LIMIT 100
        )
      `;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.namespace}:${key}`}, 0))`;
      const rows = await tx<MutationRow[]>`
        SELECT mutation_id, fingerprint, state, response_status, response_headers,
               response_body,
               CASE
                 WHEN state = 'succeeded' THEN expires_at <= clock_timestamp()
                 ELSE lease_expires_at <= clock_timestamp()
               END AS expired
        FROM furin_sync.mutations
        WHERE namespace = ${this.namespace} AND mutation_key = ${key}
        FOR UPDATE
      `;
      const [existing] = rows;
      if (existing && existing.fingerprint !== input.fingerprint) {
        return { kind: "conflict", reason: "payload-mismatch" } as const;
      }
      if (existing && !existing.expired) {
        if (existing.state === "in-progress") {
          return { kind: "conflict", reason: "in-progress" } as const;
        }
        return { kind: "replay", response: storedResponse(existing) } as const;
      }

      const id = crypto.randomUUID();
      await tx`
        INSERT INTO furin_sync.mutations (
          namespace, mutation_key, mutation_id, fingerprint, state,
          lease_expires_at, expires_at, created_at
        ) VALUES (
          ${this.namespace}, ${key}, ${id}, ${input.fingerprint}, 'in-progress',
          clock_timestamp() + (${LEASE_MS} * interval '1 millisecond'),
          clock_timestamp() + (${MUTATION_TTL_MS} * interval '1 millisecond'),
          clock_timestamp()
        )
        ON CONFLICT (namespace, mutation_key) DO UPDATE SET
          mutation_id = EXCLUDED.mutation_id,
          fingerprint = EXCLUDED.fingerprint,
          state = 'in-progress',
          response_status = NULL,
          response_headers = NULL,
          response_body = NULL,
          lease_expires_at = EXCLUDED.lease_expires_at,
          expires_at = EXCLUDED.expires_at,
          created_at = EXCLUDED.created_at,
          completed_at = NULL
      `;
      return {
        kind: "execute",
        lease: { id, key: input.key, leaseMs: LEASE_MS, principal: input.principal },
      } as const;
    });
  }

  async renewMutation(lease: MutationLease): Promise<"lost" | "renewed"> {
    const rows = await this.sql<{ mutation_id: string }[]>`
      UPDATE furin_sync.mutations
      SET lease_expires_at = clock_timestamp() + (${lease.leaseMs} * interval '1 millisecond')
      WHERE namespace = ${this.namespace}
        AND mutation_key = ${mutationKey(lease)}
        AND mutation_id = ${lease.id}
        AND state = 'in-progress'
        AND lease_expires_at > clock_timestamp()
      RETURNING mutation_id
    `;
    return rows.length === 1 ? "renewed" : "lost";
  }

  completeMutation(input: CompleteMutationInput): Promise<CompleteMutationResult> {
    return this.sql.begin(async (tx) => {
      const key = mutationKey(input.lease);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.namespace}:${key}`}, 0))`;
      const active = await tx<{ mutation_id: string }[]>`
        SELECT mutation_id FROM furin_sync.mutations
        WHERE namespace = ${this.namespace}
          AND mutation_key = ${key}
          AND mutation_id = ${input.lease.id}
          AND state = 'in-progress'
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `;
      if (active.length === 0) {
        return { kind: "lost" } as const;
      }

      let cursor: string | undefined;
      if (input.invalidations.length > 0) {
        await tx`
          INSERT INTO furin_sync.streams (namespace, current_cursor, oldest_cursor)
          VALUES (${this.namespace}, 0, 0)
          ON CONFLICT (namespace) DO NOTHING
        `;
        const cursors = await tx<{ current_cursor: string | number | bigint }[]>`
          UPDATE furin_sync.streams
          SET current_cursor = current_cursor + 1
          WHERE namespace = ${this.namespace}
          RETURNING current_cursor
        `;
        cursor = String(cursors[0]?.current_cursor);
        await tx`
          INSERT INTO furin_sync.changes (namespace, cursor, invalidations)
          VALUES (
            ${this.namespace},
            ${cursor},
            ${JSON.stringify(input.invalidations)}::text::jsonb
          )
        `;
        await tx`
          WITH removed AS (
            DELETE FROM furin_sync.changes
            WHERE namespace = ${this.namespace}
              AND cursor <= GREATEST(0, ${cursor}::bigint - ${CHANGE_RETENTION})
            RETURNING cursor
          )
          UPDATE furin_sync.streams
          SET oldest_cursor = COALESCE((SELECT MAX(cursor) + 1 FROM removed), oldest_cursor)
          WHERE namespace = ${this.namespace}
        `;
      }

      await tx`
        UPDATE furin_sync.mutations
        SET state = 'succeeded',
            response_status = ${input.response.status},
            response_headers = ${JSON.stringify(input.response.headers)}::text::jsonb,
            response_body = ${input.response.body},
            completed_at = clock_timestamp(),
            expires_at = clock_timestamp() + (${MUTATION_TTL_MS} * interval '1 millisecond')
        WHERE namespace = ${this.namespace}
          AND mutation_key = ${key}
          AND mutation_id = ${input.lease.id}
      `;
      return { cursor, kind: "committed" } as const;
    });
  }

  async abortMutation(lease: MutationLease): Promise<void> {
    await this.sql`
      DELETE FROM furin_sync.mutations
      WHERE namespace = ${this.namespace}
        AND mutation_key = ${mutationKey(lease)}
        AND mutation_id = ${lease.id}
        AND state = 'in-progress'
    `;
  }

  async currentCursor(): Promise<string> {
    const rows = await this.sql<Pick<CursorRow, "current_cursor">[]>`
      SELECT current_cursor FROM furin_sync.streams WHERE namespace = ${this.namespace}
    `;
    return String(rows[0]?.current_cursor ?? 0);
  }

  async readChanges(input: ReadChangesInput): Promise<ChangePage> {
    const cursorRows = await this.sql<CursorRow[]>`
      SELECT current_cursor, oldest_cursor
      FROM furin_sync.streams WHERE namespace = ${this.namespace}
    `;
    const currentCursor = String(cursorRows[0]?.current_cursor ?? 0);
    if (input.after === undefined) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: false };
    }
    if (!UNSIGNED_INTEGER_PATTERN.test(input.after)) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    if (BigInt(input.after) > BigInt(currentCursor)) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    const oldest = BigInt(cursorRows[0]?.oldest_cursor ?? 0);
    if (BigInt(input.after) < oldest - 1n) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    const [rows, latestCursorRows] = await Promise.all([
      this.sql<ChangeRow[]>`
        SELECT cursor, invalidations
        FROM furin_sync.changes
        WHERE namespace = ${this.namespace} AND cursor > ${input.after}::bigint
        ORDER BY cursor ASC
        LIMIT ${input.limit + 1}
      `,
      this.sql<CursorRow[]>`
        SELECT current_cursor, oldest_cursor
        FROM furin_sync.streams WHERE namespace = ${this.namespace}
      `,
    ]);
    const latestCurrentCursor = String(latestCursorRows[0]?.current_cursor ?? 0);
    const latestOldest = BigInt(latestCursorRows[0]?.oldest_cursor ?? 0);
    if (BigInt(input.after) < latestOldest - 1n) {
      return {
        changes: [],
        cursor: latestCurrentCursor,
        hasMore: false,
        reset: true,
      };
    }
    const hasMore = rows.length > input.limit;
    const changes: SyncChange[] = rows.slice(0, input.limit).map((row) => ({
      cursor: String(row.cursor),
      invalidations: row.invalidations,
    }));
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? input.after,
      hasMore,
      reset: false,
    };
  }
}

export function postgresSyncAdapter(options: PostgresSyncAdapterOptions): PostgresSyncAdapter {
  return new PostgresSyncAdapter(options);
}
