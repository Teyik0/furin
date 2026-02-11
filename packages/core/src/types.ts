import type { Context } from "elysia";
import type { AnySchema, SingletonBase, UnwrapSchema } from "elysia/types";

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

export type LoaderContext<
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TBody extends AnySchema | undefined = undefined,
> = Context<PageRouteSchema<TQuery, TParams, TBody>, SingletonBase>;

interface PageOptions<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TActionBody extends AnySchema | undefined = undefined,
  > {
  params?: TParams extends AnySchema ? UnwrapSchema<TParams> : unknown;
  query?: TQuery;
  loader?: (ctx: LoaderContext<TQuery, TParams>) => Promise<TData> | TData;
  action?: {
    body: TActionBody;
    handler: (ctx: LoaderContext<TQuery, TParams, TActionBody>) => Promise<unknown>;
  };
  component: React.FC<TData>;
  mode?: "ssr";
  revalidate?: 60;
}

export function page<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TActionBody extends AnySchema | undefined = undefined,
>(props: PageOptions<TData, TQuery, TParams, TActionBody>) {
  return {
    __brand: "ELYSION_REACT_PAGE",
    ...props
  };
}

export type PageModule = typeof page;

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" && value !== null && "__brand" in value && (value as { __brand?: string }).__brand === "ELYSION_REACT_PAGE"
  );
}
