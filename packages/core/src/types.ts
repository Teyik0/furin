/**
 * Runtime types and utilities for Elysion.
 * Derived from the canonical types in client.ts.
 */
import type { RuntimePage, RuntimeRoute } from "./client";

// ---- Type guards ----

export function isElysionPage(value: unknown): value is RuntimePage {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYSION_PAGE"
  );
}

export function isElysionRoute(value: unknown): value is RuntimeRoute {
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
export function collectRouteChain(page: RuntimePage): RuntimeRoute[] {
  const chain: RuntimeRoute[] = [];
  let current: RuntimeRoute | undefined = page._route;

  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  return chain;
}
