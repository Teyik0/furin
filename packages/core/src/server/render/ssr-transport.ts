import { toCrossJSON } from "seroval";
import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { isJsonObject } from "../../shared/compact-json.ts";
import { serializeRouteFrames } from "../../shared/route-frame.ts";
import {
  buildDeferredResolution,
  buildDeferredScript,
  buildRouteFrameCloseScript,
  buildRouteFramePushScript,
  buildRouteFrameStreamScript,
  buildRouteFrameTemplate,
} from "./assemble.ts";
import { serializeDeferredRejection } from "./loader-errors.ts";
import { serializeDeferredRouteFrame } from "./route-frame-transport.ts";
import { safeJson } from "./shell.ts";

interface SsrTransportScripts {
  deferredSetupScript: string;
  runtimeScripts: string;
  usesRouteFrames: boolean;
}

export function injectAfterEntry(
  html: string,
  injection: string,
  fallbackIndex: number,
  hasEntryModule: boolean
): string | undefined {
  const entryMarkerIndex = html.indexOf('data-furin-entry=""');
  if (entryMarkerIndex === -1) {
    if (hasEntryModule) {
      return;
    }
    return html.slice(0, fallbackIndex) + injection + html.slice(fallbackIndex);
  }
  const entryEndIndex = html.indexOf("</script>", entryMarkerIndex);
  if (entryEndIndex === -1) {
    return;
  }
  const insertionIndex = entryEndIndex + "</script>".length;
  return html.slice(0, insertionIndex) + injection + html.slice(insertionIndex);
}

function scriptsMarkerEnd(html: string): number | undefined {
  const markerIndex = html.indexOf('data-furin-scripts=""');
  if (markerIndex === -1) {
    return;
  }
  const closeIndex = html.indexOf("</script>", markerIndex);
  return closeIndex === -1 ? undefined : closeIndex + "</script>".length;
}

export async function pipeDocumentStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  beforeEntry: string,
  hasEntryModule: boolean,
  beforeBodyClose: () => Promise<void>,
  documentFooter: () => string
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let entryHandled = false;
  let deferredWrites: Promise<void> | undefined;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: ReadableStream chunks must be consumed in order.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    if (entryHandled) {
      await writer.write(enc.encode(chunk));
      continue;
    }

    pending += chunk;
    const scriptsEndIndex = scriptsMarkerEnd(pending);
    if (scriptsEndIndex !== undefined) {
      const entryMarker = pending.indexOf('data-furin-entry=""');
      const entryEnd = entryMarker === -1 ? -1 : pending.indexOf("</script>", entryMarker);
      const shellEnd = entryEnd === -1 ? scriptsEndIndex : entryEnd + "</script>".length;
      const shell = injectAfterEntry(
        pending.slice(0, shellEnd),
        beforeEntry,
        shellEnd,
        hasEntryModule
      );
      if (shell === undefined) {
        continue;
      }
      await writer.write(enc.encode(shell));
      const tail = pending.slice(shellEnd);
      pending = "";
      entryHandled = true;
      deferredWrites = beforeBodyClose();
      deferredWrites.catch(() => undefined);
      await writer.write(enc.encode(tail));
    }
  }
  const finalChunk = decoder.decode();
  if (!entryHandled) {
    await writer.write(enc.encode(pending + finalChunk + beforeEntry));
    await beforeBodyClose();
    await writer.write(enc.encode(documentFooter()));
    return;
  }

  if (finalChunk.length > 0) {
    await writer.write(enc.encode(finalChunk));
  }
  await deferredWrites;
  await writer.write(enc.encode(documentFooter()));
}

export function buildSsrTransportScripts(
  dataPayload: RuntimeData,
  deferredKeys: string[],
  hasDeferred: boolean,
  shellErrored: boolean,
  nonce?: string,
  jsonCompatible?: boolean
): SsrTransportScripts {
  const usesRouteFrames =
    !shellErrored && (hasDeferred || !(jsonCompatible ?? isJsonObject(dataPayload)));
  const deferredSetupScript =
    hasDeferred && !usesRouteFrames ? buildDeferredScript(deferredKeys, nonce) : "";
  const dataScript = usesRouteFrames
    ? buildRouteFrameTemplate(
        serializeRouteFrames(dataPayload, hasDeferred ? deferredKeys : undefined)
      )
    : `<script id="__FURIN_DATA__" type="application/json">${safeJson(dataPayload)}</script>`;
  const routeFrameStreamScript =
    hasDeferred && usesRouteFrames ? buildRouteFrameStreamScript(nonce) : "";

  return {
    deferredSetupScript,
    runtimeScripts: `${routeFrameStreamScript}${dataScript}`,
    usesRouteFrames,
  };
}

async function writeDeferredSsrChunk(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  key: string,
  promise: Promise<unknown>,
  index: number,
  usesRouteFrames: boolean,
  nonce?: string
): Promise<void> {
  if (usesRouteFrames) {
    const frames = await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
    await writer.write(enc.encode(buildRouteFramePushScript(frames, nonce)));
    return;
  }

  try {
    const resolvedValue = await promise;
    const chunk = toCrossJSON(resolvedValue);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "resolve", nonce)));
  } catch (err) {
    const normalized = await serializeDeferredRejection(err);
    const chunk = toCrossJSON(normalized);
    await writer.write(enc.encode(buildDeferredResolution(key, chunk, "reject", nonce)));
  }
}

export async function writeDeferredSsrChunks(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  enc: TextEncoder,
  deferredPromises: Record<string, Promise<unknown>>,
  usesRouteFrames: boolean,
  nonce?: string,
  signal?: AbortSignal
): Promise<void> {
  await Promise.all(
    Object.entries(deferredPromises).map(([key, promise], index) =>
      writeDeferredSsrChunk(
        writer,
        enc,
        key,
        waitForDeferred(promise, signal),
        index,
        usesRouteFrames,
        nonce
      )
    )
  );
  if (usesRouteFrames) {
    await writer.write(enc.encode(buildRouteFrameCloseScript(nonce)));
  }
}

function waitForDeferred(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined
): Promise<unknown> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
