import type { Context } from "elysia";
import type { AnySchema, SingletonBase, UnwrapSchema } from "elysia/types";
import type { HeadOptions } from "./shared";

export interface HeadContext<
  TParams extends AnySchema | undefined,
  TData extends Record<string, unknown>,
> {
  params: TParams extends AnySchema ? UnwrapSchema<TParams> : Record<string, string>;
  loaderData?: TData;
}

export interface PageRouteSchema<
  TQuery extends AnySchema | undefined,
  TParams extends AnySchema | undefined,
  TBody extends AnySchema | undefined,
> {
  body: UnwrapSchema<TBody>;
  query: UnwrapSchema<TQuery>;
  params: UnwrapSchema<TParams>;
  headers: unknown;
  cookie: unknown;
  response: unknown;
}

export interface LoaderContext<
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TBody extends AnySchema | undefined = undefined,
  TParentData extends Record<string, unknown> = Record<string, never>,
> extends Context<PageRouteSchema<TQuery, TParams, TBody>, SingletonBase> {
  parentData: TParentData;
}

interface PageOptions<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TParentData extends Record<string, unknown> = Record<string, never>,
> {
  params?: TParams extends AnySchema ? UnwrapSchema<TParams> : Record<string, string>;
  query?: TQuery;
  loader?: (ctx: LoaderContext<TQuery, TParams>) => Promise<TData> | TData;
  head?: (ctx: HeadContext<TParams, TData>) => HeadOptions;
  component: React.FC<TData & TParentData>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function page<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TParentData extends Record<string, unknown> = Record<string, never>,
>(props: PageOptions<TData, TQuery, TParams, TParentData>) {
  return {
    __brand: "ELYSION_REACT_PAGE",
    ...props,
  };
}

export type PageModule = typeof page;

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand?: string }).__brand === "ELYSION_REACT_PAGE"
  );
}
