import type { PendingComponent } from "../../shared/pending.ts";
import { collectRouteChainFromRoute } from "../../shared/utils/index.ts";
import type { ClientRoute, LoadedClientRoute } from "./types.ts";

const DEFAULT_PENDING_MS = 1000;
const DEFAULT_PENDING_MIN_MS = 500;

/** A pending screen to render inside the committed layout at `depth`. */
export interface PendingScreen {
  component: PendingComponent;
  depth: number;
  minMs: number;
  ms: number;
}

/**
 * The pending screen a navigation to `href` shows, if any. It renders inside
 * the deepest layout the target shares with the current page, in place of
 * the first segment that changes, as in TanStack Router (only the matches
 * being loaded show their pending) and Next.js (a `loading.tsx` falls back
 * only when its child segment changes). The deepest declaration wins.
 */
export async function resolvePendingScreen(
  routes: readonly ClientRoute[],
  href: string,
  current: LoadedClientRoute | null
): Promise<PendingScreen | undefined> {
  const { pathname } = new URL(href, "http://furin.local");
  const route = routes.find((candidate) => candidate.regex.test(pathname));
  if (!(route && current)) {
    return;
  }
  const loaded = await route.load();
  const target = collectRouteChainFromRoute(loaded.default._route);
  const committed = collectRouteChainFromRoute(current.pageRoute);
  // The last entry of a chain is the page itself, not a layout.
  let shared = 0;
  while (
    shared < target.length - 1 &&
    shared < committed.length - 1 &&
    target[shared]?.layout === committed[shared]?.layout
  ) {
    shared += 1;
  }
  const boundary = (loaded.segmentBoundaries ?? route.segmentBoundaries)?.findLast(
    (candidate) => candidate.pending !== undefined && candidate.depth === shared - 1
  );
  if (!boundary?.pending) {
    return;
  }
  const { component, minMs, ms } = boundary.pending;
  return {
    component,
    depth: boundary.depth,
    minMs: minMs ?? DEFAULT_PENDING_MIN_MS,
    ms: ms ?? DEFAULT_PENDING_MS,
  };
}
