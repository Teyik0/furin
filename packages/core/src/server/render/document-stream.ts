import { createElement, type ReactNode } from "react";
import { FurinDocumentFallback } from "../../client/document.tsx";
import type { RouterContextValue } from "../../client/router/types.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { failRouteMatches } from "../../shared/route-matches.ts";
import type { RootLayout } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import { withDocumentState } from "./document.tsx";
import { buildErrorElement, errorMessageForRender } from "./element.tsx";
import { type PreparedRender, withSSRRouterContext } from "./prepare-render.ts";
import { renderToReadableStream } from "./react-stream.ts";

interface ShellFallbackResult {
  /**
   * Set when the primary element threw synchronously during render and a
   * fallback error UI was streamed instead. Carries the digest so the caller
   * can surface it in logs and the route-match payload.
   */
  shellError: { digest: string; message: string } | undefined;
  stream: Awaited<ReturnType<typeof renderToReadableStream>>;
}

/**
 * A shell failure can come from any segment, so it is reported on the root
 * segment: client and server then both render the root boundary inside the
 * minimal document, without re-rendering layouts that may have thrown.
 */
export function shellErrorPayload(digest: string, message: string): { [key: string]: unknown } {
  return failRouteMatches({}, 0, { error: { digest, message, status: 500 }, status: "error" });
}

export function renderPayload(
  prepared: PreparedRender,
  shellError: { digest: string; message: string } | undefined
): { [key: string]: unknown } {
  return shellError
    ? shellErrorPayload(shellError.digest, shellError.message)
    : { ...prepared.syncData };
}

function hasDocumentMarkers(html: string): boolean {
  return html.includes('data-furin-head=""') && html.includes('data-furin-scripts=""');
}

async function requireDocumentStream(
  stream: Awaited<ReturnType<typeof renderToReadableStream>>
): Promise<Awaited<ReturnType<typeof renderToReadableStream>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  const cancelReader = async (reason: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };
  let prefix = "";
  let done = false;
  while (!(done || hasDocumentMarkers(prefix))) {
    // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be inspected in order.
    const { done: streamDone, value } = await reader.read().catch((error: unknown) => {
      reader.releaseLock();
      throw error;
    });
    done = streamDone;
    if (value !== undefined) {
      buffered.push(value);
      prefix += decoder.decode(value, { stream: !done });
    }
  }
  if (!(prefix.startsWith("<!DOCTYPE html><html") && hasDocumentMarkers(prefix))) {
    await cancelReader(undefined);
    throw new Error(
      "[furin] The root layout must render an <html> document containing <HeadContent /> and <Scripts />."
    );
  }

  const validated = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await cancelReader(reason);
    },
    async pull(controller) {
      const next = await reader.read().catch((error: unknown) => {
        reader.releaseLock();
        throw error;
      });
      if (next.done) {
        reader.releaseLock();
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    start(controller) {
      for (const chunk of buffered) {
        controller.enqueue(chunk);
      }
      if (done) {
        reader.releaseLock();
        controller.close();
      }
    },
  }) as Awaited<ReturnType<typeof renderToReadableStream>>;
  Object.defineProperty(validated, "allReady", { value: stream.allReady });
  return validated;
}

/**
 * Renders `element` to a React stream. Development propagates synchronous shell
 * failures to its diagnostic overlay. Production recovers with a 500 error UI:
 * the supplied error component (route-level, else root-level) is tried first;
 * if it ALSO throws, the built-in error element is used.
 *
 * Shared by SSR (which pipes the stream) and ISR/SSG non-200 (which drains it
 * to a string) — both start from this same React stream and only diverge in how
 * they consume it and which fields they log.
 */
export async function renderElementWithShellFallback(
  element: ReactNode,
  errorComponent: Parameters<typeof buildErrorElement>[0],
  ssrContext: RouterContextValue,
  wrapFallbackDocument: (element: ReactNode, digest: string, message: string) => ReactNode,
  nonce?: string,
  signal?: AbortSignal
): Promise<ShellFallbackResult> {
  const options = { nonce, signal };
  try {
    const stream = await renderToReadableStream(element, options);
    return { shellError: undefined, stream: await requireDocumentStream(stream) };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (IS_DEV) {
      throw error;
    }
    const digest = computeErrorDigest(error);
    try {
      const message = errorMessageForRender(errorComponent, error, undefined);
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(errorComponent, error, digest, message, 500),
            ssrContext
          ),
          digest,
          message
        ),
        options
      );
      return { shellError: { digest, message }, stream: await requireDocumentStream(stream) };
    } catch {
      const message = errorMessageForRender(undefined, error, undefined);
      const stream = await renderToReadableStream(
        wrapFallbackDocument(
          withSSRRouterContext(
            buildErrorElement(undefined, error, digest, message, 500),
            ssrContext
          ),
          digest,
          message
        ),
        options
      );
      return { shellError: { digest, message }, stream: await requireDocumentStream(stream) };
    }
  }
}

export function renderPreparedDocument(
  prepared: PreparedRender,
  root: RootLayout,
  data: object,
  fallbackData: object
): Promise<ShellFallbackResult> {
  const { assets, element, headData } = prepared;
  return renderElementWithShellFallback(
    withDocumentState(element, assets, headData, data),
    root.error,
    prepared.ssrContext,
    (fallback, digest, message) =>
      withDocumentState(createElement(FurinDocumentFallback, null, fallback), assets, headData, {
        ...fallbackData,
        ...shellErrorPayload(digest, message),
      })
  );
}
