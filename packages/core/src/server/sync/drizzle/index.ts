import { Database } from "bun:sqlite";
import { sql as drizzleSql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  AtomicMutationResult,
  AtomicMutationValue,
  MutationLease,
  TransactionalSyncAdapter,
} from "../adapter.ts";
import { MutationLeaseLost } from "../execution-error.ts";
import { executePostgresMutation } from "../postgres/execute.ts";
import { PostgresSyncAdapter } from "../postgres/index.ts";
import { transactionSql } from "../postgres/sql.ts";
import { SqliteSyncAdapter } from "../sqlite/index.ts";

interface Schema {
  [table: string]: unknown;
}
type Transaction<Db extends BunSQLiteDatabase<Schema> | BunSQLDatabase<Schema>> = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export class DrizzleSqliteSyncAdapter<Db extends BunSQLiteDatabase<Schema>>
  extends SqliteSyncAdapter
  implements TransactionalSyncAdapter<Transaction<Db>, "sync">
{
  readonly transactionMode = "sync" as const;
  private readonly db: Db;

  constructor(options: { db: Db & { $client: import("bun:sqlite").Database }; namespace: string }) {
    super({ database: options.db.$client, namespace: options.namespace });
    this.db = options.db;
  }

  // biome-ignore lint/suspicious/useAwait: Bun SQLite commits synchronously before the returned promise resolves.
  async executeMutation<T>(
    lease: MutationLease,
    callback: (tx: Transaction<Db>) => AtomicMutationValue<T> | Promise<AtomicMutationValue<T>>
  ): Promise<AtomicMutationResult<T>> {
    return this.db.transaction(
      (tx) => {
        if (!this.hasMutationLeaseSync(lease)) {
          throw new MutationLeaseLost(
            "[furin] Mutation lease lost; the transaction was rolled back."
          );
        }
        const result = callback(tx as Transaction<Db>);
        if (result instanceof Promise) {
          throw new Error("[furin] Bun SQLite mutation callbacks must be synchronous.");
        }
        const completion = this.completeMutationSync({ ...result, lease });
        if (completion.kind === "lost") {
          throw new MutationLeaseLost(
            "[furin] Mutation lease lost; the transaction was rolled back."
          );
        }
        return { ...result, cursor: completion.cursor, kind: "committed" as const };
      },
      { behavior: "immediate" }
    );
  }
}

export class DrizzlePostgresSyncAdapter<Db extends BunSQLDatabase<Schema>>
  extends PostgresSyncAdapter
  implements TransactionalSyncAdapter<Transaction<Db>, "async">
{
  readonly transactionMode = "async" as const;
  private readonly db: Db;
  private readonly syncNamespace: string;

  constructor(options: { db: Db & { $client: import("bun").SQL }; namespace: string }) {
    const sql = transactionSql(<Rows>(strings: TemplateStringsArray, values: unknown[]) =>
      Promise.resolve(options.db.execute(drizzleSql(strings, ...values))).then(
        (rows) => rows as unknown as Rows
      )
    );
    sql.begin = (callback) =>
      options.db.transaction((tx) =>
        callback(
          transactionSql(<Rows>(strings: TemplateStringsArray, values: unknown[]) =>
            Promise.resolve(tx.execute(drizzleSql(strings, ...values))).then(
              (rows) => rows as unknown as Rows
            )
          )
        )
      );
    super({ namespace: options.namespace, sql, publishNotifications: false });
    this.db = options.db;
    this.syncNamespace = options.namespace;
  }

  executeMutation<T>(
    lease: MutationLease,
    callback: (tx: Transaction<Db>) => AtomicMutationValue<T> | Promise<AtomicMutationValue<T>>
  ): Promise<AtomicMutationResult<T>> {
    return this.db.transaction((tx) => {
      const sql = transactionSql(<Rows>(strings: TemplateStringsArray, values: unknown[]) =>
        Promise.resolve(tx.execute(drizzleSql(strings, ...values))).then(
          (rows) => rows as unknown as Rows
        )
      );
      return executePostgresMutation(
        new PostgresSyncAdapter({
          namespace: this.syncNamespace,
          sql,
          publishNotifications: false,
        }),
        lease,
        tx as Transaction<Db>,
        callback
      );
    });
  }
}

export function drizzleSyncAdapter<Db extends BunSQLiteDatabase<Schema>>(options: {
  db: Db & { $client: import("bun:sqlite").Database };
  namespace: string;
}): DrizzleSqliteSyncAdapter<Db>;
export function drizzleSyncAdapter<Db extends BunSQLDatabase<Schema>>(options: {
  db: Db & { $client: import("bun").SQL };
  namespace: string;
}): DrizzlePostgresSyncAdapter<Db>;
export function drizzleSyncAdapter(options: {
  db: (BunSQLiteDatabase<Schema> | BunSQLDatabase<Schema>) & {
    $client: import("bun:sqlite").Database | import("bun").SQL;
  };
  namespace: string;
}):
  | DrizzleSqliteSyncAdapter<BunSQLiteDatabase<Schema>>
  | DrizzlePostgresSyncAdapter<BunSQLDatabase<Schema>> {
  if (!(options.db.$client instanceof Database)) {
    return new DrizzlePostgresSyncAdapter(
      options as { db: BunSQLDatabase<Schema> & { $client: import("bun").SQL }; namespace: string }
    );
  }
  return new DrizzleSqliteSyncAdapter(
    options as {
      db: BunSQLiteDatabase<Schema> & { $client: import("bun:sqlite").Database };
      namespace: string;
    }
  );
}
