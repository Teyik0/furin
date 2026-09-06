// biome-ignore-all lint/performance/noAwaitInLoops: polling helpers intentionally await each retry before the next attempt
import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";

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

/**
 * Maps over `items` with a bounded worker pool, preserving input order.
 * Use whenever an `await Promise.all(items.map(...))` would open as many
 * concurrent async operations as there are items — unbounded fan-out can
 * exhaust file descriptors, sockets, or memory on large inputs.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await fn(items[index] as T, index);
      }
    })
  );
  return results;
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
      `[furin] Page ${location} must inherit from root route. ` +
        "Add the root terminal to defineRoute().config({ layout: rootRoute })."
    );
  }

  for (const route of chain) {
    if (hasCycle(route)) {
      throw new Error("[furin] Cycle detected in route chain. A route cannot be its own ancestor.");
    }
  }
}
