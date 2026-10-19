import { type FurinInstance, instanceSlot } from "../instance.ts";

export type CachePurger = (keys: string[]) => Promise<void>;

/** Process-wide fallback kept for `setCachePurger()`; `furin({ cachePurger })` wins. */
let pathPurger: CachePurger | undefined;
let tagPurger: CachePurger | undefined;

const instancePathPurger = instanceSlot<{ purger: CachePurger | undefined }>(() => ({
  purger: undefined,
}));
const instanceTagPurger = instanceSlot<{ purger: CachePurger | undefined }>(() => ({
  purger: undefined,
}));

export function setCachePurger(purger: CachePurger): void {
  pathPurger = purger;
}

export function setInstanceCachePurger(
  instance: FurinInstance,
  purger: CachePurger | undefined
): void {
  instancePathPurger(instance).purger = purger;
}

export function setInstanceCacheTagPurger(
  instance: FurinInstance,
  purger: CachePurger | undefined
): void {
  instanceTagPurger(instance).purger = purger;
}

/** Process-wide fallback installed by deployment adapters; `furin({ cacheTagPurger })` wins. */
export function setCacheTagPurger(purger: CachePurger): void {
  tagPurger = purger;
}

/**
 * Purges each runtime's physical paths through its own purger, falling back
 * to the process-wide one. Runtimes sharing a purger get one deduped batch.
 */
export function callCachePurger(purges: ReadonlyMap<FurinInstance, readonly string[]>): void {
  dispatchBatches(
    [...purges].map(([instance, paths]) => [
      instancePathPurger(instance).purger ?? pathPurger,
      paths,
    ])
  );
}

/**
 * Purges `tags` through each runtime's tag purger, falling back to the
 * process-wide one. Runtimes sharing a purger get one deduped batch.
 */
export function callCacheTagPurger(
  instances: readonly FurinInstance[],
  tags: readonly string[]
): void {
  dispatchBatches(
    instances.map((instance) => [instanceTagPurger(instance).purger ?? tagPurger, tags])
  );
}

export function resetCachePurgers(instances: readonly FurinInstance[]): void {
  pathPurger = undefined;
  tagPurger = undefined;
  for (const instance of instances) {
    setInstanceCachePurger(instance, undefined);
    setInstanceCacheTagPurger(instance, undefined);
  }
}

function dispatchBatches(
  purges: readonly (readonly [CachePurger | undefined, readonly string[]])[]
): void {
  const batches = new Map<CachePurger, Set<string>>();
  for (const [purger, keys] of purges) {
    if (!purger) {
      continue;
    }
    const batch = batches.get(purger) ?? new Set<string>();
    for (const key of keys) {
      batch.add(key);
    }
    batches.set(purger, batch);
  }
  for (const [purger, keys] of batches) {
    dispatch(purger, [...keys]);
  }
}

function dispatch(purger: CachePurger | undefined, keys: string[]): void {
  if (!purger || keys.length === 0) {
    return;
  }
  Promise.resolve()
    .then(() => purger(keys))
    .catch(async (error: unknown) => {
      const { createLogger } = await import("../context-logger.ts");
      const logger = createLogger({});
      logger.set({ furin: { action: "cdn_purge_failed", keys } });
      logger.error(error instanceof Error ? error : new Error(String(error)));
      logger.emit();
    });
}
