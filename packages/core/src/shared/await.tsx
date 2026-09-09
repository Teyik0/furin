import { Component, createContext, createElement, type ReactNode, use, useMemo } from "react";

// ── Async error context ────────────────────────────────────────────────────────

/**
 * Context used to pass the caught error from `AsyncErrorBoundary` down to
 * `errorElement` children so they can read it via `useAsyncError()`.
 */
export const AsyncErrorContext = createContext<unknown>(undefined);

/**
 * Inside an `<Await errorElement={...}>`, returns the error that caused the
 * deferred Promise to reject. Throws outside of an error-boundary subtree.
 */
export function useAsyncError(): unknown {
  return use(AsyncErrorContext);
}

/**
 * Inside a resolved `<Await>`, returns the resolved value via React 19's
 * `use()`. Can be used as an alternative to the render-prop children API.
 *
 * Must be used inside a component that is rendered as children of `<Await>`.
 */
export function useAsyncValue<T>(): T {
  // This hook is intended to be used inside <Await>'s children renderer.
  // The actual value is accessed via the AwaitValueContext.
  const ctx = use(AwaitValueContext) as { promise: Promise<T> } | undefined;
  if (!ctx) {
    throw new Error("useAsyncValue must be used inside <Await> children");
  }
  return use(ctx.promise);
}

const AwaitValueContext = createContext<{ promise: Promise<unknown> } | undefined>(undefined);

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function silenceAbortError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    if (isAbortError(error)) {
      return new Promise<T>(() => {
        /* keep superseded deferred data suspended until React replaces the tree */
      });
    }
    throw error;
  });
}

// ── Error boundary ─────────────────────────────────────────────────────────────

interface AsyncErrorBoundaryProps {
  children?: ReactNode;
  errorElement: ReactNode | undefined;
  resolve: Promise<unknown>;
}

interface AsyncErrorBoundaryState {
  error: unknown;
  hasError: boolean;
  resolve: Promise<unknown> | undefined;
}

/**
 * Class-based error boundary that wraps `<Await>` to catch rejected Promises.
 * When `use(promise)` triggers an unhandled rejection during render, React
 * propagates it to the nearest error boundary — this one catches it and
 * renders the user-provided `errorElement`.
 *
 * NOTE: React error boundaries require `getDerivedStateFromError`, which only
 * exists on class components — this class is intentional and cannot be replaced
 * by a function component.
 */
// biome-ignore lint/style/useReactFunctionComponents: error boundaries require getDerivedStateFromError, which has no function-component equivalent
class AsyncErrorBoundary extends Component<AsyncErrorBoundaryProps, AsyncErrorBoundaryState> {
  constructor(props: AsyncErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined, hasError: false, resolve: props.resolve };
  }

  static getDerivedStateFromProps(
    props: AsyncErrorBoundaryProps,
    state: AsyncErrorBoundaryState
  ): Partial<AsyncErrorBoundaryState> | null {
    if (props.resolve !== state.resolve) {
      return { error: undefined, hasError: false, resolve: props.resolve };
    }
    return null;
  }

  static getDerivedStateFromError(error: unknown): Partial<AsyncErrorBoundaryState> {
    return { error, hasError: true };
  }

  override render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, errorElement } = this.props;

    if (hasError) {
      if (errorElement === undefined) {
        // No errorElement provided — re-throw so the nearest Suspense/parent boundary handles it
        throw error;
      }
      // Provide the error via context so useAsyncError() can access it
      return createElement(AsyncErrorContext.Provider, { value: error }, errorElement);
    }
    return children;
  }
}

// ── <Await> component ──────────────────────────────────────────────────────────

export interface AwaitProps<T> {
  /**
   * Render-prop children: called with the resolved value once the Promise
   * settles. The returned `ReactNode` is rendered inside a Suspense boundary.
   *
   * Marked optional here so `createElement(Await, props, renderFn)` is
   * accepted by TypeScript — the 3rd argument to `createElement` becomes
   * `children` at runtime and is always required for correct behaviour.
   */
  children?: (value: T) => ReactNode;
  /**
   * Rendered when the Promise rejects. Inside this subtree, `useAsyncError()`
   * returns the rejection reason. When omitted the error propagates up to the
   * next React error boundary.
   */
  errorElement?: ReactNode;
  /**
   * The deferred Promise to await. Passed as a prop so React's `use()` can
   * suspend the boundary until it resolves. This is the same Promise object
   * that the loader returned inside `defer()`.
   */
  resolve: Promise<T>;
}

/**
 * Deferred-data boundary component. Uses React 19's `use()` to suspend the
 * render until `resolve` settles, then calls the render-prop `children` with
 * the resolved value.
 *
 * Wrap with `<Suspense fallback={…}>` to show a loading indicator while the
 * Promise is pending.
 *
 * @example
 * ```tsx
 * export const route = defineRoute()
 *   .loader(() => defer({ board: "x", stats: fetchStats() }))
 *   .page(({ data }) => (
 *     <div>
 *       <h1>{data.board}</h1>
 *       <Suspense fallback={<Spinner />}>
 *         <Await resolve={data.stats}>
 *           {(s) => <StatsBar stats={s} />}
 *         </Await>
 *       </Suspense>
 *     </div>
 *   ));
 * ```
 */
export function Await<T>({ resolve, errorElement, children }: AwaitProps<T>): ReactNode {
  const guardedResolve = useMemo(() => silenceAbortError(resolve), [resolve]);

  return createElement(
    AsyncErrorBoundary,
    { errorElement, resolve: guardedResolve as Promise<unknown> },
    // react-doctor-disable-next-line react/no-children-prop
    createElement(AwaitInner<T>, { children, resolve: guardedResolve })
  );
}

interface AwaitInnerProps<T> {
  children?: (value: T) => ReactNode;
  resolve: Promise<T>;
}

/**
 * Inner component that calls `use(resolve)` — this is intentionally a
 * separate component so `AsyncErrorBoundary` above it can catch any errors
 * thrown during the `use()` suspension protocol.
 */
function AwaitInner<T>({ resolve, children }: AwaitInnerProps<T>): ReactNode {
  const value = use(resolve);
  return createElement(
    AwaitValueContext.Provider,
    { value: { promise: resolve as Promise<unknown> } },
    children ? children(value) : null
  );
}
