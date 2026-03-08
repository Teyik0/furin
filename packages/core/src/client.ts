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

type NormalizeUnset<T> = [T] extends [Unset] ? {} : T;

export interface RouteContext<TParams = {}, TQuery = {}> {
  cookie: Record<string, Cookie<unknown>>;
  headers: Record<string, string | undefined>;
  params: NormalizeUnset<TParams>;
  path: string;
  query: NormalizeUnset<TQuery>;
  redirect: (url: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
  request: Request;
  set: {
    headers: HTTPHeaders;
    status?: number | keyof StatusMap;
  };
}

export interface ComponentProps<TParams = {}, TQuery = {}> {
  params: NormalizeUnset<TParams>;
  path: string;
  query: NormalizeUnset<TQuery>;
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

export type LoaderDeps = (route: { __type: string }) => Promise<Record<string, unknown>>;

export interface PageConfig<
  TParentData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends Record<string, unknown> = {},
> {
  component: React.FC<TParentData & TPageLoaderData & ComponentProps<TParams, TQuery>>;
  head?: (ctx: ComponentProps<TParams, TQuery> & TParentData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & TParentData,
    deps: TypedDeps
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  staticParams?: () => Promise<NormalizeUnset<TParams>[]> | NormalizeUnset<TParams>[];
}

export interface RuntimeRoute {
  __type: "ELYRA_ROUTE";
  layout?: React.FC<Record<string, unknown> & { children: React.ReactNode }>;
  loader?(
    ctx: Record<string, unknown>,
    deps: LoaderDeps
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  mode?: "ssr" | "ssg" | "isr";
  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;
  revalidate?: number;
}

export interface RuntimePage {
  __type: "ELYRA_PAGE";
  _route: RuntimeRoute;
  component: React.FC<Record<string, unknown>>;
  head?(ctx: Record<string, unknown>): HeadOptions;
  loader?(
    ctx: Record<string, unknown>,
    deps: LoaderDeps
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  staticParams?(): Promise<Record<string, string>[]> | Record<string, string>[];
}

export interface RouteRef<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TParams = unknown,
  TQuery = unknown,
> {
  readonly __brand: "ELYRA_ROUTE_REF";
  readonly __phantom: { data: TData; params: TParams; query: TQuery };
}

interface PageResult<
  TData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends Record<string, unknown>,
> {
  __type: "ELYRA_PAGE";
  _route: Route<TData, TParams, TQuery>;
  component: React.FC<TData & TPageLoaderData & ComponentProps<TParams, TQuery>>;
  head?: (ctx: ComponentProps<TParams, TQuery> & TData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & TData,
    deps: TypedDeps
  ) => Promise<TPageLoaderData> | TPageLoaderData;
}

export interface Route<TParentData extends Record<string, unknown>, TParams, TQuery> {
  __type: "ELYRA_ROUTE";
  layout?: React.FC<TParentData & { children: React.ReactNode } & ComponentProps<TParams, TQuery>>;
  loader?(
    ctx: RouteContext<TParams, TQuery> & TParentData,
    deps: TypedDeps
  ): Promise<TParentData> | TParentData;
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

// User-facing typed deps: infers the loader data type from the route ref.
type TypedDeps = <TData extends Record<string, unknown>>(
  // biome-ignore lint/suspicious/noExplicitAny: any needed for flexible route type inference
  route: Route<TData, any, any>
) => Promise<TData>;

export function createRoute<
  TParentRef extends RouteRef | undefined = undefined,
  TParamsSchema extends AnySchema | Unset = Unset,
  TQuerySchema extends AnySchema | Unset = Unset,
  TLoaderData extends Record<string, unknown> = {},
>(config?: {
  parent?: { ref: TParentRef } & { __type: "ELYRA_ROUTE" };
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: TParamsSchema;
  query?: TQuerySchema;
  loader?: (
    ctx: RouteContext<
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["params"],
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["query"]
    > &
      ResolveParent<TParentRef>["data"],
    deps: TypedDeps
  ) => Promise<TLoaderData> | TLoaderData;
  layout?: React.FC<
    Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["data"] & {
      children: React.ReactNode;
    } & ComponentProps<
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
    __type: "ELYRA_ROUTE" as const,
    ref: {} as RouteRef<R["data"], R["params"], R["query"]>,

    page<TPageLoaderData extends Record<string, unknown> = {}>(
      pageConfig: PageConfig<R["data"], R["params"], R["query"], TPageLoaderData>
    ) {
      return {
        ...pageConfig,
        __type: "ELYRA_PAGE" as const,
        _route: route,
      };
    },
  };
  return route as Route<R["data"], R["params"], R["query"]>;
}

export type InferProps<T> = T extends {
  __type: "ELYRA_PAGE";
  component: React.FC<infer P>;
}
  ? P
  : T extends Route<infer D, infer P, infer Q>
    ? D & { children: React.ReactNode } & ComponentProps<P, Q>
    : never;
