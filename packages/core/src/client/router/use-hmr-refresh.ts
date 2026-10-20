import { useEffect, useRef } from "react";
import { registerHmrRefresh } from "./hmr-refresh.ts";
import type { NavigationController } from "./navigation-controller.ts";

interface HmrTransactionState {
  /** Set while a data refresh is owed, so a later component-only update still refetches. */
  dataInvalidated: boolean;
}

/**
 * Exposes a transactional refresh to the HMR handler in `_hydrate.tsx`. The
 * callback swaps the hot component only after fresh data is ready and just
 * before the controller publishes the complete router snapshot. Production
 * builds define NODE_ENV, so the whole registration is compiled out.
 */
export function useHmrRefresh(controller: NavigationController): void {
  /** Monotonic counter that supersedes only HMR transactions, not user navigation. */
  const hmrVersion = useRef(0);
  const hmrState = useRef<HmrTransactionState>({ dataInvalidated: false });
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      return registerHmrRefresh(async (beforeCommit, dataChanged) => {
        hmrVersion.current += 1;
        const myHmrVersion = hmrVersion.current;
        const shouldRefreshData = hmrState.current.dataInvalidated || dataChanged !== false;
        if (!shouldRefreshData) {
          beforeCommit?.();
          controller.rerender();
          return;
        }
        hmrState.current.dataInvalidated = true;
        await controller.waitForUserNavigation();
        if (hmrVersion.current !== myHmrVersion) {
          return;
        }
        let didCommit = false;
        await controller.refresh({
          beforeCommit: () => {
            didCommit = true;
            beforeCommit?.();
          },
          hmrRefresh: true,
          shouldCommit: () => hmrVersion.current === myHmrVersion,
        });
        if (didCommit && hmrVersion.current === myHmrVersion) {
          hmrState.current.dataInvalidated = false;
        }
      });
    }
  }, [controller]);
}
