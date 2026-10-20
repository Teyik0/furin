/**
 * Transactional refresh called by the generated `_hydrate.tsx` on HMR:
 * `beforeCommit` swaps the hot component just before fresh data is published.
 */
export type HmrRefresh = (
  beforeCommit: (() => void) | undefined,
  dataChanged: boolean | undefined
) => Promise<void>;

const HMR_REFRESHES = Symbol.for("furin.router.hmr-refreshes.v1");

interface HmrWindow {
  __FURIN_HMR_REFRESH__?: HmrRefresh;
  [HMR_REFRESHES]?: Set<HmrRefresh>;
}

/**
 * Registers one router's HMR refresh. `window.__FURIN_HMR_REFRESH__` fans out
 * to every mounted router, runs `beforeCommit` once (on the first commit), and
 * is removed when the last router unmounts so `_hydrate.tsx` falls back to a
 * full reload.
 */
export function registerHmrRefresh(refresh: HmrRefresh): () => void {
  const hmrWindow = window as Window & HmrWindow;
  let refreshes = hmrWindow[HMR_REFRESHES];
  if (!refreshes) {
    const registered = new Set<HmrRefresh>();
    refreshes = registered;
    hmrWindow[HMR_REFRESHES] = registered;
    hmrWindow.__FURIN_HMR_REFRESH__ = async (beforeCommit, dataChanged) => {
      let committed = false;
      const commitOnce = () => {
        if (!committed) {
          committed = true;
          beforeCommit?.();
        }
      };
      await Promise.all([...registered].map((handler) => handler(commitOnce, dataChanged)));
    };
  }
  const active = refreshes;
  active.add(refresh);
  return () => {
    active.delete(refresh);
    if (active.size === 0 && hmrWindow[HMR_REFRESHES] === active) {
      hmrWindow[HMR_REFRESHES] = undefined;
      hmrWindow.__FURIN_HMR_REFRESH__ = undefined;
    }
  };
}
