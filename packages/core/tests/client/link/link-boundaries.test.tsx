/**
 * Client-side boundary interleaving for SPA navigation.
 *
 * The client builds its tree with the same `resolveRouteElement` as the server,
 * from the route chain it reconstructs and the boundaries the build attached to
 * the route — otherwise a navigation to a page that errors would either fail to
 * catch (missing boundary) or mismatch hydration (different structure). The
 * transport for this is the `segmentBoundaries` field on `ClientRoute`: the build step attaches
 * a statically-imported boundary component list to each route, mirroring the
 * server-side `SegmentBoundary[]` derived from `collectSegmentBoundaries`.
 */
import { describe, expect, test } from "bun:test";
import React, {
  Children,
  createElement,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  type BoundaryOptions,
  FurinErrorBoundary,
  FurinNotFoundBoundary,
} from "../../../src/client/boundaries.tsx";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import type { ClientSegmentBoundary, LoadedClientRoute } from "../../../src/client/link.tsx";
import { resolveRouteElement } from "../../../src/client/route-element.tsx";
import type { ErrorComponent } from "../../../src/shared/error.ts";
import type { NotFoundComponent } from "../../../src/shared/not-found.ts";
import { ROUTE_MATCHES_KEY } from "../../../src/shared/route-matches.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

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

function namedLayout(label: string): NonNullable<RuntimeRoute["layout"]> {
  const L: NonNullable<RuntimeRoute["layout"]> = ({ children }) =>
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
    const marker =
      typeof type === "object" && type !== null
        ? (type as { $$typeof?: symbol }).$$typeof
        : undefined;
    if (
      marker !== Symbol.for("react.provider") &&
      marker !== Symbol.for("react.context") &&
      marker !== Symbol.for("react.consumer")
    ) {
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

function clientTree(
  match: LoadedClientRoute,
  data: { [key: string]: unknown },
  boundaryOptions: BoundaryOptions | undefined
): ReactNode {
  return resolveRouteElement({
    boundaries: match.segmentBoundaries ?? [],
    boundaryOptions,
    chain: collectRouteChainFromRoute(match.pageRoute),
    data,
    page: { component: match.component, pattern: match.pattern },
    reset: () => undefined,
    rootBoundary: undefined,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveRouteElement — client-side boundary interleaving", () => {
  test.each([
    memo(namedLayout("Layout")),
    forwardRef<HTMLDivElement, { children?: ReactNode }>((props, ref) =>
      createElement("div", { ref }, props.children)
    ),
    lazy(async () => ({ default: namedLayout("Layout") })),
  ])("preserves wrapped layouts in the boundary chain (%#)", (layout) => {
    Object.defineProperty(layout, "displayName", { value: "WrappedLayout" });
    const rootRoute = makeRoute({ layout });
    const pageRoute = makeRoute({ parent: rootRoute });
    const element = clientTree(makeMatch(pageRoute, undefined), {}, undefined);

    expect(typeChain(element)).toEqual(["WrappedLayout", "Page"]);
  });

  test("no segmentBoundaries → current behavior preserved (no boundary wrappers)", () => {
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, undefined);

    const element = clientTree(match, {}, undefined);
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

    const element = clientTree(match, {}, undefined);
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

    const element = clientTree(match, {}, undefined);
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

    const element = clientTree(match, {}, undefined);
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

    const element = clientTree(match, {}, undefined);
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

    const element = clientTree(match, {}, undefined);
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
    const element = clientTree(match, {}, { onReset });

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

    const element = clientTree(match, {}, { resetKey: "/blog" });

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

    const element = clientTree(match, {}, undefined);

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

  // ── Failed page match ──────────────────────────────────────────────────────
  //
  // When the payload marks the page segment as failed, the selected error.tsx
  // replaces the subtree of its boundary: it renders inside the layouts above
  // the boundary, without the deeper layouts or the page.

  test("a failed page match renders the selected error.tsx inside the boundary's layout", () => {
    const E: ErrorComponent = () => createElement("p", null, "err");
    Object.defineProperty(E, "name", { value: "E" });
    const rootRoute = makeRoute({ layout: namedLayout("Root") });
    const pageRoute = makeRoute({ layout: namedLayout("L1"), parent: rootRoute });
    const match = makeMatch(pageRoute, [{ depth: 0, error: E }]);

    const element = clientTree(
      match,
      {
        [ROUTE_MATCHES_KEY]: [
          { fields: {}, status: "success" },
          { fields: {}, status: "success" },
          { error: { digest: "abc1234567", message: "Forbidden", status: 403 }, status: "error" },
        ],
      },
      undefined
    );

    expect(typeChain(element)).toEqual(["Root", "E"]);

    // Verify the deepest element is the error.tsx and carries the payload.
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
