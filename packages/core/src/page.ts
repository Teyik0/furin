import type { BaseMacro, LocalHook } from "elysia";

export interface LoaderContext {
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface ActionContext<TBody = unknown> {
  params: Record<string, string>;
  query: Record<string, string>;
  body: TBody;
}

// Hooks disponibles pour loader/action (sans body/query/params qui sont au niveau page)
export type PageHooks = Omit<
  // biome-ignore lint/suspicious/noExplicitAny: Elysia types are complex
  LocalHook<any, any, any, any>,
  | "body"
  | "query"
  | "params"
  | "headers"
  | "cookie"
  | "response"
  | "type"
  | "detail"
>;

// Base type for loader without macro
interface LoaderBase<TData = Record<string, unknown>> {
  handler: (ctx: LoaderContext) => Promise<TData> | TData;
}

export type LoaderConfig<
  TData = Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia macro types are complex
  TMacro extends BaseMacro = any,
> = LoaderBase<TData> & PageHooks & TMacro;

// Base type for action without macro
interface ActionBase<TBody = unknown, TResult = Record<string, unknown>> {
  body: unknown;
  handler: (ctx: ActionContext<TBody>) => Promise<TResult> | TResult;
}

export type ActionConfig<
  TBody = unknown,
  TResult = Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia macro types are complex
  TMacro extends BaseMacro = any,
> = ActionBase<TBody, TResult> & PageHooks & TMacro;

export interface PageOptions<
  TLoaderData = Record<string, unknown>,
  TActionBody = unknown,
  TActionResult = Record<string, unknown>,
> {
  // biome-ignore lint/suspicious/noExplicitAny: Elysia schema types are passed through
  query?: any;
  // biome-ignore lint/suspicious/noExplicitAny: Elysia schema types are passed through
  params?: any;
  loader?: LoaderConfig<TLoaderData>;
  action?: ActionConfig<TActionBody, TActionResult>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  head?: () => void;
}

export interface PageModule<TData = Record<string, unknown>> {
  __brand: "elysion-react-page";
  component: React.FC<TData>;
  options?: PageOptions;
}

export function page<
  TData extends Record<string, unknown> = Record<string, unknown>,
>(component: React.FC<TData>, options?: PageOptions<TData>): PageModule<TData> {
  return {
    __brand: "elysion-react-page",
    component,
    options,
  };
}

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand?: string }).__brand === "elysion-react-page"
  );
}
