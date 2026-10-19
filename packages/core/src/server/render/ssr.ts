import type { Context } from "elysia";
import { createElement } from "react";
import { FurinDocumentFallback } from "../../client/document.tsx";
import { isJsonObject } from "../../shared/compact-json.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { getLogger } from "../context-logger.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { useRequestCspNonce } from "../security/csp.ts";
import { withDocumentState } from "./document.tsx";
import {
  renderElementWithShellFallback,
  renderPayload,
  shellErrorPayload,
} from "./document-stream.ts";
import type { LoaderResult } from "./loaders.ts";
import { prepareRender } from "./prepare-render.ts";
import {
  buildSsrTransportScripts,
  pipeDocumentStream,
  writeDeferredSsrChunks,
} from "./ssr-transport.ts";

// Re-export types consumed by sibling render modules (not a public barrel).
export type { LoaderResult } from "./loaders.ts";

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  precomputedLoaderResult: LoaderResult | undefined,
  searchRoutes?: SearchRouteMetadata[]
): Promise<Response> {
  const nonce = useRequestCspNonce(ctx.request);
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    undefined,
    false,
    precomputedLoaderResult,
    searchRoutes
  );

  if (prepared instanceof Response) {
    return prepared;
  }

  getLogger().set({
    furin: {
      loader_ms: prepared.loader_ms,
      render: route.mode,
      route: route.pattern,
      ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
    },
  });

  const { assets, deferredPromises, element, headData, headers } = prepared;

  const initialDataPayload = renderPayload(prepared, undefined);
  const jsonCompatible = deferredPromises === undefined && isJsonObject(initialDataPayload);
  const requiresTransport = !jsonCompatible;
  const renderAbort = new AbortController();
  const abortRequest = () => renderAbort.abort(ctx.request.signal.reason);
  if (ctx.request.signal.aborted) {
    abortRequest();
  } else {
    ctx.request.signal.addEventListener("abort", abortRequest, { once: true });
  }

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    withDocumentState(
      element,
      assets,
      headData,
      requiresTransport ? undefined : initialDataPayload,
      nonce,
      jsonCompatible
    ),
    root.error,
    prepared.ssrContext,
    (fallback, digest, message) =>
      withDocumentState(
        createElement(FurinDocumentFallback, null, fallback),
        assets,
        headData,
        shellErrorPayload(digest, message),
        nonce,
        true
      ),
    nonce,
    renderAbort.signal
  ).catch((error: unknown) => {
    ctx.request.signal.removeEventListener("abort", abortRequest);
    throw error;
  });
  const shellErrored = shellError !== undefined;
  let { errorDigest: finalDigest, status } = prepared;
  if (shellError) {
    status = 500;
    finalDigest = shellError.digest;
    getLogger().set({
      furin: { digest: finalDigest, phase: "shell", render: route.mode, route: route.pattern },
    });
  }

  const dataPayload = renderPayload(prepared, shellError);
  const hasDeferred = !shellErrored && deferredPromises !== undefined;

  const deferredKeys = hasDeferred ? Object.keys(deferredPromises) : [];
  const { deferredSetupScript, runtimeScripts, usesRouteFrames } = buildSsrTransportScripts(
    dataPayload,
    deferredKeys,
    hasDeferred,
    shellErrored,
    nonce,
    jsonCompatible
  );

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let documentFooter = "";
  // biome-ignore lint/correctness/noUndeclaredVariables: HTMLRewriter is a Bun runtime global declared by bun-types.
  const framedDocument = new HTMLRewriter()
    .on("body,html", {
      element(documentElement) {
        documentElement.onEndTag((tag) => {
          documentFooter += `</${tag.name}>`;
          tag.remove();
        });
      },
    })
    .transform(new Response(reactStream));
  const reader = (framedDocument.body as ReadableStream<Uint8Array>).getReader();
  const abortOutput = () => {
    writer.abort(renderAbort.signal.reason).catch(() => undefined);
  };
  renderAbort.signal.addEventListener("abort", abortOutput, { once: true });
  if (renderAbort.signal.aborted) {
    abortOutput();
  }
  writer.closed.catch((error: unknown) => {
    renderAbort.abort(error);
  });

  (async () => {
    try {
      await pipeDocumentStream(
        reader,
        writer,
        enc,
        hasDeferred || usesRouteFrames ? deferredSetupScript + runtimeScripts : "",
        assets.entryModule !== undefined,
        async () => {
          if (!hasDeferred) {
            return;
          }
          await writeDeferredSsrChunks(
            writer,
            enc,
            deferredPromises,
            usesRouteFrames,
            nonce,
            renderAbort.signal
          );
        },
        () => documentFooter
      );
      await writer.close();
    } catch (error) {
      renderAbort.abort(error);
      await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    } finally {
      ctx.request.signal.removeEventListener("abort", abortRequest);
      renderAbort.signal.removeEventListener("abort", abortOutput);
      reader.releaseLock();
    }
  })().catch(() => undefined);

  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(readable, {
    headers: responseHeaders,
    status,
  });
}
