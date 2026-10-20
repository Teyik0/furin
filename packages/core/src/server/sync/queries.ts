import type { Register } from "@teyik0/furin/routes";
import type { Context } from "elysia";
import {
  type QueryIdentity,
  type QueryScope,
  queryFromTag,
  queryTag,
  serializeQueryHeader,
} from "../../shared/sync-query.ts";
import type { InvalidationInput, InvalidationRule } from "../auto-invalidate/types.ts";

/** A method's schema in an Eden route tree; path segments never carry these fields. */
interface RouteSchema {
  body: unknown;
  headers: unknown;
  params: unknown;
  query: unknown;
  response: unknown;
}

/** The GET route patterns of an Eden route tree, eg. `"/boards" | "/boards/:boardId"`. */
export type GetPatterns<Routes, Path extends string> = {
  [Segment in keyof Routes & string]: Segment extends "get"
    ? Path extends ""
      ? "/"
      : Path
    : Routes[Segment] extends RouteSchema
      ? never
      : GetPatterns<Routes[Segment], `${Path}/${Segment}`>;
}[keyof Routes & string];

type ParamName<Param extends string> = Param extends `${infer Name}?` ? Name : Param;
type ParamNames<Pattern extends string> = Pattern extends `${string}:${infer Param}/${infer Rest}`
  ? ParamName<Param> | ParamNames<Rest>
  : Pattern extends `${string}:${infer Param}`
    ? ParamName<Param>
    : never;

/** The registered application's GET patterns; any path until one is registered. */
export type SyncPattern = Register extends { app: { "~Routes": infer Routes } }
  ? GetPatterns<Routes, "">
  : string;

/** A pattern's params; an omitted param matches every value. */
export type SyncParams<Pattern extends string> = string extends Pattern
  ? { readonly [param: string]: string | number }
  : [ParamNames<Pattern>] extends [never]
    ? { readonly [param: string]: never }
    : { readonly [Name in ParamNames<Pattern>]?: string | number };

// The pattern alone selects the route: params must not widen it to another pattern's.
export type Invalidate<Pattern extends string> = <Target extends Pattern>(
  pattern: Target,
  params?: NoInfer<SyncParams<Target>>
) => void;

/**
 * The handler's `invalidate()`. An interface, unlike `Invalidate<SyncPattern>`, resolves
 * `Register["app"]` lazily: the registered app's own handlers can call it without circularity.
 */
export type SyncInvalidate = <Target extends SyncPattern>(
  pattern: Target,
  params?: NoInfer<SyncParams<Target>>
) => void;

const collected = new WeakMap<Request, QueryIdentity[]>();
const internalReads = new WeakSet<Request>();

/** Furin's own sync endpoints are no live queries: their GETs carry no URL identity. */
export function markInternalRead(request: Request): void {
  internalReads.add(request);
}

export function isInternalRead(request: Request): boolean {
  return internalReads.has(request);
}

/** Records a handler invalidation; it only applies if the mutation commits. */
export function collectInvalidation(request: Request, identity: QueryIdentity): void {
  const identities = collected.get(request);
  if (identities) {
    identities.push(identity);
  } else {
    collected.set(request, [identity]);
  }
}

/** The URL identity of the request's own route: its registered pattern and params. */
export function urlIdentity(context: {
  params?: { readonly [name: string]: string | number | undefined };
  path: string;
  route?: string;
}): QueryIdentity {
  const scope: QueryScope = Object.fromEntries(
    Object.entries(context.params ?? {}).filter(([, value]) => value !== undefined)
  );
  return { id: context.route ?? context.path, scope };
}

/** The route's rules, the handler's `invalidate()` calls and the GET at the mutation's own URL. */
export function resolveSyncInvalidations(
  rules: InvalidationInput | undefined,
  context: Context
): InvalidationInput {
  const queries: InvalidationRule = {
    tags: [...(collected.get(context.request) ?? []), urlIdentity(context)].map(queryTag),
  };
  return [rules ?? [], queries].flat();
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
