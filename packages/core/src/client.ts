/*
  biome-ignore-all lint/complexity/noBannedTypes: The fundamental problem is that
  `Record<string, unknown>` requires an index signature, and any type without one
  (like `{}`, `object`, or a named interface) won't satisfy it. But `{}` is the only type that:
  1. Satisfies `Record<string, unknown>` as a generic default (TS special-cases `{}`)
  2. Doesn't have an index signature (so unknown prop access errors)
  3. Is transparent in intersections(`{} & T = T`)
*/

import type { AnySchema, UnwrapSchema } from "elysia/types";

declare const UNSET: unique symbol;
type Unset = typeof UNSET;

type ResolvedSchema<T> = [T] extends [Unset]
  ? Unset
  : T extends AnySchema
    ? UnwrapSchema<T>
    : Unset;

type MergeSchema<TParent, TOwn> = [TParent] extends [Unset]
  ? TOwn
  : [TOwn] extends [Unset]
    ? TParent
    : TParent & TOwn;

type ConditionalParams<T> = [T] extends [Unset] ? {} : { params: T };
type ConditionalQuery<T> = [T] extends [Unset] ? {} : { query: T };

type RouteContext<TParams, TQuery> = ConditionalParams<TParams> & ConditionalQuery<TQuery>;

type ResolveParent<T> =
  T extends RouteRef<infer D, infer P, infer Q>
    ? { data: D; params: P; query: Q }
    : { data: {}; params: Unset; query: Unset };

/** Fully resolved data/params/query for a route given its parent ref and own schemas. */
interface Resolved<TParentRef, TLoaderData, TParamsSchema = Unset, TQuerySchema = Unset> {
  data: ResolveParent<TParentRef>["data"] & TLoaderData;
  params: MergeSchema<ResolveParent<TParentRef>["params"], ResolvedSchema<TParamsSchema>>;
  query: MergeSchema<ResolveParent<TParentRef>["query"], ResolvedSchema<TQuerySchema>>;
}

export type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": object }
  | { tagName: "meta" | "link"; [name: string]: string | undefined };

export interface HeadOptions {
  meta?: MetaDescriptor[];
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  scripts?: Array<{
    src?: string;
    type?: string;
    children?: string;
    [key: string]: string | undefined;
  }>;
  styles?: Array<{ type?: string; children: string }>;
}

export interface PageConfig<
  TParentData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends Record<string, unknown> = {},
> {
  head?: (ctx: RouteContext<TParams, TQuery> & TParentData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & TParentData
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  component: React.FC<TParentData & TPageLoaderData & RouteContext<TParams, TQuery>>;
}

export interface RuntimeRoute {
  __type: "ELYSION_ROUTE";
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: unknown;
  query?: unknown;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  layout?: React.FC<Record<string, unknown> & { children: React.ReactNode }>;
  parent?: RuntimeRoute;
}

export interface RuntimePage {
  __type: "ELYSION_PAGE";
  component: React.FC<Record<string, unknown>>;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  head?(ctx: Record<string, unknown>): HeadOptions;
  _route: RuntimeRoute;
}

export interface RouteRef<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TParams = unknown,
  TQuery = unknown,
> {
  readonly __brand: "ELYSION_ROUTE_REF";
  readonly __phantom: { data: TData; params: TParams; query: TQuery };
}

interface PageResult<
  TData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends Record<string, unknown>,
> {
  __type: "ELYSION_PAGE";
  component: React.FC<TData & TPageLoaderData & RouteContext<TParams, TQuery>>;
  loader?(ctx: RouteContext<TParams, TQuery> & TData): Promise<TPageLoaderData> | TPageLoaderData;
  head?(ctx: RouteContext<TParams, TQuery> & TData & TPageLoaderData): HeadOptions;
  _route: Route<TData, TParams, TQuery>;
}

export interface Route<TParentData extends Record<string, unknown>, TParams, TQuery> {
  __type: "ELYSION_ROUTE";
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;

  params?: unknown;
  query?: unknown;
  loader?(ctx: RouteContext<TParams, TQuery> & TParentData): Promise<TParentData> | TParentData;
  layout?: React.FC<TParentData & { children: React.ReactNode } & RouteContext<TParams, TQuery>>;
  parent?: RuntimeRoute;

  /** Branded ref for type inference when used as a parent. */
  ref: RouteRef<TParentData, TParams, TQuery>;

  page<TPageLoaderData extends Record<string, unknown> = {}>(
    config: PageConfig<TParentData, TParams, TQuery, TPageLoaderData>
  ): PageResult<TParentData, TParams, TQuery, TPageLoaderData>;
}

export function createRoute<
  TParentRef extends RouteRef | undefined = undefined,
  TParamsSchema extends AnySchema | Unset = Unset,
  TQuerySchema extends AnySchema | Unset = Unset,
  TLoaderData extends Record<string, unknown> = {},
>(config?: {
  parent?: { ref: TParentRef } & { __type: "ELYSION_ROUTE" };
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: TParamsSchema;
  query?: TQuerySchema;
  loader?: (
    ctx: RouteContext<
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["params"],
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["query"]
    > &
      ResolveParent<TParentRef>["data"]
  ) => Promise<TLoaderData> | TLoaderData;
  layout?: React.FC<
    Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["data"] & {
      children: React.ReactNode;
    } & RouteContext<
        Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["params"],
        Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["query"]
      >
  >;
}): Route<
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["data"],
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["params"],
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["query"]
> {
  type R = Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>;

  const route = {
    ...config,
    __type: "ELYSION_ROUTE" as const,
    ref: {} as RouteRef<R["data"], R["params"], R["query"]>,

    page<TPageLoaderData extends Record<string, unknown> = {}>(
      pageConfig: PageConfig<R["data"], R["params"], R["query"], TPageLoaderData>
    ) {
      return {
        ...pageConfig,
        __type: "ELYSION_PAGE" as const,
        _route: route,
      };
    },
  };
  return route as Route<R["data"], R["params"], R["query"]>;
}

export type InferProps<T> = T extends { __type: "ELYSION_PAGE"; _route: infer TRoute }
  ? TRoute extends Route<infer D, infer P, infer Q>
    ? D & RouteContext<P, Q>
    : never
  : T extends Route<infer D, infer P, infer Q>
    ? D & { children: React.ReactNode } & RouteContext<P, Q>
    : never;
