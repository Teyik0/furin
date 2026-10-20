import { currentInstance, type FurinInstance, instanceSlot } from "../instance.ts";
import type { Cache } from "./route-cache";

export type CacheInvalidator = Pick<Cache<unknown>, "invalidatePath" | "name">;

// One invalidator map per furin instance — each instance owns its SSG/ISR/dev
// caches, so `revalidatePath` never reaches into a sibling app's entries by
// accident (cross-instance invalidation is explicit, see invalidation.ts).
const instanceInvalidators = instanceSlot(() => new Map<string, CacheInvalidator>());

export function registerCacheInvalidator(
  invalidator: CacheInvalidator,
  instance?: FurinInstance
): () => void {
  const invalidators = instanceInvalidators(instance ?? currentInstance());
  const existing = invalidators.get(invalidator.name);
  if (existing !== undefined && existing !== invalidator) {
    throw new Error(
      `Cache invalidator "${invalidator.name}" is already registered for this furin instance with a different invalidator object.`
    );
  }
  invalidators.set(invalidator.name, invalidator);
  return () => {
    if (invalidators.get(invalidator.name) === invalidator) {
      invalidators.delete(invalidator.name);
    }
  };
}

export function getCacheInvalidators(instance?: FurinInstance): IterableIterator<CacheInvalidator> {
  return instanceInvalidators(instance ?? currentInstance()).values();
}
