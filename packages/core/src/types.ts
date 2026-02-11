import type { Context } from "elysia";
import type { AnySchema, SingletonBase, UnwrapSchema } from "elysia/types";

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

export type LoaderContext<
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TBody extends AnySchema | undefined = undefined,
> = Context<PageRouteSchema<TQuery, TParams, TBody>, SingletonBase>;

interface PageOptions<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
> {
  params?: TParams extends AnySchema ? UnwrapSchema<TParams> : Record<string, string>;
  query?: TQuery;
  loader?: (ctx: LoaderContext<TQuery, TParams>) => Promise<TData> | TData;
  head?: (ctx: HeadContext<TParams, TData>) => HeadOptions;
  component: React.FC<TData>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function page<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
>(props: PageOptions<TData, TQuery, TParams>) {
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
