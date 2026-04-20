/**
 * FurinErrorBoundary + FurinNotFoundBoundary — React class components that
 * catch errors during render on the CLIENT (after hydration). Used by the
 * client render tree to wrap every layout segment that declared an
 * `error.tsx` or `not-found.tsx`, matching Next.js's nested-boundary model.
 *
 * Design: each boundary is SELECTIVE. FurinErrorBoundary catches generic
 * errors but lets `FurinNotFoundError` bubble past; FurinNotFoundBoundary
 * does the opposite. This lets both kinds of boundary coexist at the same
 * segment — generic errors hit the nearest FurinErrorBoundary, notFound()
 * hits the nearest FurinNotFoundBoundary, independently.
 *
 * Note on testing strategy: React 19's SSR (`renderToReadableStream`) does
 * NOT render error boundary fallbacks — errors inside a `<Suspense>` trigger
 * "switch to client rendering", and errors outside Suspense crash the shell.
 * Server-side error rendering is handled up-front by `buildErrorElement`
 * (slice 2). So these boundaries are tested as what they are: client-side
 * class components. We unit-test lifecycle methods directly and render the
 * fallback branch via `renderToStaticMarkup` after manually injecting state.
 */
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErrorProps } from "../src/error.ts";
import { FurinNotFoundError, type NotFoundProps } from "../src/not-found.ts";
import { FurinErrorBoundary, FurinNotFoundBoundary } from "../src/render/boundaries.tsx";
import { computeErrorDigest } from "../src/render/digest.ts";

const DIGEST_RE = /[0-9a-f]{10}/;
const CUSTOM_FALLBACK_DIGEST_RE = /digest=[0-9a-f]{10}/;

// ── FurinErrorBoundary ────────────────────────────────────────────────────────

describe("FurinErrorBoundary", () => {
  test("renders children verbatim when no error occurs (SSR passthrough)", () => {
    const html = renderToStaticMarkup(
      <FurinErrorBoundary digest="abcdef1234">
        <span>healthy</span>
      </FurinErrorBoundary>
    );
    expect(html).toContain("healthy");
  });

  test("getDerivedStateFromError latches onto generic Error and pre-computes digest", () => {
    const err = new Error("boom");
    const next = FurinErrorBoundary.getDerivedStateFromError(err);
    expect(next).toEqual({ digest: computeErrorDigest(err), error: err });
  });

  test("getDerivedStateFromError latches onto FurinNotFoundError too (re-thrown in render)", () => {
    const err = new FurinNotFoundError({ message: "gone" });
    // The boundary captures it in state, but render() re-throws it so an
    // outer FurinNotFoundBoundary can catch — verified separately below.
    const next = FurinErrorBoundary.getDerivedStateFromError(err);
    expect(next).toEqual({ digest: computeErrorDigest(err), error: err });
  });

  test("renders default fallback with a digest computed from the caught error", () => {
    // Even when a server-provided digest is passed, the boundary now derives
    // the displayed ID from the actual caught error so client-side errors
    // never inherit a stale server ID.
    const err = new Error("boom");
    err.stack = "Error: boom\n  at frozen (/frozen:1:1)";
    // Recompute the same way the boundary does so the assertion stays in sync
    // with `digest.ts` without hardcoding a magic hex string.
    const expected = computeErrorDigest(err);
    const boundary = makeErrorBoundaryInState(err, { digest: "abcdef1234" });
    const html = renderToStaticMarkup(boundary.render() as ReactNode);
    expect(html).toContain(expected);
    expect(html).not.toContain("abcdef1234");
    expect(html).toContain("boom");
    expect(html).toContain("500");
  });

  test("renders a user-supplied fallback with message + computed digest + reset function", () => {
    const Fallback = ({ error, reset }: ErrorProps) => (
      <div>
        <span>msg={error.message}</span>
        <span>digest={error.digest}</span>
        <button disabled={typeof reset !== "function"} type="button">
          retry
        </button>
      </div>
    );
    const boundary = makeErrorBoundaryInState(new Error("custom"), {
      digest: "deadbeef12",
      fallback: Fallback,
    });
    const html = renderToStaticMarkup(boundary.render() as ReactNode);
    expect(html).toContain("msg=custom");
    // Server-provided digest is intentionally NOT used for the caught error.
    expect(html).not.toContain("digest=deadbeef12");
    expect(html).toMatch(CUSTOM_FALLBACK_DIGEST_RE);
    // Reset must be a function even on the server (noop) so the type is stable.
    expect(html).not.toContain("disabled");
  });

  test("computes a digest from the caught error when none is supplied", () => {
    const boundary = makeErrorBoundaryInState(new Error("auto-digest"), {});
    const html = renderToStaticMarkup(boundary.render() as ReactNode);
    expect(html).toMatch(DIGEST_RE);
  });

  test("re-throws FurinNotFoundError from render (lets outer NotFoundBoundary catch)", () => {
    const boundary = makeErrorBoundaryInState(new FurinNotFoundError({ message: "gone" }), {});
    expect(() => boundary.render()).toThrow(FurinNotFoundError);
  });

  test("reset() clears error state and bumps epoch (force-remount of children)", () => {
    const boundary = makeErrorBoundaryInState(new Error("boom"), {});
    const prevEpoch = boundary.state.epoch;
    boundary.reset();
    expect(boundary.state.error).toBeNull();
    expect(boundary.state.epoch).toBe(prevEpoch + 1);
  });

  test("reset() invokes onReset callback", () => {
    let called = 0;
    const boundary = makeErrorBoundaryInState(new Error("boom"), {
      onReset: () => {
        called += 1;
      },
    });
    boundary.reset();
    expect(called).toBe(1);
  });

  // componentDidUpdate — resetKey-driven auto-clear (Slice 7).
  // Direct lifecycle invocation mirrors what React does after a prop-triggered
  // commit: the DOM is not involved, so we stub setState and call the method
  // with the PREVIOUS props to exercise the diff branch.

  test("componentDidUpdate clears latched error when resetKey changes", () => {
    const boundary = makeErrorBoundaryInState(new Error("boom"), { resetKey: "a" });
    expect(boundary.state.error).not.toBeNull();
    // React commits new props onto this.props BEFORE invoking componentDidUpdate,
    // so we simulate that same ordering here. `props` is readonly in the type
    // system but the class mutates its own props at runtime — Object.assign is
    // the idiomatic way to mirror that without fighting TS.
    Object.assign(boundary.props, { resetKey: "b" });
    boundary.componentDidUpdate({ children: null, resetKey: "a" });
    expect(boundary.state.error).toBeNull();
  });

  test("componentDidUpdate calls onReset after clearing via resetKey change", () => {
    let called = 0;
    const boundary = makeErrorBoundaryInState(new Error("boom"), {
      resetKey: 1,
      onReset: () => {
        called += 1;
      },
    });
    Object.assign(boundary.props, { resetKey: 2 });
    boundary.componentDidUpdate({ children: null, resetKey: 1 });
    expect(called).toBe(1);
  });

  test("componentDidUpdate is a no-op when resetKey is unchanged", () => {
    const originalError = new Error("boom");
    const boundary = makeErrorBoundaryInState(originalError, { resetKey: "same" });
    boundary.componentDidUpdate({ children: null, resetKey: "same" });
    expect(boundary.state.error).toBe(originalError);
  });

  test("componentDidUpdate is a no-op when there is no latched error", () => {
    const boundary = new FurinErrorBoundary({ children: null, resetKey: "a" });
    let called = 0;
    boundary.setState = (() => {
      called += 1;
    }) as typeof boundary.setState;
    Object.assign(boundary.props, { resetKey: "b" });
    boundary.componentDidUpdate({ children: null, resetKey: "a" });
    expect(called).toBe(0);
  });
});

// ── FurinNotFoundBoundary ─────────────────────────────────────────────────────

describe("FurinNotFoundBoundary", () => {
  test("renders children verbatim when no error occurs (SSR passthrough)", () => {
    const html = renderToStaticMarkup(
      <FurinNotFoundBoundary>
        <span>visible</span>
      </FurinNotFoundBoundary>
    );
    expect(html).toContain("visible");
  });

  test("getDerivedStateFromError latches onto FurinNotFoundError", () => {
    const err = new FurinNotFoundError({ message: "missing" });
    const next = FurinNotFoundBoundary.getDerivedStateFromError(err);
    expect(next).toEqual({ error: err });
  });

  test("getDerivedStateFromError returns null for generic Error (bubbles past)", () => {
    const err = new Error("plain boom");
    const next = FurinNotFoundBoundary.getDerivedStateFromError(err);
    expect(next).toBeNull();
  });

  test("renders default 404 fallback when caught", () => {
    const boundary = makeNotFoundBoundaryInState(
      new FurinNotFoundError({ message: "missing" }),
      {}
    );
    const html = renderToStaticMarkup(boundary.render() as ReactNode);
    expect(html).toContain("404");
    expect(html).toContain("missing");
  });

  test("passes message + data to a user-supplied fallback", () => {
    const Fallback = ({ error }: NotFoundProps) => (
      <div>
        <span>nf={error.message}</span>
        <span>data={JSON.stringify(error.data)}</span>
      </div>
    );
    const boundary = makeNotFoundBoundaryInState(
      new FurinNotFoundError({ data: { id: 42 }, message: "poof" }),
      { fallback: Fallback }
    );
    const html = renderToStaticMarkup(boundary.render() as ReactNode);
    expect(html).toContain("nf=poof");
    // JSON output is HTML-escaped by renderToStaticMarkup, so match the escaped form.
    expect(html).toContain("&quot;id&quot;:42");
  });

  // componentDidUpdate — resetKey-driven auto-clear (parallel with
  // FurinErrorBoundary; NotFoundBoundary uses inline setState rather than
  // a dedicated reset() method, but observable behaviour is the same).

  test("componentDidUpdate clears latched notFound error when resetKey changes", () => {
    const boundary = makeNotFoundBoundaryInState(new FurinNotFoundError({ message: "gone" }), {
      resetKey: "a",
    });
    expect(boundary.state.error).not.toBeNull();
    Object.assign(boundary.props, { resetKey: "b" });
    boundary.componentDidUpdate({ children: null, resetKey: "a" });
    expect(boundary.state.error).toBeNull();
  });

  test("componentDidUpdate is a no-op when resetKey is unchanged", () => {
    const err = new FurinNotFoundError({ message: "gone" });
    const boundary = makeNotFoundBoundaryInState(err, { resetKey: "same" });
    boundary.componentDidUpdate({ children: null, resetKey: "same" });
    expect(boundary.state.error).toBe(err);
  });

  test("componentDidUpdate is a no-op when there is no latched error", () => {
    const boundary = new FurinNotFoundBoundary({ children: null, resetKey: "a" });
    let called = 0;
    boundary.setState = (() => {
      called += 1;
    }) as typeof boundary.setState;
    Object.assign(boundary.props, { resetKey: "b" });
    boundary.componentDidUpdate({ children: null, resetKey: "a" });
    expect(called).toBe(0);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Constructs a FurinErrorBoundary instance with its error state already
 * latched via `getDerivedStateFromError`, mimicking the state React would
 * set after catching a render-time throw.
 */
function makeErrorBoundaryInState(
  error: Error,
  props: Partial<ConstructorParameters<typeof FurinErrorBoundary>[0]>
): FurinErrorBoundary {
  const fullProps = { children: null, ...props };
  const boundary = new FurinErrorBoundary(fullProps);
  // Bypass React's mounted-instance check: tests exercise lifecycle logic in
  // isolation, so we stub setState to directly mutate state the way React
  // would after a commit. The optional callback (used by reset() to defer
  // onReset until after the commit) is invoked synchronously here — the
  // observable contract is "after state is updated", which holds.
  boundary.setState = ((updater: unknown, callback?: () => void) => {
    const next =
      typeof updater === "function"
        ? (updater as (s: typeof boundary.state) => Partial<typeof boundary.state>)(boundary.state)
        : (updater as Partial<typeof boundary.state>);
    boundary.state = { ...boundary.state, ...next };
    callback?.();
  }) as typeof boundary.setState;
  const derived = FurinErrorBoundary.getDerivedStateFromError(error);
  boundary.state = { ...boundary.state, ...derived } as typeof boundary.state;
  return boundary;
}

function makeNotFoundBoundaryInState(
  error: FurinNotFoundError,
  props: Partial<ConstructorParameters<typeof FurinNotFoundBoundary>[0]>
): FurinNotFoundBoundary {
  const fullProps = { children: null, ...props };
  const boundary = new FurinNotFoundBoundary(fullProps);
  boundary.setState = ((updater: unknown) => {
    const next =
      typeof updater === "function"
        ? (updater as (s: typeof boundary.state) => Partial<typeof boundary.state>)(boundary.state)
        : (updater as Partial<typeof boundary.state>);
    boundary.state = { ...boundary.state, ...next };
  }) as typeof boundary.setState;
  const derived = FurinNotFoundBoundary.getDerivedStateFromError(error);
  if (derived) {
    boundary.state = { ...boundary.state, ...derived } as typeof boundary.state;
  }
  return boundary;
}
