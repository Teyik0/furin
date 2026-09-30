export interface SyncSqlQuery {
  notify: (channel: string, cursor: string) => Promise<void>;
  <Rows>(strings: TemplateStringsArray, ...values: unknown[]): Promise<Rows>;
}

export interface SyncSql extends SyncSqlQuery {
  begin: <T>(callback: (tx: SyncSqlQuery) => Promise<T>) => Promise<T>;
}

export function transactionSql(
  query: <Rows>(strings: TemplateStringsArray, values: unknown[]) => Promise<Rows>
): SyncSql {
  const sql = (<Rows>(strings: TemplateStringsArray, ...values: unknown[]) =>
    query<Rows>(strings, values)) as SyncSql;
  sql.begin = (callback) => callback(sql);
  sql.notify = async (channel, cursor) => {
    await sql`SELECT pg_notify(${channel}, ${cursor})::text`;
  };
  return sql;
}
