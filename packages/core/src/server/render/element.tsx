import type { ReactNode } from "react";
import { DefaultErrorFallback, DefaultNotFoundFallback } from "../../client/default-screens.tsx";
import type { ErrorComponent } from "../../shared/error.ts";
import type { FurinNotFoundError, NotFoundComponent } from "../../shared/not-found.ts";
import { IS_DEV } from "../runtime-env.ts";

export function buildNotFoundElement(
  component: NotFoundComponent | undefined,
  error: FurinNotFoundError
): ReactNode {
  const NotFound = component ?? DefaultNotFoundFallback;
  return <NotFound error={{ data: error.data, message: error.message }} />;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "";
}

export const SERVER_RESET_NOOP = () => {
  /* reset is a client-only action; the response is already committed here */
};

const GENERIC_ERROR_MESSAGE = "An unexpected error occurred.";

export function errorMessageForRender(
  component: ErrorComponent | undefined,
  error: unknown,
  messageOverride: string | undefined
): string {
  if (component && IS_DEV) {
    return messageOverride ?? errorMessageOf(error);
  }
  if (component) {
    return messageOverride ?? GENERIC_ERROR_MESSAGE;
  }
  if (IS_DEV) {
    return (messageOverride ?? errorMessageOf(error)) || GENERIC_ERROR_MESSAGE;
  }
  return GENERIC_ERROR_MESSAGE;
}

/**
 * Builds the error element rendered when a loader (or the SSR shell) fails.
 *
 * @param component - User-declared `error.tsx` component, or `undefined` to
 *   fall back to the built-in `DefaultErrorScreen` with a generic message.
 * @param error - The original thrown value. Kept for `errorMessageOf` lookup
 *   when no explicit `messageOverride` is provided (e.g. shell-render errors).
 * @param digest - 10-hex-char digest correlating with server logs.
 * @param messageOverride - Pre-extracted public message. Set by the loader
 *   pipeline when the thrown value is a `Response` (whose body has already
 *   been consumed in `runLoaders`); pass `undefined` to derive the message
 *   from `error` via `errorMessageOf`.
 * @param status - HTTP status to surface in `ErrorProps.error.status`. The
 *   loader pipeline passes the thrown `Response.status` (default 500); the
 *   shell-error recovery path always passes 500.
 */
export function buildErrorElement(
  component: ErrorComponent | undefined,
  error: unknown,
  digest: string,
  messageOverride: string | undefined,
  status: number
): ReactNode {
  const ErrorView = component ?? DefaultErrorFallback;
  const message = errorMessageForRender(component, error, messageOverride);
  return <ErrorView error={{ digest, message, status }} reset={SERVER_RESET_NOOP} />;
}
