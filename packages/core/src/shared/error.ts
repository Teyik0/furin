import type { FC } from "react";

export interface ErrorProps {
  error: {
    /** Safe user-facing message. */
    message: string;
    /**
     * Opaque 10-hex-char hash of the original error. The same digest appears
     * in the server logs next to the full stack trace, so support can
     * correlate a user-reported error ID with server-side diagnostics
     * without leaking stack traces to the browser.
     */
    digest: string;
    /**
     * HTTP status associated with the error.
     * - For thrown `Response` objects and Eden problem errors: their HTTP
     *   status (e.g. 401, 403, 404, 500).
     * - For other errors (thrown `Error`, non-Error throws, shell-render
     *   crashes): always `500`.
     *
     * Always present so consumers never need a `?? 500` fallback. Note that
     * `prepared.status` is honoured ONLY for loader-time errors. If a Suspense
     * boundary throws AFTER the SSR shell has flushed (i.e. during streaming),
     * the HTTP status cannot be changed and the user-visible status here may
     * differ from the actual response code.
     */
    status: number;
  };
  /**
   * Clears the nearest FurinErrorBoundary's error state, remounting its
   * children. On the client this re-runs the route's loader; on the server
   * it's a no-op (the request has already produced output by the time
   * `reset` could run).
   */
  reset: () => void;
}

export type ErrorComponent = FC<ErrorProps>;

export function getPublicErrorMessage(error: Error | unknown): string {
  const branded = error as { __furinBrand?: string } | undefined;
  if (
    branded?.__furinBrand === "FURIN_NOT_FOUND" ||
    branded?.__furinBrand === "FURIN_SERVER_ERROR"
  ) {
    return (error as Error).message;
  }
  return "Something went wrong";
}
