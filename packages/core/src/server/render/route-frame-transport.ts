import { toCrossJSON, toCrossJSONAsync } from "seroval";
import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { serializeCompactJsonLine } from "../../shared/compact-json.ts";
import {
  containsRscSource,
  MAX_ROUTE_FRAME_STREAM_BYTES,
  serializeRouteFrame,
  serializeRouteFrames,
  serializeRouteFrameValue,
} from "../../shared/route-frame.ts";
import { deferredQuerySeeds } from "../sync/query-context.ts";
import { serializeDeferredRejection } from "./loader-errors.ts";

export async function serializeDeferredRouteFrame(
  key: string,
  promise: Promise<unknown>,
  idPrefix: string
): Promise<string> {
  try {
    const { rscFrames, value, references } = serializeRouteFrameValue(await promise, idPrefix);
    const queries = deferredQuerySeeds(promise);
    return (
      serializeRouteFrame({
        key,
        type: "defer-resolve",
        value,
        ...(references && { references }),
        ...(queries && { queries: toCrossJSON(queries) }),
      }) + rscFrames
    );
  } catch (error) {
    return serializeRouteFrame({
      key,
      type: "defer-reject",
      value: toCrossJSON(await serializeDeferredRejection(error)),
    });
  }
}

export function createDeferredRouteFrameStream(
  syncData: RuntimeData,
  deferredPromises: Record<string, Promise<unknown>>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const initialFrame = encoder.encode(
        serializeRouteFrames(syncData, Object.keys(deferredPromises))
      );
      let encodedBytes = initialFrame.byteLength;
      controller.enqueue(initialFrame);
      await Promise.all(
        Object.entries(deferredPromises).map(async ([key, promise], index) => {
          const frame = encoder.encode(
            await serializeDeferredRouteFrame(key, promise, `defer-${index}`)
          );
          encodedBytes += frame.byteLength;
          if (encodedBytes > MAX_ROUTE_FRAME_STREAM_BYTES) {
            throw new Error(
              `[furin] route frame stream exceeds the ${MAX_ROUTE_FRAME_STREAM_BYTES}-byte limit`
            );
          }
          controller.enqueue(frame);
        })
      );
      controller.close();
    },
  });
}

/**
 * Serialises a loader's `syncData` + `deferredPromises` into the same one-line
 * NDJSON shape live navigation data requests (`?_furin=data`) receive.
 */
export async function serializeLoaderDataNdjson(
  syncData: RuntimeData,
  deferredPromises: Record<string, Promise<unknown>> | undefined
): Promise<string> {
  const payload: RuntimeData = {
    ...syncData,
    ...(deferredPromises ?? {}),
  };
  const deferredEntries = Object.entries(deferredPromises ?? {});
  if (containsRscSource(payload) || deferredEntries.length > 0) {
    let ndjson = serializeRouteFrames(
      syncData,
      deferredEntries.map(([key]) => key)
    );
    await Promise.all(
      deferredEntries.map(async ([key, promise], index) => {
        ndjson += await serializeDeferredRouteFrame(key, promise, `defer-${index}`);
      })
    );
    return ndjson;
  }
  const compactJson = serializeCompactJsonLine(payload);
  if (compactJson !== undefined) {
    return compactJson;
  }
  const serialized = await toCrossJSONAsync(payload);
  return `${JSON.stringify(serialized)}\n`;
}
