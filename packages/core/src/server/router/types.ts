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
  /** Index of the enclosing layout in routeChain; 0 = the root layout. */
  depth: number;
  error?: ErrorComponent;
  /**
   * Absolute path to the `error.tsx` module, when present. Carried alongside
   * the component so the client hydrate entry can emit a static `import`
   * statement for each unique convention file — a component reference alone
   * can't survive the server→client boundary.
   */
  errorPath?: string;
  /**
   * TanStack style: the components are a route's `.error()` / `.notFound()`,
   * read from `errorPath`'s `route` export instead of its default export.
   */
  fromRoute?: true;
  notFound?: NotFoundComponent;
  /** Absolute path to the `not-found.tsx` module, when present. */
  notFoundPath?: string;
  /** Absolute directory path; the route file for a `fromRoute` boundary. */
  path: string;
}

/** A layout wrapping a page, from the route manifest. */
export interface ResolvedLayout {
  path: string;
  pattern: string;
}

export interface ResolvedRoute {
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  /** Layouts wrapping the page, shallow → deep, the root excluded. */
  layouts: ResolvedLayout[];
  mode: "ssr" | "ssg" | "isr";
  page: RuntimePage;
  path: string;
  pattern: string;
  /** Finite private field names inferred from the request loaders in this chain. */
  requestKeys?: string[];
  /** Request field names for each entry in routeChain, in the same order. */
  requestKeysByLoader?: string[][];
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
