import type { BaseMacro, Context, LocalHook } from "elysia";
import type { AnySchema } from "elysia/types";

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
  "body" | "query" | "params" | "headers" | "cookie" | "response" | "type" | "detail"
>;

interface LoaderBase<TData> {
  handler: (ctx: Context) => Promise<TData> | TData;
}

export type LoaderConfig<
  TData = Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia macro types are complex
  TMacro extends BaseMacro = any,
> = LoaderBase<TData> & PageHooks & TMacro;

// Base type for action
interface ActionBase<TData> {
  body: unknown;
  handler: (ctx: Context) => Promise<TData> | TData;
}

export type ActionConfig<
  TData = Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia macro types are complex
  TMacro extends BaseMacro = any,
> = ActionBase<TData> & PageHooks & TMacro;

export interface PageOptions<TLoaderData = Record<string, unknown>, TActionBody = unknown> {
  query?: AnySchema;
  params?: AnySchema;
  loader?: LoaderConfig<TLoaderData>;
  action?: ActionConfig<TActionBody>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  head?: () => void;
}

export interface PageModule<TData = Record<string, unknown>> {
  __brand: "elysion-react-page";
  component: React.FC<TData>;
  options?: PageOptions;
}

export function page<TData extends Record<string, unknown> = Record<string, unknown>>(
  component: React.FC<TData>,
  options?: PageOptions<TData>
): PageModule<TData> {
  return {
    __brand: "elysion-react-page",
    component,
    options,
  };
}

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" && value !== null && "__brand" in value && (value as { __brand?: string }).__brand === "elysion-react-page"
  );
}

export function isLoaderConfig<TData = Record<string, unknown>>(value: unknown): value is LoaderConfig<TData> {
  return (
    typeof value === "object" && value !== null && "handler" in value && typeof (value as { handler?: unknown }).handler === "function"
  );
}

export function isActionConfig<TBody = unknown, TResult = Record<string, unknown>>(value: unknown): value is ActionConfig<TBody, TResult> {
  return (
    typeof value === "object" &&
    value !== null &&
    "handler" in value &&
    "body" in value &&
    typeof (value as { handler?: unknown }).handler === "function"
  );
}
