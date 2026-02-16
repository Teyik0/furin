import type { AnySchema, UnwrapSchema } from "elysia/types";

type MetaDescriptor =
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
  TParentData extends Record<string, unknown> | undefined,
  TParams extends UnwrapSchema<AnySchema> | undefined,
  TQuery extends UnwrapSchema<AnySchema> | undefined,
  TPageLoaderData extends Record<string, unknown> | undefined,
> {
  head?: (ctx: { params: TParams; query: TQuery } & TParentData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: {
      params: TParams;
      query: TQuery;
    } & TParentData
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  component: React.FC<TParentData & TPageLoaderData & { params: TParams; query: TQuery }>;
}

export interface Route<
  TParentData extends Record<string, unknown> | undefined,
  TParams extends UnwrapSchema<AnySchema> | undefined,
  TQuery extends UnwrapSchema<AnySchema> | undefined,
> {
  __type: "ELYSION_ROUTE";

  page<TPageLoaderData extends Record<string, unknown> | undefined>(
    config: PageConfig<TParentData, TParams, TQuery, TPageLoaderData>
  ): {
    __type: "ELYSION_PAGE";
    _route: Route<TParentData, TParams, TQuery>;
  };
}

type AnyRoute = Route<
  Record<string, unknown> | undefined,
  UnwrapSchema<AnySchema> | undefined,
  UnwrapSchema<AnySchema> | undefined
>;

type ResolveParentData<T> =
  T extends Route<infer TData, infer _TParams, infer _TQuery> ? TData : undefined;

type ResolveParentParams<T> =
  T extends Route<infer _TData, infer TParams, infer _TQuery> ? TParams : undefined;

type ResolveParentQuery<T> =
  T extends Route<infer _TData, infer _TParams, infer TQuery> ? TQuery : undefined;

export function createRoute<
  TParent extends AnyRoute | undefined,
  TParamsSchema extends AnySchema | undefined,
  TQuerySchema extends AnySchema | undefined,
  TLoaderData extends Record<string, unknown>,
>(config?: {
  parent?: TParent;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: TParamsSchema;
  query?: TQuerySchema;
  loader?: (
    ctx: {
      params: ResolveParentParams<TParent> & UnwrapSchema<TParamsSchema>;
      query: ResolveParentQuery<TParent> & UnwrapSchema<TQuerySchema>;
    } & ResolveParentData<TParent>
  ) => Promise<TLoaderData> | TLoaderData;
  layout?: React.FC<
    ResolveParentData<TParent> &
      TLoaderData & {
        children: React.ReactNode;
        params: ResolveParentParams<TParent> & UnwrapSchema<TParamsSchema>;
        query: ResolveParentQuery<TParent> & UnwrapSchema<TQuerySchema>;
      }
  >;
}): Route<
  ResolveParentData<TParent> & TLoaderData,
  ResolveParentParams<TParent> & UnwrapSchema<TParamsSchema>,
  ResolveParentQuery<TParent> & UnwrapSchema<TQuerySchema>
> {
  const route = {
    ...config,
    __type: "ELYSION_ROUTE" as const,

    page<TPageLoaderData extends Record<string, unknown> | undefined>(
      pageConfig: PageConfig<
        ResolveParentData<TParent> & TLoaderData,
        ResolveParentParams<TParent> & UnwrapSchema<TParamsSchema>,
        ResolveParentQuery<TParent> & UnwrapSchema<TQuerySchema>,
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
  return route;
}

export type InferProps<T> = T extends { __type: "ELYSION_PAGE"; _route: infer TRoute }
  ? TRoute extends Route<infer D, infer P, infer Q>
    ? D & { params: P; query: Q } // Page, no children props
    : never
  : T extends Route<infer D, infer P, infer Q>
    ? D & { children: React.ReactNode; params: P; query: Q } // Layout, children needed
    : never;
