/*
  biome-ignore-all lint/complexity/noBannedTypes: The fundamental problem is that
  `Record<string, unknown>` requires an index signature, and any type without one
  (like `{}`, `object`, or a named interface) won't satisfy it. But `{}` is the only type that:
  1. Satisfies `Record<string, unknown>` as a generic default (TS special-cases `{}`)
  2. Doesn't have an index signature (so unknown prop access errors)
  3. Is transparent in intersections(`{} & T = T`)
*/

import type { Cookie, StatusMap } from "elysia";
import type { AnySchema, HTTPHeaders, UnwrapSchema } from "elysia/types";

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

export interface RouteContext<TParams = {}, TQuery = {}> {
  cookie: Record<string, Cookie<unknown>>;
  headers: Record<string, string | undefined>;
  params: TParams;
  path: string;
  query: TQuery;
  redirect: (url: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
  request: Request;
  set: {
    headers: HTTPHeaders;
    status?: number | keyof StatusMap;
  };
}

type ResolveParent<T> =
  T extends RouteRef<infer D, infer P, infer Q>
    ? { data: D; params: P; query: Q }
    : { data: {}; params: Unset; query: Unset };

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
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  meta?: MetaDescriptor[];
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
  component: React.FC<TParentData & TPageLoaderData & RouteContext<TParams, TQuery>>;
  head?: (ctx: RouteContext<TParams, TQuery> & TParentData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & TParentData
  ) => Promise<TPageLoaderData> | TPageLoaderData;
}

export interface RuntimeRoute {
  __type: "ELYSION_ROUTE";
  layout?: React.FC<Record<string, unknown> & { children: React.ReactNode }>;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  mode?: "ssr" | "ssg" | "isr";
  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;
  revalidate?: number;
}

export interface RuntimePage {
  __type: "ELYSION_PAGE";
  _route: RuntimeRoute;
  component: React.FC<Record<string, unknown>>;
  head?(ctx: Record<string, unknown>): HeadOptions;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
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
  _route: Route<TData, TParams, TQuery>;
  component: React.FC<TData & TPageLoaderData & RouteContext<TParams, TQuery>>;
  head?(ctx: RouteContext<TParams, TQuery> & TData & TPageLoaderData): HeadOptions;
  loader?(ctx: RouteContext<TParams, TQuery> & TData): Promise<TPageLoaderData> | TPageLoaderData;
}

export interface Route<TParentData extends Record<string, unknown>, TParams, TQuery> {
  __type: "ELYSION_ROUTE";
  layout?: React.FC<TParentData & { children: React.ReactNode } & RouteContext<TParams, TQuery>>;
  loader?(ctx: RouteContext<TParams, TQuery> & TParentData): Promise<TParentData> | TParentData;
  mode?: "ssr" | "ssg" | "isr";

  page<TPageLoaderData extends Record<string, unknown> = {}>(
    config: PageConfig<TParentData, TParams, TQuery, TPageLoaderData>
  ): PageResult<TParentData, TParams, TQuery, TPageLoaderData>;

  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;

  /** Branded ref for type inference when used as a parent. */
  ref: RouteRef<TParentData, TParams, TQuery>;
  revalidate?: number;
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

export type InferProps<T> = T extends {
  __type: "ELYSION_PAGE";
  component: React.FC<infer P>;
}
  ? P
  : T extends Route<infer D, infer P, infer Q>
    ? D & { children: React.ReactNode } & RouteContext<P, Q>
    : never;
