import type { RuntimePage, RuntimeRoute } from "./client";

export function isElyraPage(value: unknown): value is RuntimePage {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYRA_PAGE"
  );
}

export function isElyraRoute(value: unknown): value is RuntimeRoute {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYRA_ROUTE"
  );
}

export function collectRouteChainFromRoute(route: RuntimeRoute): RuntimeRoute[] {
  const chain: RuntimeRoute[] = [];
  let current: RuntimeRoute | undefined = route;

  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  return chain;
}

export function hasCycle(route: RuntimeRoute): boolean {
  const visited = new Set<RuntimeRoute>();
  let current: RuntimeRoute | undefined = route;

  while (current) {
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    current = current.parent;
  }

  return false;
}

export function validateRouteChain(
  chain: RuntimeRoute[],
  root: RuntimeRoute,
  pagePath?: string
): void {
  const hasRoot = chain.some((r) => r === root);

  if (!hasRoot) {
    const location = pagePath ? `in ${pagePath}` : "";
    throw new Error(
      `[elyra] Page ${location} must inherit from root route. ` +
        'Add: import { route } from "./root"; and use route.page() or set parent: route'
    );
  }

  for (const route of chain) {
    if (hasCycle(route)) {
      throw new Error("[elyra] Cycle detected in route chain. A route cannot be its own ancestor.");
    }
  }
}
