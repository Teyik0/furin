import { readBoundedBytes } from "../server/bounded-body.ts";
import { createFurinRscRenderError, type RscRenderOperation } from "./render-error.ts";

const MAX_FLIGHT_BYTES = 4 * 1024 * 1024;

interface FlightRenderErrorState {
  error: unknown;
  reported: boolean;
}

export interface FlightRenderSession {
  getRenderError: () => FlightRenderErrorState;
  stream: ReadableStream<Uint8Array>;
}

async function readFlightBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const bytes = await readBoundedBytes(stream, MAX_FLIGHT_BYTES);
  if (bytes === undefined) {
    throw new Error(
      `[furin/rsc] Flight payload exceeds the ${MAX_FLIGHT_BYTES}-byte safety limit.`
    );
  }
  return bytes;
}

export async function drainFlight(
  session: FlightRenderSession,
  operation: RscRenderOperation
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFlightBytes(session.stream);
  } catch (streamError) {
    const renderError = session.getRenderError();
    if (renderError.reported) {
      throw createFurinRscRenderError(renderError.error, operation);
    }
    throw streamError;
  }
  const renderError = session.getRenderError();
  if (renderError.reported) {
    throw createFurinRscRenderError(renderError.error, operation);
  }
  return bytes;
}
