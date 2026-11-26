import type { FC } from "react";

export type PendingComponent = FC;

/** When a navigation shows a route's pending screen (TanStack `pendingMs` / `pendingMinMs`). */
export interface PendingOptions {
  /** Minimum time the screen stays once shown, so it never blinks. Default: 500. */
  minMs?: number;
  /** Delay before the screen shows, so fast navigations never flash it. Default: 1000. */
  ms?: number;
}

/** A route's `.pending()` (TanStack style) or a directory's `loading.tsx` (Next.js style). */
export interface RoutePending extends PendingOptions {
  component: PendingComponent;
}
