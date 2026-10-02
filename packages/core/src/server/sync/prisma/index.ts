import type {
  AtomicMutationResult,
  AtomicMutationValue,
  MutationLease,
  TransactionalSyncAdapter,
} from "../adapter.ts";
import { executePostgresMutation } from "../postgres/execute.ts";
import { PostgresSyncAdapter } from "../postgres/index.ts";
import { transactionSql } from "../postgres/sql.ts";

interface PrismaQuery {
  $queryRawUnsafe: <Rows>(query: string, ...values: unknown[]) => Promise<Rows>;
}

interface PrismaClient<Tx extends PrismaQuery> extends PrismaQuery {
  $transaction: <T>(callback: (tx: Tx) => Promise<T>) => Promise<T>;
}

function prismaSql(client: PrismaQuery) {
  return transactionSql(<Rows>(strings: TemplateStringsArray, values: unknown[]) => {
    const query = strings.reduce(
      (text, part, index) => text + (index === 0 ? "" : `$${index}`) + part,
      ""
    );
    return client.$queryRawUnsafe<Rows>(query, ...values);
  });
}

export class PrismaSyncAdapter<Tx extends PrismaQuery>
  extends PostgresSyncAdapter
  implements TransactionalSyncAdapter<Tx, "async">
{
  readonly transactionMode = "async" as const;
  private readonly client: PrismaClient<Tx>;
  private readonly syncNamespace: string;

  constructor(options: { client: PrismaClient<Tx>; namespace: string }) {
    const sql = prismaSql(options.client);
    sql.begin = (callback) => options.client.$transaction((tx) => callback(prismaSql(tx)));
    super({ namespace: options.namespace, sql, publishNotifications: false });
    this.client = options.client;
    this.syncNamespace = options.namespace;
  }

  executeMutation<T>(
    lease: MutationLease,
    callback: (tx: Tx) => AtomicMutationValue<T> | Promise<AtomicMutationValue<T>>
  ): Promise<AtomicMutationResult<T>> {
    return this.client.$transaction((tx) =>
      executePostgresMutation(
        new PostgresSyncAdapter({
          namespace: this.syncNamespace,
          sql: prismaSql(tx),
          publishNotifications: false,
        }),
        lease,
        tx,
        callback
      )
    );
  }
}

/** Prisma 7, PostgreSQL. The sync SQL migration must run on the same database. */
export function prismaSyncAdapter<Tx extends PrismaQuery>(options: {
  client: PrismaClient<Tx>;
  namespace: string;
}): PrismaSyncAdapter<Tx> {
  return new PrismaSyncAdapter(options);
}
