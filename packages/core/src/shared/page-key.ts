export type RemountDependency = string | number | boolean | null | undefined;

export type RemountDeps<Params, Query> = (context: {
  readonly params: Params;
  readonly query: Query;
}) => readonly RemountDependency[];

function identityValue(value: unknown): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Shared by SSR and navigation; loader data never participates in page identity. */
export function pageKey(
  pattern: string,
  data: object,
  remountDeps: RemountDeps<object, object> | undefined
): string {
  const { params, query } = data as { params?: object; query?: object };
  if (remountDeps) {
    const deps = remountDeps({ params: params ?? {}, query: query ?? {} });
    return JSON.stringify([pattern, deps.map((value) => [typeof value, identityValue(value)])]);
  }
  const entries = Object.entries(params ?? {}).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  });
  return JSON.stringify([
    pattern,
    entries.map(([name, value]) => [
      name,
      Array.isArray(value) ? value.map(identityValue) : identityValue(value),
    ]),
  ]);
}
