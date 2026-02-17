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
  head?: (
    ctx: ConditionalParams<TParams> & ConditionalQuery<TQuery> & TParentData & TPageLoaderData
  ) => HeadOptions;
  loader?: (
    ctx: ConditionalParams<TParams> & ConditionalQuery<TQuery> & TParentData
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  component: React.FC<
    TParentData & TPageLoaderData & ConditionalParams<TParams> & ConditionalQuery<TQuery>
  >;
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
  TParams = any,
  TQuery = any,
> {
  readonly __brand: "ELYSION_ROUTE_REF";
  readonly __phantom: {
    data: TData;
    params: TParams;
    query: TQuery;
  };
}

export interface Route<TParentData extends Record<string, unknown>, TParams, TQuery> {
  __type: "ELYSION_ROUTE";
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: unknown;
  query?: unknown;
  loader?(
    ctx: ConditionalParams<TParams> & ConditionalQuery<TQuery> & TParentData
  ): Promise<TParentData> | TParentData;
  layout?: React.FC<
    TParentData & { children: React.ReactNode } & ConditionalParams<TParams> &
      ConditionalQuery<TQuery>
  >;
  parent?: RuntimeRoute;

  /** Branded ref for type inference when used as a parent. */
  ref: RouteRef<TParentData, TParams, TQuery>;

  page<TPageLoaderData extends Record<string, unknown> = {}>(
    config: PageConfig<TParentData, TParams, TQuery, TPageLoaderData>
  ): {
    __type: "ELYSION_PAGE";
    component: React.FC<
      TParentData & TPageLoaderData & ConditionalParams<TParams> & ConditionalQuery<TQuery>
    >;
    loader?(
      ctx: ConditionalParams<TParams> & ConditionalQuery<TQuery> & TParentData
    ): Promise<TPageLoaderData> | TPageLoaderData;
    head?(
      ctx: ConditionalParams<TParams> & ConditionalQuery<TQuery> & TParentData & TPageLoaderData
    ): HeadOptions;
    _route: Route<TParentData, TParams, TQuery>;
  };
}

type ResolveParentData<T> =
  T extends RouteRef<infer TData, infer _TParams, infer _TQuery> ? TData : {};

type ResolveParentParams<T> =
  T extends RouteRef<infer _TData, infer TParams, infer _TQuery> ? TParams : Unset;

type ResolveParentQuery<T> =
  T extends RouteRef<infer _TData, infer _TParams, infer TQuery> ? TQuery : Unset;

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
    ctx: ConditionalParams<
      MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>
    > &
      ConditionalQuery<MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>> &
      ResolveParentData<TParentRef>
  ) => Promise<TLoaderData> | TLoaderData;
  layout?: React.FC<
    ResolveParentData<TParentRef> &
      TLoaderData & {
        children: React.ReactNode;
      } & ConditionalParams<
        MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>
      > &
      ConditionalQuery<MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>>
  >;
}): Route<
  ResolveParentData<TParentRef> & TLoaderData,
  MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>,
  MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>
> {
  const route = {
    ...config,
    __type: "ELYSION_ROUTE" as const,
    ref: {} as RouteRef<
      ResolveParentData<TParentRef> & TLoaderData,
      MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>,
      MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>
    >,

    page<TPageLoaderData extends Record<string, unknown> = {}>(
      pageConfig: PageConfig<
        ResolveParentData<TParentRef> & TLoaderData,
        MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>,
        MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>,
        TPageLoaderData
      >
    ) {
      return {
        ...pageConfig,
        __type: "ELYSION_PAGE" as const,
        _route: route,
      };
    },
  };
  return route as Route<
    ResolveParentData<TParentRef> & TLoaderData,
    MergeSchema<ResolveParentParams<TParentRef>, ResolvedSchema<TParamsSchema>>,
    MergeSchema<ResolveParentQuery<TParentRef>, ResolvedSchema<TQuerySchema>>
  >;
}

export type InferProps<T> = T extends { __type: "ELYSION_PAGE"; _route: infer TRoute }
  ? TRoute extends Route<infer D, infer P, infer Q>
    ? D & ConditionalParams<P> & ConditionalQuery<Q>
    : never
  : T extends Route<infer D, infer P, infer Q>
    ? D & { children: React.ReactNode } & ConditionalParams<P> & ConditionalQuery<Q>
    : never;
