// biome-ignore-all lint/suspicious/useAwait: bun:sqlite is synchronous, while SyncAdapter methods intentionally normalize failures into rejected promises.
import type { Database } from "bun:sqlite";
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
import migrationSql from "./migration.sql" with { type: "text" };

const CHANGE_RETENTION = 1000;
const LEASE_MS = 30_000;
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

export interface SqliteSyncAdapterOptions {
  database: Database;
  namespace: string;
}

interface MutationRow {
  expires_at: number;
  fingerprint: string;
  lease_expires_at: number;
  mutation_id: string;
  response_body: Uint8Array | null;
  response_headers: string | null;
  response_status: number | null;
  state: "in-progress" | "succeeded";
}

interface CursorRow {
  current_cursor: string;
  oldest_cursor: string;
}

interface ChangeRow {
  cursor: string;
  invalidations: string;
}

interface MinimumCursorRow {
  cursor: string | null;
}

function mutationKey(input: Pick<MutationLease, "key" | "principal">): string {
  return `${input.principal.length}:${input.principal}${input.key}`;
}

function storedResponse(row: MutationRow): StoredResponse {
  if (row.response_body === null || row.response_headers === null || row.response_status === null) {
    throw new Error("[furin-sync-sqlite] Succeeded mutation has no replay response.");
  }
  return {
    body: new Uint8Array(row.response_body),
    headers: JSON.parse(row.response_headers) as [string, string][],
    status: row.response_status,
  };
}

export function migrateSqliteSync(database: Database): void {
  database.run(migrationSql);
}

export class SqliteSyncAdapter implements SyncAdapter {
  readonly scope: "host-local" | "process-local";
  private readonly database: Database;
  private readonly namespace: string;

  constructor(options: SqliteSyncAdapterOptions) {
    if (options.namespace.length === 0) {
      throw new Error("[furin-sync-sqlite] namespace must not be empty.");
    }
    this.database = options.database;
    this.namespace = options.namespace;
    this.scope =
      options.database.filename === "" || options.database.filename === ":memory:"
        ? "process-local"
        : "host-local";
  }

  async beginMutation(input: BeginMutationInput): Promise<BeginMutationResult> {
    return this.beginMutationSync(input);
  }

  protected beginMutationSync(input: BeginMutationInput): BeginMutationResult {
    const transaction = this.database.transaction(
      (mutation: BeginMutationInput): BeginMutationResult => {
        const now = Date.now();
        const key = mutationKey(mutation);
        this.database
          .query<never, [number, number, number]>(
            `DELETE FROM furin_sync_mutations WHERE rowid IN (
               SELECT rowid FROM furin_sync_mutations
               WHERE
                 (state = 'succeeded' AND expires_at <= ?)
                 OR (
                   state = 'in-progress'
                   AND lease_expires_at <= ?
                   AND expires_at <= ?
                 )
               LIMIT 100
             )`
          )
          .run(now, now, now);
        const existing = this.database
          .query<MutationRow, [string, string]>(
            `SELECT mutation_id, fingerprint, state, response_status, response_headers,
                    response_body, lease_expires_at, expires_at
             FROM furin_sync_mutations
             WHERE namespace = ? AND mutation_key = ?`
          )
          .get(this.namespace, key);
        if (existing?.fingerprint !== undefined && existing.fingerprint !== mutation.fingerprint) {
          return { kind: "conflict", reason: "payload-mismatch" };
        }
        const expired =
          existing?.state === "in-progress"
            ? existing.lease_expires_at <= now
            : existing?.expires_at !== undefined && existing.expires_at <= now;
        if (existing && !expired) {
          return existing.state === "in-progress"
            ? { kind: "conflict", reason: "in-progress" }
            : { kind: "replay", response: storedResponse(existing) };
        }

        const id = crypto.randomUUID();
        this.database
          .query<never, [string, string, string, string, number, number, number]>(
            `INSERT INTO furin_sync_mutations (
               namespace, mutation_key, mutation_id, fingerprint, state,
               lease_expires_at, expires_at, created_at
             ) VALUES (?, ?, ?, ?, 'in-progress', ?, ?, ?)
             ON CONFLICT (namespace, mutation_key) DO UPDATE SET
               mutation_id = excluded.mutation_id,
               fingerprint = excluded.fingerprint,
               state = 'in-progress',
               response_status = NULL,
               response_headers = NULL,
               response_body = NULL,
               lease_expires_at = excluded.lease_expires_at,
               expires_at = excluded.expires_at,
               created_at = excluded.created_at,
               completed_at = NULL`
          )
          .run(
            this.namespace,
            key,
            id,
            mutation.fingerprint,
            now + LEASE_MS,
            now + MUTATION_TTL_MS,
            now
          );
        return {
          kind: "execute",
          lease: { id, key: mutation.key, leaseMs: LEASE_MS, principal: mutation.principal },
        };
      }
    );
    return transaction.immediate(input);
  }

  async completeMutation(input: CompleteMutationInput): Promise<CompleteMutationResult> {
    return this.completeMutationSync(input);
  }

  protected completeMutationSync(input: CompleteMutationInput): CompleteMutationResult {
    const transaction = this.database.transaction(
      (completion: CompleteMutationInput): CompleteMutationResult => {
        const now = Date.now();
        const key = mutationKey(completion.lease);
        if (!this.hasMutationLeaseSync(completion.lease)) {
          return { kind: "lost" };
        }

        let cursor: string | undefined;
        if (completion.invalidations.length > 0) {
          this.database
            .query<never, [string]>(
              `INSERT INTO furin_sync_streams (namespace, current_cursor, oldest_cursor)
               VALUES (?, 0, 0) ON CONFLICT (namespace) DO NOTHING`
            )
            .run(this.namespace);
          this.database
            .query<never, [string]>(
              `UPDATE furin_sync_streams SET current_cursor = current_cursor + 1
               WHERE namespace = ?`
            )
            .run(this.namespace);
          const cursorRow = this.database
            .query<Pick<CursorRow, "current_cursor">, [string]>(
              `SELECT CAST(current_cursor AS TEXT) AS current_cursor
                 FROM furin_sync_streams WHERE namespace = ?`
            )
            .get(this.namespace);
          if (!cursorRow) {
            throw new Error("[furin-sync-sqlite] Could not allocate a change cursor.");
          }
          cursor = cursorRow.current_cursor;
          this.database
            .query<never, [string, string, string, number]>(
              `INSERT INTO furin_sync_changes (namespace, cursor, invalidations, created_at)
               VALUES (?, ?, ?, ?)`
            )
            .run(
              this.namespace,
              cursorRow.current_cursor,
              JSON.stringify(completion.invalidations),
              now
            );
          const removed = this.database
            .query<never, [string, string, number]>(
              `DELETE FROM furin_sync_changes
                 WHERE namespace = ? AND cursor <= MAX(0, CAST(? AS INTEGER) - ?)`
            )
            .run(this.namespace, cursorRow.current_cursor, CHANGE_RETENTION);
          if (removed.changes > 0) {
            const oldest = this.database
              .query<MinimumCursorRow, [string]>(
                `SELECT CAST(MIN(cursor) AS TEXT) AS cursor
                   FROM furin_sync_changes WHERE namespace = ?`
              )
              .get(this.namespace);
            this.database
              .query<never, [string, string]>(
                "UPDATE furin_sync_streams SET oldest_cursor = ? WHERE namespace = ?"
              )
              .run(oldest?.cursor ?? cursorRow.current_cursor, this.namespace);
          }
        }

        this.database
          .query<never, [number, string, Uint8Array, number, number, string, string, string]>(
            `UPDATE furin_sync_mutations
             SET state = 'succeeded', response_status = ?, response_headers = ?,
                 response_body = ?, completed_at = ?, expires_at = ?
             WHERE namespace = ? AND mutation_key = ? AND mutation_id = ?`
          )
          .run(
            completion.response.status,
            JSON.stringify(completion.response.headers),
            completion.response.body,
            now,
            now + MUTATION_TTL_MS,
            this.namespace,
            key,
            completion.lease.id
          );
        return { cursor, kind: "committed" };
      }
    );
    return transaction.immediate(input);
  }

  protected hasMutationLeaseSync(lease: MutationLease): boolean {
    return (
      this.database
        .query<{ mutation_id: string }, [string, string, string, number]>(
          `SELECT mutation_id FROM furin_sync_mutations WHERE namespace = ? AND mutation_key = ? AND mutation_id = ? AND state = 'in-progress' AND lease_expires_at > ?`
        )
        .get(this.namespace, mutationKey(lease), lease.id, Date.now()) !== null
    );
  }

  async abortMutation(lease: MutationLease): Promise<void> {
    this.database
      .query<never, [string, string, string]>(
        `DELETE FROM furin_sync_mutations
           WHERE namespace = ? AND mutation_key = ? AND mutation_id = ? AND state = 'in-progress'`
      )
      .run(this.namespace, mutationKey(lease), lease.id);
  }

  async currentCursor(): Promise<string> {
    const row = this.database
      .query<Pick<CursorRow, "current_cursor">, [string]>(
        `SELECT CAST(current_cursor AS TEXT) AS current_cursor
           FROM furin_sync_streams WHERE namespace = ?`
      )
      .get(this.namespace);
    return row?.current_cursor ?? "0";
  }

  async readChanges(input: ReadChangesInput): Promise<ChangePage> {
    const transaction = this.database.transaction((page: ReadChangesInput): ChangePage => {
      const cursorRow = this.database
        .query<CursorRow, [string]>(
          `SELECT CAST(current_cursor AS TEXT) AS current_cursor,
                    CAST(oldest_cursor AS TEXT) AS oldest_cursor
             FROM furin_sync_streams WHERE namespace = ?`
        )
        .get(this.namespace);
      const currentCursor = cursorRow?.current_cursor ?? "0";
      if (page.after === undefined) {
        return { changes: [], cursor: currentCursor, hasMore: false, reset: false };
      }
      if (
        !UNSIGNED_INTEGER_PATTERN.test(page.after) ||
        BigInt(page.after) > BigInt(currentCursor) ||
        BigInt(page.after) < BigInt(cursorRow?.oldest_cursor ?? "0") - 1n
      ) {
        return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
      }
      const rows = this.database
        .query<ChangeRow, [string, string, number]>(
          `SELECT CAST(cursor AS TEXT) AS cursor, invalidations FROM furin_sync_changes
           WHERE namespace = ? AND cursor > CAST(? AS INTEGER) ORDER BY cursor ASC LIMIT ?`
        )
        .all(this.namespace, page.after, page.limit + 1);
      const hasMore = rows.length > page.limit;
      const changes: SyncChange[] = rows.slice(0, page.limit).map((row) => ({
        cursor: row.cursor,
        invalidations: JSON.parse(row.invalidations) as SyncInvalidation[],
      }));
      return {
        changes,
        cursor: changes.at(-1)?.cursor ?? page.after,
        hasMore,
        reset: false,
      };
    });
    return transaction(input);
  }

  async renewMutation(lease: MutationLease): Promise<"lost" | "renewed"> {
    const now = Date.now();
    const result = this.database
      .query<never, [number, string, string, string, number]>(
        `UPDATE furin_sync_mutations SET lease_expires_at = ?
           WHERE namespace = ? AND mutation_key = ? AND mutation_id = ?
             AND state = 'in-progress' AND lease_expires_at > ?`
      )
      .run(now + lease.leaseMs, this.namespace, mutationKey(lease), lease.id, now);
    return result.changes === 1 ? "renewed" : "lost";
  }
}

export function sqliteSyncAdapter(options: SqliteSyncAdapterOptions): SqliteSyncAdapter {
  return new SqliteSyncAdapter(options);
}
