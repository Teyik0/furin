/**
 * Client-side boundary interleaving for SPA navigation.
 *
 * `buildPageElement` (link.tsx) must produce the same interleaved React tree
 * as the server's `buildElement` (element.tsx) — otherwise a navigation to a
 * page that errors would either fail to catch (missing boundary) or
 * mismatch hydration (different structure). The transport for this is the
 * `segmentBoundaries` field added to `ClientRoute`: the build step attaches
 * a statically-imported boundary component list to each route, mirroring the
 * server-side `SegmentBoundary[]` derived from `collectSegmentBoundaries`.
 */
import { describe, expect, test } from "bun:test";
import React, {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { FurinErrorBoundary, FurinNotFoundBoundary } from "../../../src/client/boundaries.tsx";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import type { ClientSegmentBoundary, LoadedClientRoute } from "../../../src/client/link.tsx";
import { buildPageElement } from "../../../src/client/link.tsx";
import type { ErrorComponent } from "../../../src/shared/error.ts";
import type { NotFoundComponent } from "../../../src/shared/not-found.ts";

// ── Helpers (mirrors render-element-boundaries.test.tsx) ─────────────────────

function firstValidChild(kids: ReactNode): ReactElement | null {
  for (const child of Children.toArray(kids)) {
    if (isValidElement(child)) {
      return child as ReactElement;
    }
  }
  return null;
}

function makeRoute(opts: Partial<Omit<RuntimeRoute, "__type">>): RuntimeRoute {
  return { __type: "FURIN_ROUTE", ...opts };
}

function namedLayout(label: string): RuntimeRoute["layout"] {
  const L: RuntimeRoute["layout"] = ({ children }) =>
    createElement("div", { "data-testid": label }, children);
  Object.defineProperty(L, "name", { value: label });
  return L;
}

const Page: React.FC<Record<string, unknown>> = () => createElement("span", null, "P");
Object.defineProperty(Page, "name", { value: "Page" });

const ROOT_REGEX = /^\/$/;

function makeMatch(
  pageRoute: RuntimeRoute,
  segmentBoundaries: ClientSegmentBoundary[] | undefined
): LoadedClientRoute {
  return {
    component: Page,
    load: () => Promise.resolve({ default: { _route: pageRoute, component: Page } }),
    pageRoute,
    pattern: "/",
    regex: ROOT_REGEX,
    segmentBoundaries,
  };
}

/**
 * Depth-first single-child walk collecting component type names — identical
 * helper to the server-side test so we can assert equivalent tree shape.
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
    const children = (current as ReactElement).props as { children?: ReactNode };
    const kids = children.children;
    if (Array.isArray(kids)) {
      const onlyValid = kids.filter(isValidElement);
      current = onlyValid.length === 1 ? onlyValid[0] : null;
    } else {
      current = firstValidChild(kids);
    }
  }
  return chain;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildPageElement — client-side boundary interleaving", () => {
  test("no segmentBoundaries → current behavior preserved (no boundary wrappers)", () => {
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, undefined);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
    const chain = typeChain(element);
    expect(chain).not.toContain("FurinErrorBoundary");
    expect(chain).not.toContain("FurinNotFoundBoundary");
    expect(chain).toEqual(["Root", "L1", "Page"]);
  });

  test("boundary at depth 0 sits inside root layout (mirrors server buildElement)", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const NF: NotFoundComponent = () => createElement("p", null, "404");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E, notFound: NF }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
    expect(typeChain(element)).toEqual([
      "Root",
      "FurinErrorBoundary",
      "FurinNotFoundBoundary",
      "L1",
      "Page",
    ]);
  });

  test("boundary at middle depth sits inside its layout, wrapping deeper content", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const l1Route = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const pageRoute = makeRoute({ layout: namedLayout("L2"), parent: l1Route });
    const match = makeMatch(pageRoute, [{ depth: 1, error: E }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
    expect(typeChain(element)).toEqual(["Root", "L1", "FurinErrorBoundary", "L2", "Page"]);
  });

  test("multiple segmentBoundaries nest at their respective depths", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const NF: NotFoundComponent = () => createElement("p", null, "404");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const l1Route = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const pageRoute = makeRoute({ layout: namedLayout("L2"), parent: l1Route });
    const match = makeMatch(pageRoute, [
      { depth: 0, error: E },
      { depth: 2, notFound: NF },
    ]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
    expect(typeChain(element)).toEqual([
      "Root",
      "FurinErrorBoundary",
      "L1",
      "L2",
      "FurinNotFoundBoundary",
      "Page",
    ]);
  });

  test("FurinErrorBoundary wraps FurinNotFoundBoundary at same depth (client matches server)", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const NF: NotFoundComponent = () => createElement("p", null, "404");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E, notFound: NF }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
    const chain = typeChain(element);
    const errIdx = chain.indexOf("FurinErrorBoundary");
    const nfIdx = chain.indexOf("FurinNotFoundBoundary");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(nfIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeLessThan(nfIdx);
  });

  test("passes fallback components into the boundary wrappers as props", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const NF: NotFoundComponent = () => createElement("p", null, "404");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E, notFound: NF }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);
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

  // ── Slice 7: onReset + resetKey plumbing ────────────────────────────────────
  //
  // The router injects `onReset` (= refresh() in production) and `resetKey`
  // (= currentHref) at build time. FurinErrorBoundary invokes onReset after
  // clearing its local state; both boundaries clear themselves when resetKey
  // changes. The shape test below asserts props propagation only — behaviour
  // of `reset` / `componentDidUpdate` is covered in render-boundaries.test.tsx.

  test("threads onReset through to each FurinErrorBoundary prop", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E }]);

    const onReset = () => {
      /* test callback */
    };
    const element = buildPageElement(match, rootRoute, {}, { onReset }, undefined);

    let node: ReactNode = element;
    let err: ReactElement | null = null;
    while (isValidElement(node)) {
      if (node.type === FurinErrorBoundary) {
        err = node;
        break;
      }
      const { children } = node.props as { children?: ReactNode };
      node = firstValidChild(children);
    }
    expect(err?.props).toMatchObject({ fallback: E, onReset });
  });

  test("threads resetKey through to both boundary types", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const NF: NotFoundComponent = () => createElement("p", null, "404");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E, notFound: NF }]);

    const element = buildPageElement(match, rootRoute, {}, { resetKey: "/blog" }, undefined);

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
    expect(err?.props).toMatchObject({ resetKey: "/blog" });
    expect(nf?.props).toMatchObject({ resetKey: "/blog" });
  });

  test("omits onReset / resetKey props when options not provided (backward compat)", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, undefined);

    let node: ReactNode = element;
    let err: ReactElement | null = null;
    while (isValidElement(node)) {
      if (node.type === FurinErrorBoundary) {
        err = node;
        break;
      }
      const { children } = node.props as { children?: ReactNode };
      node = firstValidChild(children);
    }
    expect(err).not.toBeNull();
    const props = err?.props as Record<string, unknown>;
    expect(props.onReset).toBeUndefined();
    expect(props.resetKey).toBeUndefined();
  });

  // ── Slice 3 — error injection at page slot ─────────────────────────────────
  //
  // When the SPA-nav payload carried `__furinError`, RouterProvider passes the
  // sentinel as the 5th arg to buildPageElement. The page component is replaced
  // by an internal RouteErrorThrower that throws a FurinServerError during
  // render so the deepest <FurinErrorBoundary> catches it. We verify the tree
  // shape: the layouts and boundaries are still in place; rendering it actually
  // surfaces the user's error.tsx (not the page component).

  test("error sentinel replaces the page slot with the throwing shim, boundaries still wrap", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E }]);

    const element = buildPageElement(match, rootRoute, {}, undefined, {
      digest: "abc1234567",
      message: "Forbidden",
      status: 403,
    });

    // Boundary chain is preserved at depth 0 — when RouteErrorThrower throws
    // during render, the surrounding FurinErrorBoundary catches it.
    expect(typeChain(element)).toEqual(["Root", "FurinErrorBoundary", "L1", "RouteErrorThrower"]);

    // Verify the deepest element is the shim and carries the sentinel payload.
    let node: ReactNode = element;
    let deepest: ReactElement | null = null;
    while (isValidElement(node)) {
      deepest = node;
      const { children } = node.props as { children?: ReactNode };
      const next = firstValidChild(children);
      if (!next) {
        break;
      }
      node = next;
    }
    expect(deepest).not.toBeNull();
    const props = deepest?.props as {
      error?: { digest: string; message: string; status: number };
    };
    expect(props.error).toEqual({ digest: "abc1234567", message: "Forbidden", status: 403 });
  });
});
