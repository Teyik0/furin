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
import { IS_DEV } from "../runtime-env.ts";

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
 * The handler's `invalidate()`: a GET pattern and its params, cache tags or a page path.
 * An interface, unlike `Invalidate<SyncPattern>`, resolves `Register["app"]` lazily: the
 * registered app's own handlers can call it without circularity.
 */
export interface SyncInvalidate {
  <Target extends SyncPattern>(pattern: Target, params?: NoInfer<SyncParams<Target>>): void;
  (rule: InvalidationRule): void;
}

interface CollectedInvalidations {
  queries: QueryIdentity[];
  rules: InvalidationRule[];
}

const collected = new WeakMap<Request, CollectedInvalidations>();
const sealed = new WeakSet<Request>();
const internalReads = new WeakSet<Request>();

export function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** Furin's own sync endpoints are no live queries: their GETs carry no URL identity. */
export function markInternalRead(request: Request): void {
  internalReads.add(request);
}

export function isInternalRead(request: Request): boolean {
  return internalReads.has(request);
}

/** `mutation()` resolved: its transaction already journaled the request's invalidations. */
export function sealInvalidations(request: Request): void {
  sealed.add(request);
}

/** The request's `invalidate()`: its targets only apply once the mutation succeeds or commits. */
export function requestInvalidate(request: Request): SyncInvalidate {
  return ((target: string | InvalidationRule, params?: QueryScope) => {
    if (!isMutationMethod(request.method)) {
      throw new Error(
        `[furin] invalidate() was called while handling a ${request.method}: only a mutation invalidates.`
      );
    }
    if (sealed.has(request)) {
      if (IS_DEV) {
        throw new Error(
          "[furin] invalidate() was called after mutation() resolved: call it inside the mutation() callback to commit it with the transaction."
        );
      }
      return;
    }
    let invalidations = collected.get(request);
    if (!invalidations) {
      invalidations = { queries: [], rules: [] };
      collected.set(request, invalidations);
    }
    if (typeof target !== "string") {
      invalidations.rules.push(target);
      return;
    }
    const identity = { id: target, scope: params ?? {} };
    queryTag(identity);
    invalidations.queries.push(identity);
  }) as SyncInvalidate;
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

/** The handler's `invalidate()` calls, then the GET at the mutation's own URL. */
export function resolveSyncInvalidations(
  context: Parameters<typeof urlIdentity>[0] & Pick<Context, "request">
): InvalidationRule[] {
  const invalidations = collected.get(context.request);
  return [
    ...(invalidations?.rules ?? []),
    { tags: [...(invalidations?.queries ?? []), urlIdentity(context)].map(queryTag) },
  ];
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
  }
}
