import type { Context } from "elysia";
import { resume } from "react-dom/server.edge";
import { prerender } from "react-dom/static.edge";
import { computeErrorDigest } from "../../shared/digest.ts";
import { physicalPath } from "../../shared/prefix.ts";
import { parseRouteFrameLines, serializeRouteFrames } from "../../shared/route-frame.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { useLogger } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { withDocumentState } from "./document.tsx";
import { type LoaderResult, runPublicLoaders, withRequestLoaderData } from "./loaders.ts";
import { isPprResumeState, type PprResumeState } from "./ppr-request.ts";
import {
  assertDeferredModeAllowed,
  buildSsrTransportScripts,
  injectAfterEntry,
  prepareRender,
  writeDeferredSsrChunks,
} from "./ssr.ts";

const DOCUMENT_END = "</body></html>";

/** Shell and resume state are one cache value; neither is updated independently. */
export interface PprArtifact {
  cachedAt: number;
  html: string;
  state: PprResumeState;
  tags?: string[];
}

export type PprResult = PprArtifact | Exclude<LoaderResult, { type: "data" }>;

export function isPprArtifact(value: unknown): value is PprArtifact {
  if (!value || typeof value !== "object") {
    return false;
  }
  const artifact = value as { html?: unknown; cachedAt?: unknown; state?: unknown };
  return (
    typeof artifact.html === "string" &&
    typeof artifact.cachedAt === "number" &&
    isPprResumeState(artifact.state)
  );
}

export async function pprPublicResult(
  state: PprResumeState
): Promise<Extract<LoaderResult, { type: "data" }>> {
  const lines = state.data.trimEnd().split("\n");
  const parsed = await parseRouteFrameLines(lines.shift() as string, () =>
    Promise.resolve(lines.shift())
  );
  await parsed.completion;
  return {
    deferredPromises: undefined,
    headers: state.headers,
    syncData: parsed.syncData,
    type: "data",
  };
}

function postponedRequestData(controller: AbortController, reason: Error): Promise<never> {
  const pending = new Promise<never>(() => {
    /* Deliberately unresolved public placeholder. */
  });
  return {
    [Symbol.toStringTag]: "Promise",
    catch: (rejected) => pending.catch(rejected),
    finally: (callback) => pending.finally(callback),
    // biome-ignore lint/suspicious/noThenProperty: React and await must observe this intentionally postponed thenable.
    then: (fulfilled, rejected) => {
      queueMicrotask(() => controller.abort(reason));
      return pending.then(fulfilled, rejected);
    },
  };
}

export async function prerenderPprDocument(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined,
  basePath: string | undefined
): Promise<PprResult> {
  const result = await runPublicLoaders(route, ctx);
  if (result.type !== "data") {
    return result;
  }
  assertDeferredModeAllowed(route, result.deferredPromises);
  const controller = new AbortController();
  const reason = new Error("[furin] PPR requestData must be consumed inside a Suspense boundary.");
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    basePath,
    false,
    {
      ...result,
      deferredPromises: { requestData: postponedRequestData(controller, reason) },
    },
    searchRoutes
  );
  if (prepared instanceof Response) {
    return { response: prepared, type: "redirect" };
  }
  if (prepared.status !== 200) {
    return {
      error: new Error(prepared.errorMessage ?? "PPR render failed"),
      headers: prepared.headers,
      message: "Something went wrong",
      status: prepared.status,
      type: "error",
    };
  }
  let renderError: unknown;
  const output = await prerender(
    withDocumentState(prepared.element, prepared.assets, prepared.headData, undefined),
    {
      onError: (error) => {
        if (error !== reason) {
          renderError = error;
        }
      },
      signal: controller.signal,
    }
  );
  if (renderError !== undefined) {
    throw renderError;
  }
  const html = await new Response(output.prelude).text();
  if (!(html.startsWith("<!DOCTYPE html><html") && html.endsWith(DOCUMENT_END))) {
    throw new Error("[furin] PPR requires a complete root HTML document.");
  }
  const scripts = buildSsrTransportScripts(result.syncData, ["requestData"], true, false);
  const openDocument = html.slice(0, -DOCUMENT_END.length);
  const shell = injectAfterEntry(
    openDocument,
    scripts.runtimeScripts,
    openDocument.length,
    prepared.assets.entryModule !== undefined
  );
  if (shell === undefined) {
    throw new Error("[furin] PPR shell is missing its hydration entry.");
  }
  const url = new URL(ctx.request.url);
  const prefix = basePath ?? currentInstance().prefix;
  url.pathname = physicalPath(prefix, resolvePath(route.pattern, ctx.params ?? {}));
  const data = serializeRouteFrames(result.syncData, []);
  return {
    cachedAt: Date.now(),
    html: shell,
    state: {
      buildId,
      data,
      headers: result.headers,
      path: url.pathname + url.search,
      postponed: output.postponed,
      prefix,
      version: 1,
    },
    tags: route.tags,
  };
}

export async function resumePprDocument(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  artifact: Pick<PprArtifact, "html" | "state">,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<Response> {
  const publicResult = await pprPublicResult(artifact.state);
  const actual = withRequestLoaderData(route, ctx, publicResult);
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    artifact.state.prefix,
    false,
    actual,
    searchRoutes
  );
  if (prepared instanceof Response) {
    return prepared;
  }
  const tree = withDocumentState(prepared.element, prepared.assets, prepared.headData, undefined);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  (async () => {
    await writer.write(encoder.encode(artifact.html));
    if (artifact.state.postponed !== null) {
      const stream = await resume(tree, structuredClone(artifact.state.postponed), {
        onError: (error) => {
          useLogger().error(error instanceof Error ? error : new Error(String(error)));
          return computeErrorDigest(error);
        },
        signal: ctx.request.signal,
      });
      reader = stream.getReader();
      const end = encoder.encode(DOCUMENT_END);
      let tail = new Uint8Array();
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: stream chunks must remain ordered.
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const bytes = new Uint8Array(tail.length + value.length);
        bytes.set(tail);
        bytes.set(value, tail.length);
        const split = Math.max(0, bytes.length - end.length);
        // Hold only the document suffix as bytes, without splitting UTF-16 surrogate pairs.
        await writer.write(bytes.subarray(0, split));
        tail = bytes.slice(split);
      }
      if (tail.length !== end.length || !tail.every((byte, index) => byte === end[index])) {
        await writer.write(tail);
      }
      reader.releaseLock();
      reader = undefined;
    }
    await writeDeferredSsrChunks(writer, encoder, actual.deferredPromises ?? {}, true);
    await writer.write(encoder.encode(DOCUMENT_END));
    await writer.close();
  })().catch((error: unknown) => Promise.allSettled([reader?.cancel(error), writer.abort(error)]));
  return new Response(readable, {
    headers: {
      ...actual.headers,
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
    },
    status: prepared.status,
  });
}
