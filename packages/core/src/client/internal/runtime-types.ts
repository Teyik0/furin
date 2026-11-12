import type React from "react";
import type { HeadOptions, RenderingMode } from "../../client.ts";
import type { RequestLoaderContext } from "../../define-route.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import type { RemountDeps } from "../../shared/page-key.ts";

/**
 * Loader data after type erasure: field name → value. Each route declares the
 * real shape through `defineRoute`; the runtime only relies on string keys.
 */
export interface RuntimeData {
  [field: string]: unknown;
}

type Awaitable<T> = Promise<T> | T;

export interface RuntimeParams {
  [key: string]: string;
}

export type RuntimeStaticParams = (
  context: RuntimeData & { params: RuntimeParams }
) => Awaitable<readonly RuntimeParams[]>;

export interface RuntimeRoute {
  __type: "FURIN_ROUTE";
  /** TanStack style: `.error()` of the route. */
  errorComponent?: ErrorComponent;
  layout?: React.FC<RuntimeData & { children: React.ReactNode }>;
  loader?: (ctx: RuntimeData) => Awaitable<RuntimeData>;
  mode?: RenderingMode;
  /** TanStack style: `.notFound()` of the route. */
  notFoundComponent?: NotFoundComponent;
  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;
  remountDeps?: RemountDeps<object, object>;
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
  errorComponent?: ErrorComponent;
  head?: (ctx: RuntimeData) => HeadOptions;
  loader?: (ctx: RuntimeData) => Awaitable<RuntimeData>;
  mode?: RenderingMode;
  notFoundComponent?: NotFoundComponent;
  revalidate?: number;
  staticParams?: RuntimeStaticParams;
  tags?: string[];
}
