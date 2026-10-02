import { toCrossJSON } from "seroval";
import {
  MAX_ROUTE_FRAME_STREAM_BYTES,
  serializeRouteFrame,
  serializeRouteFrames,
  serializeRouteFrameValue,
} from "../../shared/route-frame.ts";
import { deferredQuerySeeds } from "../sync/query-context.ts";
import { serializeDeferredRejection } from "./loaders.ts";

export async function serializeDeferredRouteFrame(
  key: string,
  promise: Promise<unknown>,
  idPrefix: string
): Promise<string> {
  try {
    const { rscFrames, value } = serializeRouteFrameValue(await promise, idPrefix);
    const queries = deferredQuerySeeds(promise);
    return (
      serializeRouteFrame({
        key,
        type: "defer-resolve",
        value,
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
  syncData: Record<string, unknown>,
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
