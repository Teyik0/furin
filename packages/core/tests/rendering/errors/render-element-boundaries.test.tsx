/**
 * buildElement interleaves FurinErrorBoundary + FurinNotFoundBoundary into
 * the server-rendered React tree at each segment depth that declared a
 * convention file. The resulting tree matches Next.js's semantics:
 *
 *   <Root>
 *     <FurinErrorBoundary?> <FurinNotFoundBoundary?>   // depth 0 (pagesDir)
 *       <Layout1>
 *         <FurinErrorBoundary?> <FurinNotFoundBoundary?>   // depth 1
 *           <Layout2>
 *             ...
 *               <Page />
 *
 * Boundaries sit INSIDE the layout at their depth (so the layout is preserved
 * when a deeper child throws) and OUTSIDE all deeper content. Directories
 * with no `error.tsx` / `not-found.tsx` are skipped — no wrapper inserted.
 */
import { describe, expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { FurinErrorBoundary, FurinNotFoundBoundary } from "../../../src/client/boundaries.tsx";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { buildElement, buildErrorElement } from "../../../src/server/render/element.tsx";
import type { ResolvedRoute, SegmentBoundary } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import type { ErrorComponent } from "../../../src/shared/error.ts";
import type { NotFoundComponent } from "../../../src/shared/not-found.ts";

// Captured once so the dev-mode toggles in the error-message tests restore cleanly.
const originalDevMode = IS_DEV;

// ── Harness ──────────────────────────────────────────────────────────────────

const Page: RuntimePage["component"] = () => <span data-testid="page">P</span>;
Object.defineProperty(Page, "name", { value: "Page" });

function makeLayout(label: string): RuntimeRoute["layout"] {
  const L: RuntimeRoute["layout"] = ({ children }) => <div data-testid={label}>{children}</div>;
  Object.defineProperty(L, "name", { value: label });
  return L;
}

function makeRouteChain(layoutLabels: (string | null)[]): RuntimeRoute[] {
  // layoutLabels[0] corresponds to routeChain[0] (skipped by buildElement).
  // layoutLabels[i] for i>=1 becomes a RuntimeRoute.layout.
  return layoutLabels.map((label) => ({
    __type: "FURIN_ROUTE",
    layout: label ? makeLayout(label) : undefined,
  }));
}

function makeRoute(overrides: Partial<ResolvedRoute>): ResolvedRoute {
  const defaults: ResolvedRoute = {
    mode: "ssr",
    page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" }, component: Page },
    path: "/virtual/page.tsx",
    pattern: "/",
    routeChain: [{ __type: "FURIN_ROUTE" }],
    segmentBoundaries: [],
  };
  return { ...defaults, ...overrides };
}

function makeRootLayout(label: string | null): RuntimeRoute {
  return { __type: "FURIN_ROUTE", layout: label ? makeLayout(label) : undefined };
}

function firstValidChild(kids: ReactNode): ReactElement | null {
  for (const child of Children.toArray(kids)) {
    if (isValidElement(child)) {
      return child as ReactElement;
    }
  }
  return null;
}

/**
 * Walks the element tree depth-first and collects the sequence of component
 * names encountered along the single-path chain from root to the innermost
 * `Page` component. This lets us assert the wrapping order without coupling
 * to rendered HTML.
 */
function typeChain(node: ReactNode): string[] {
  const chain: string[] = [];
  let current: ReactNode = node;
  while (isValidElement(current)) {
    const { type } = current as ReactElement;
    const name =
      typeof type === "string"
        ? type
        : ((type as { displayName?: string; name?: string }).displayName ??
          (type as { name?: string }).name ??
          "Anonymous");
    // Context providers do not change the layout/boundary component order.
    if (typeof type === "function" || typeof type === "string") {
      chain.push(name);
    }
    const { children } = (current as ReactElement).props as { children?: ReactNode };
    // Walk into the single child (or first if fragment-like), ignoring arrays
    // unless they contain exactly one valid element.
    if (Array.isArray(children)) {
      const onlyValid = children.filter(isValidElement);
      current = onlyValid.length === 1 ? onlyValid[0] : null;
    } else {
      current = firstValidChild(children);
    }
  }
  return chain;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildElement — boundary interleaving", () => {
  test("no segmentBoundaries → tree has no boundary wrappers (current behavior preserved)", () => {
    const route = makeRoute({
      routeChain: makeRouteChain([null, "L1", "L2"]),
      segmentBoundaries: [],
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    expect(chain).not.toContain("FurinErrorBoundary");
    expect(chain).not.toContain("FurinNotFoundBoundary");
    expect(chain).toEqual(["Root", "L1", "L2", "Page"]);
  });

  test("boundary at depth 0 sits inside root layout, wrapping everything below", () => {
    const ErrorFallback: ErrorComponent = () => <p>err</p>;
    const NotFoundFallback: NotFoundComponent = () => <p>404</p>;
    const boundaries: SegmentBoundary[] = [
      { depth: 0, error: ErrorFallback, notFound: NotFoundFallback, path: "/pages" },
    ];
    const route = makeRoute({
      routeChain: makeRouteChain([null, "L1"]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    // Root wraps Err wraps NF wraps L1 wraps Page.
    expect(chain).toEqual(["Root", "FurinErrorBoundary", "FurinNotFoundBoundary", "L1", "Page"]);
  });

  test("boundary at a middle depth sits inside its layout, wrapping deeper content", () => {
    const ErrorFallback: ErrorComponent = () => <p>err</p>;
    const boundaries: SegmentBoundary[] = [
      { depth: 1, error: ErrorFallback, path: "/pages/nested" },
    ];
    const route = makeRoute({
      routeChain: makeRouteChain([null, "L1", "L2"]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    // L1 renders; boundary (error only — no notFound) is inside L1, wrapping L2 and Page.
    expect(chain).toEqual(["Root", "L1", "FurinErrorBoundary", "L2", "Page"]);
  });

  test("multiple segmentBoundaries nest at their respective depths", () => {
    const E: ErrorComponent = () => <p>err</p>;
    const NF: NotFoundComponent = () => <p>404</p>;
    const boundaries: SegmentBoundary[] = [
      { depth: 0, error: E, path: "/pages" },
      { depth: 2, notFound: NF, path: "/pages/a/b" },
    ];
    const route = makeRoute({
      routeChain: makeRouteChain([null, "L1", "L2"]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    expect(chain).toEqual([
      "Root",
      "FurinErrorBoundary", // depth 0 error
      "L1",
      "L2",
      "FurinNotFoundBoundary", // depth 2 not-found
      "Page",
    ]);
  });

  test("boundary with only notFound (no error.tsx) inserts just FurinNotFoundBoundary", () => {
    const NF: NotFoundComponent = () => <p>404</p>;
    const boundaries: SegmentBoundary[] = [{ depth: 0, notFound: NF, path: "/pages" }];
    const route = makeRoute({
      routeChain: makeRouteChain([null, "L1"]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    expect(chain).toEqual(["Root", "FurinNotFoundBoundary", "L1", "Page"]);
  });

  test("FurinErrorBoundary wraps FurinNotFoundBoundary at same depth (not-found must escape error)", () => {
    // Stacking order matters: if a generic error boundary sat INSIDE the
    // not-found boundary, a thrown FurinNotFoundError re-thrown by the inner
    // error boundary (see boundaries.tsx) would have no outer not-found
    // boundary to catch it. So error MUST be the outer wrap.
    const E: ErrorComponent = () => <p>err</p>;
    const NF: NotFoundComponent = () => <p>404</p>;
    const boundaries: SegmentBoundary[] = [{ depth: 0, error: E, notFound: NF, path: "/pages" }];
    const route = makeRoute({
      routeChain: makeRouteChain([null]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));
    const chain = typeChain(element);
    const errIdx = chain.indexOf("FurinErrorBoundary");
    const nfIdx = chain.indexOf("FurinNotFoundBoundary");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(nfIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeLessThan(nfIdx);
  });

  test("passes fallback components into the boundary wrappers as props", () => {
    const E: ErrorComponent = () => <p>err</p>;
    const NF: NotFoundComponent = () => <p>404</p>;
    const boundaries: SegmentBoundary[] = [{ depth: 0, error: E, notFound: NF, path: "/pages" }];
    const route = makeRoute({
      routeChain: makeRouteChain([null]),
      segmentBoundaries: boundaries,
    });
    const element = buildElement(route, {}, makeRootLayout("Root"));

    // Walk to the FurinErrorBoundary and inspect its props.
    let node: ReactNode = element;
    let err: ReactElement | null = null;
    let nf: ReactElement | null = null;
    while (isValidElement(node)) {
      if (node.type === FurinErrorBoundary) {
        err = node;
      } else if (node.type === FurinNotFoundBoundary) {
        nf = node;
      }
      const { children } = node.props as { children?: ReactNode };
      node = firstValidChild(children);
    }
    expect(err?.props).toMatchObject({ fallback: E });
    expect(nf?.props).toMatchObject({ fallback: NF });
  });
});

// ── buildErrorElement — errorMessageOf variants ──────────────────────────────

describe("buildErrorElement — error message extraction", () => {
  test("uses Error.message when error is an Error instance and no override is supplied", () => {
    __setDevMode(true);
    try {
      const E: ErrorComponent = ({ error }) => <span>{error.message}</span>;
      const el = buildErrorElement(
        E,
        new Error("something broke"),
        "d1",
        undefined,
        500
      ) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe("something broke");
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("uses the raw string when error is a plain string", () => {
    __setDevMode(true);
    try {
      const E: ErrorComponent = ({ error }) => <span>{error.message}</span>;
      const el = buildErrorElement(E, "plain string error", "d2", undefined, 500) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe("plain string error");
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("returns empty string when error is neither Error nor string", () => {
    __setDevMode(true);
    try {
      const E: ErrorComponent = ({ error }) => <span>{error.message}</span>;
      const el = buildErrorElement(E, 42, "d3", undefined, 500) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe("");
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("prod: custom error component receives a generic internal error message", () => {
    __setDevMode(false);
    try {
      const E: ErrorComponent = ({ error }) => <span>{error.message}</span>;
      const el = buildErrorElement(
        E,
        new Error("database-password=secret"),
        "d3b",
        undefined,
        500
      ) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe(
        "An unexpected error occurred."
      );
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("prod: generic message when no component provided (no internal leak)", () => {
    __setDevMode(false);
    try {
      const el = buildErrorElement(
        undefined,
        new Error("boom"),
        "d4",
        undefined,
        500
      ) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe(
        "An unexpected error occurred."
      );
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("dev: surfaces the real error message when no component provided", () => {
    __setDevMode(true);
    try {
      const el = buildErrorElement(
        undefined,
        new Error("boom"),
        "d4",
        undefined,
        500
      ) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe("boom");
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("dev: falls back to generic message when the error has no message", () => {
    __setDevMode(true);
    try {
      const el = buildErrorElement(undefined, 42, "d4b", undefined, 500) as ReactElement;
      expect((el.props as { error: { message: string } }).error.message).toBe(
        "An unexpected error occurred."
      );
    } finally {
      __setDevMode(originalDevMode);
    }
  });

  test("messageOverride wins over errorMessageOf — used by the loader pipeline for Response throws", () => {
    const E: ErrorComponent = ({ error }) => <span>{error.message}</span>;
    const el = buildErrorElement(
      E,
      new Error("internal stack info"),
      "d5",
      "Forbidden",
      403
    ) as ReactElement;
    expect((el.props as { error: { message: string } }).error.message).toBe("Forbidden");
  });

  test("status is passed through to the error component", () => {
    const E: ErrorComponent = ({ error }) => <span>{`s=${error.status}`}</span>;
    const el = buildErrorElement(E, new Error("x"), "d6", undefined, 401) as ReactElement;
    expect((el.props as { error: { status: number } }).error.status).toBe(401);
  });
});
