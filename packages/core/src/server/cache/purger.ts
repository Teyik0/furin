export type CachePurger = (keys: string[]) => Promise<void>;

let pathPurger: CachePurger | undefined;
let tagPurger: CachePurger | undefined;

export function setCachePurger(purger: CachePurger): void {
  pathPurger = purger;
}

/** Deployment-only semantic tag hook; the public CDN hook remains path-only. */
export function setCacheTagPurger(purger: CachePurger): void {
  tagPurger = purger;
}

export function callCachePurger(paths: string[]): void {
  dispatch(pathPurger, paths);
}

export function callCacheTagPurger(tags: string[]): void {
  dispatch(tagPurger, tags);
}

export function resetCachePurgers(): void {
  pathPurger = undefined;
  tagPurger = undefined;
}

function dispatch(purger: CachePurger | undefined, keys: string[]): void {
  if (!purger || keys.length === 0) {
    return;
  }
  purger(keys).catch(async (error: unknown) => {
    const { createLogger } = await import("../context-logger.ts");
    const logger = createLogger({});
    logger.set({ furin: { action: "cdn_purge_failed", keys } });
    logger.error(error instanceof Error ? error : new Error(String(error)));
    logger.emit();
  });
}
