import { type FurinInstance, instanceSlot } from "../instance.ts";

export type CachePurger = (keys: string[]) => Promise<void>;

/** Process-wide fallback kept for `setCachePurger()`; `furin({ cachePurger })` wins. */
let pathPurger: CachePurger | undefined;
let tagPurger: CachePurger | undefined;

const instancePathPurger = instanceSlot<{ purger: CachePurger | undefined }>(() => ({
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

/** Deployment-only semantic tag hook; the public CDN hook remains path-only. */
export function setCacheTagPurger(purger: CachePurger): void {
  tagPurger = purger;
}

/**
 * Purges each runtime's physical paths through its own purger, falling back
 * to the process-wide one. Runtimes sharing a purger get one deduped batch.
 */
export function callCachePurger(purges: ReadonlyMap<FurinInstance, readonly string[]>): void {
  const batches = new Map<CachePurger, Set<string>>();
  for (const [instance, paths] of purges) {
    const purger = instancePathPurger(instance).purger ?? pathPurger;
    if (!purger) {
      continue;
    }
    const batch = batches.get(purger) ?? new Set<string>();
    for (const path of paths) {
      batch.add(path);
    }
    batches.set(purger, batch);
  }
  for (const [purger, paths] of batches) {
    dispatch(purger, [...paths]);
  }
}

export function callCacheTagPurger(tags: string[]): void {
  dispatch(tagPurger, tags);
}

export function resetCachePurgers(instances: readonly FurinInstance[]): void {
  pathPurger = undefined;
  tagPurger = undefined;
  for (const instance of instances) {
    setInstanceCachePurger(instance, undefined);
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
