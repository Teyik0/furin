import type React from "react";
import type { HeadOptions, RenderingMode } from "../../client.ts";
import type { RequestLoaderContext } from "../../define-route.ts";

export type RuntimeData = Record<string, unknown>;

type Awaitable<T> = Promise<T> | T;

export interface RuntimeParams {
  [key: string]: string;
}

export type RuntimeStaticParams = (
  context: RuntimeData & { params: RuntimeParams }
) => Awaitable<readonly RuntimeParams[]>;

export interface RuntimeRoute {
  __type: "FURIN_ROUTE";
  layout?: React.FC<RuntimeData & { children: React.ReactNode }>;
  loader?: (ctx: RuntimeData) => Awaitable<RuntimeData>;
  mode?: RenderingMode;
  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;
  requestLoader?: (ctx: RequestLoaderContext) => Awaitable<object>;
  revalidate?: number;
  sourcePath?: string;
  staticParams?: RuntimeStaticParams;
  tags?: string[];
}

export interface RuntimePage {
  __type: "FURIN_PAGE";
  _route: RuntimeRoute;
  component: React.FC<RuntimeData>;
  head?: (ctx: RuntimeData) => HeadOptions;
  loader?: (ctx: RuntimeData) => Awaitable<RuntimeData>;
  mode?: RenderingMode;
  revalidate?: number;
  staticParams?: RuntimeStaticParams;
  tags?: string[];
}
