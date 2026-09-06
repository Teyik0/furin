import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";

/**
 * A single directory-scoped boundary declaration.
 *
 * Each entry represents ONE directory on the path from `pagesDir` to the page
 * file. `error` / `notFound` hold the components defined IN THAT DIRECTORY
 * only — never inherited from a parent. This 1:1 tie between directory and
 * entry is what lets the render layer insert React error boundaries at the
 * exact nesting level where the user authored them (Next.js app-router model).
 */
export interface SegmentBoundary {
  /** 0 = `pagesDir`; increments with each nested subdirectory. */
  depth: number;
  error?: ErrorComponent;
  /**
   * Absolute path to the `error.tsx` module, when present. Carried alongside
   * the component so the client hydrate entry can emit a static `import`
   * statement for each unique convention file — a component reference alone
   * can't survive the server→client boundary.
   */
  errorPath?: string;
  notFound?: NotFoundComponent;
  /** Absolute path to the `not-found.tsx` module, when present. */
  notFoundPath?: string;
  /** Absolute directory path. */
  path: string;
}

export interface ResolvedRoute {
  error?: ErrorComponent;
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  mode: "ssr" | "ssg" | "isr";
  notFound?: NotFoundComponent;
  page: RuntimePage;
  path: string;
  pattern: string;
  routeChain: RuntimeRoute[];
  /**
   * Per-directory boundary chain, ordered shallow → deep. Only directories
   * that DECLARE at least one of `error.tsx` / `not-found.tsx` are included;
   * directories without conventions are skipped. Empty when no conventions
   * exist anywhere in the path.
   */
  segmentBoundaries: SegmentBoundary[];
  ssgHtml?: string;
  tags?: string[];
}

export type ResolvedRoutesSource = ResolvedRoute[] | (() => ResolvedRoute[]);

export interface RootLayout {
  error?: ErrorComponent;
  errorPath?: string;
  notFound?: NotFoundComponent;
  notFoundPath?: string;
  path: string;
  route: RuntimeRoute;
}
