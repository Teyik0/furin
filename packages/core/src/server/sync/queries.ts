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

export type SyncInvalidationSelector<RouteContext> =
  | SyncInvalidationInput
  | ((context: RouteContext) => SyncInvalidationInput);

const collected = new WeakMap<Request, SyncInvalidationInput[]>();

/** Records a handler invalidation; it only applies if the mutation commits. */
export function collectInvalidation(request: Request, input: SyncInvalidationInput): void {
  const inputs = collected.get(request);
  if (inputs) {
    inputs.push(input);
  } else {
    collected.set(request, [input]);
  }
}

interface UnregisteredRead<RouteContext> {
  id: string;
  scope?: QueryScope | ((context: RouteContext) => QueryScope);
}

type RegisteredRead<Identity, RouteContext> = Identity extends SyncQueryIdentity
  ? { id: Identity["id"] } & (string extends keyof Identity["scope"]
      ? { scope?: Identity["scope"] | ((context: RouteContext) => Identity["scope"]) }
      : { scope: Identity["scope"] | ((context: RouteContext) => Identity["scope"]) })
  : never;

export type SyncReadOption<RouteContext> = string extends SyncQueryIdentity["id"]
  ? UnregisteredRead<RouteContext>
  : RegisteredRead<SyncQueryIdentity, RouteContext>;

export function resolveSyncInvalidations(
  input: SyncInvalidationSelector<Context> | undefined,
  context: Context
): InvalidationInput | undefined {
  const selected = typeof input === "function" ? input(context) : input;
  const rules = [selected ?? [], ...(collected.get(context.request) ?? [])].flat();
  if (rules.length === 0) {
    return;
  }
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
