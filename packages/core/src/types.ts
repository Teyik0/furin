/**
 * Server-side runtime types for Elysion.
 * These are the "untyped" runtime shapes consumed by router.ts, render.tsx, build.ts.
 * The strongly-typed client API lives in client/types.ts.
 */

// ---- Runtime interfaces ----

export interface ElysionRouteObject {
  __type: "ELYSION_ROUTE";
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: unknown;
  query?: unknown;
  loader?: (
    ctx: Record<string, unknown>
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  layout?: React.FC<Record<string, unknown> & { children: React.ReactNode }>;
  parent?: ElysionRouteObject;
}

export interface ElysionPageObject {
  __type: "ELYSION_PAGE";
  component: React.FC<Record<string, unknown>>;
  loader?: (
    ctx: Record<string, unknown>
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  head?: (ctx: {
    data: Record<string, unknown>;
    params: Record<string, unknown>;
    query: Record<string, unknown>;
  }) => unknown;
  _route: Omit<ElysionRouteObject, "__type" | "page">;
}

// ---- Type guards ----

export function isElysionPage(value: unknown): value is ElysionPageObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYSION_PAGE"
  );
}

export function isElysionRoute(value: unknown): value is ElysionRouteObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYSION_ROUTE"
  );
}

// ---- Utilities ----

/**
 * Walk up the parent chain from a page's _route and return
 * the ancestor routes in top-down order: [root, ..., leaf].
 */
export function collectRouteChain(page: ElysionPageObject): ElysionRouteObject[] {
  const chain: ElysionRouteObject[] = [];
  let current: ElysionRouteObject | undefined = page._route as ElysionRouteObject | undefined;

  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  return chain;
}
