type FetchObserver = (args: Parameters<typeof fetch>, response: Response) => void;

interface FetchPatch {
  base: typeof fetch;
  observers: Set<FetchObserver>;
  patched: typeof fetch;
}

const FETCH_PATCH = Symbol.for("furin.router.fetch-patch.v1");
const patchGlobal = globalThis as typeof globalThis & { [FETCH_PATCH]?: FetchPatch };

/**
 * Observes every `window.fetch` response through one shared patch, so several
 * mounted routers (or duplicate module copies) never overwrite or unwrap one
 * another. The original fetch is restored when the last observer leaves, unless
 * someone else replaced `window.fetch` in the meantime.
 */
export function observeWindowFetch(observer: FetchObserver): () => void {
  let patch = patchGlobal[FETCH_PATCH];
  if (!patch) {
    const base = window.fetch;
    const observers = new Set<FetchObserver>();
    const patched = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const response = await base.apply(window, args);
      for (const notify of observers) {
        notify(args, response);
      }
      return response;
    }, base);
    patch = { base, observers, patched };
    patchGlobal[FETCH_PATCH] = patch;
    window.fetch = patched;
  }
  const active = patch;
  active.observers.add(observer);
  return () => {
    active.observers.delete(observer);
    if (active.observers.size > 0 || patchGlobal[FETCH_PATCH] !== active) {
      return;
    }
    patchGlobal[FETCH_PATCH] = undefined;
    if (window.fetch === active.patched) {
      window.fetch = active.base;
    }
  };
}
