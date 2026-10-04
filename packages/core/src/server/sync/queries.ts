import type { Context } from "elysia";
import {
  type QueryIdentity,
  type QueryScope,
  queryFromTag,
  queryTag,
  type SyncQueryIdentity,
  serializeQueryHeader,
} from "../../shared/sync-query.ts";
import type {
  InvalidationInput,
  InvalidationRule,
  SyncInvalidationInput,
} from "../auto-invalidate/types.ts";

export type SyncInvalidationSelector =
  | SyncInvalidationInput
  | ((context: Context & { responseValue: unknown }) => SyncInvalidationInput);

interface UnregisteredRead {
  id: string;
  scope?: QueryScope | ((context: Context) => QueryScope);
}

type RegisteredRead<Identity> = Identity extends SyncQueryIdentity
  ? { id: Identity["id"] } & (string extends keyof Identity["scope"]
      ? { scope?: Identity["scope"] | ((context: Context) => Identity["scope"]) }
      : { scope: Identity["scope"] | ((context: Context) => Identity["scope"]) })
  : never;

export type SyncReadOption = string extends SyncQueryIdentity["id"]
  ? UnregisteredRead
  : RegisteredRead<SyncQueryIdentity>;

export function resolveSyncInvalidations(
  input: SyncInvalidationSelector | undefined,
  context: Context,
  value: unknown
): InvalidationInput | undefined {
  if (input === undefined) {
    return;
  }
  const selected =
    typeof input === "function"
      ? input(
          Object.assign(Object.create(Object.getPrototypeOf(context)), context, {
            responseValue: value,
          })
        )
      : input;
  const rules = Array.isArray(selected) ? selected : [selected];
  return rules.map((rule): InvalidationRule => ("id" in rule ? { tags: [queryTag(rule)] } : rule));
}

export function appendQueryInvalidations(
  input: InvalidationInput | undefined,
  context: Pick<Context, "set">
): void {
  if (input === undefined) {
    return;
  }
  const queries: QueryIdentity[] = [];
  for (const rule of Array.isArray(input) ? input : [input]) {
    for (const tag of rule.tags ?? []) {
      const identity = queryFromTag(tag);
      if (identity) {
        queries.push(identity);
      }
    }
  }
  if (queries.length > 0) {
    context.set.headers["x-furin-queries"] = serializeQueryHeader(queries);
    context.set.headers["x-furin-sync"] = "1";
  }
}
