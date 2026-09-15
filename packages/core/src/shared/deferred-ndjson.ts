// biome-ignore-all lint/performance/noAwaitInLoops: NDJSON stream chunks must be read sequentially
import type { SerovalNode } from "seroval";
import { fromCrossJSON } from "seroval";
import { parseCompactJsonLine } from "./compact-json.ts";
import { isRouteFrameLine, parseRouteFrameLines } from "./route-frame.ts";

/**
 * Result returned by `parseDeferredNdjson`.
 */
export interface DeferredNdjsonResult {
  /**
   * Deferred promises keyed by their field name. Each Promise resolves (or
   * rejects) once the corresponding data is available. In the SSR case the
   * promises are already settled (serialised by `toCrossJSONAsync`). For
   * streaming endpoints they will settle as the server flushes resolution
   * chunks.
   */
  deferredPromises: Record<string, Promise<unknown>>;
  /** Scalar/sync values from the loader — available immediately. */
  syncData: Record<string, unknown>;
}

function makeAbortError(reason: unknown): Error {
  const message =
    reason instanceof Error ? reason.message || "The operation was aborted." : "aborted";
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Parses an NDJSON stream produced by `/_furin/data`.
 *
 * Single-line, all-resolved payloads use either a compact JSON envelope for
 * ordinary JSON data or CrossJSON when richer JavaScript semantics must be
 * preserved. Deferred and RSC payloads use Route Frames.
 *
 * CrossJSON nodes are deserialised with `fromCrossJSON`. Values that are
 * Promises (seroval type 12) land in `deferredPromises`; everything else lands
 * in `syncData`.
 *
 * @param stream - A `ReadableStream<Uint8Array>` from `fetch().body`.
 * @param signal - AbortSignal that, when aborted, cancels the reader and
 *                 rejects every still-pending deferred promise with an
 *                 `AbortError`. Pass `undefined` to opt out (no implicit
 *                 default — see CLAUDE.md).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: NDJSON streaming parser handles sync, deferred, abort, and malformed-stream paths in one state machine
export async function parseDeferredNdjson(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<DeferredNdjsonResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let abortHandler: (() => void) | undefined;

  const cancelReader = (reason: unknown): void => {
    reader.cancel(reason).catch(() => {
      /* reader may already be closed */
    });
  };

  if (signal?.aborted) {
    const err = makeAbortError(signal.reason);
    await reader.cancel(err).catch(() => {
      /* reader may already be closed */
    });
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    return { deferredPromises: {}, syncData: {} };
  }

  if (signal !== undefined && !signal.aborted) {
    abortHandler = () => cancelReader(makeAbortError(signal.reason));
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const cleanupAbortHandler = (): void => {
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
  };

  async function readLine(): Promise<string | undefined> {
    for (;;) {
      // react-doctor-disable-next-line react-doctor/js-set-map-lookups
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          return line;
        }
        continue;
      }

      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const line = buffer.trim();
        buffer = "";
        return line.length > 0 ? line : undefined;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  const firstLine = await readLine();
  if (!firstLine) {
    cleanupAbortHandler();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    return { deferredPromises: {}, syncData: {} };
  }

  if (isRouteFrameLine(firstLine)) {
    const result = await parseRouteFrameLines(firstLine, readLine);
    if (signal !== undefined) {
      cleanupAbortHandler();
      abortHandler = () => {
        const error = makeAbortError(signal.reason);
        result.abort(error);
        cancelReader(error);
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
    result.completion.finally(() => {
      cleanupAbortHandler();
      try {
        reader.releaseLock();
      } catch {
        /* already released via reader.cancel() in the abort path */
      }
    });
    return { deferredPromises: result.deferredPromises, syncData: result.syncData };
  }

  const parsed = JSON.parse(firstLine) as unknown;
  const compactJson = parseCompactJsonLine(parsed);
  if (compactJson !== undefined) {
    cleanupAbortHandler();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    return { deferredPromises: {}, syncData: compactJson };
  }

  const node = parsed as SerovalNode;
  const deserialized = fromCrossJSON(node, {}) as Record<string, unknown>;

  const syncData: Record<string, unknown> = {};
  const deferredPromises: Record<string, Promise<unknown>> = {};
  const resolvers: Record<
    string,
    { reject: (reason: unknown) => void; resolve: (value: unknown) => void }
  > = {};
  const deferredKeys = Array.isArray(deserialized.__furinDeferredKeys)
    ? (deserialized.__furinDeferredKeys.filter((key) => typeof key === "string") as string[])
    : [];

  for (const [key, value] of Object.entries(deserialized)) {
    if (key === "__furinDeferredKeys") {
      continue;
    }
    if (value instanceof Promise) {
      deferredPromises[key] = value;
    } else {
      syncData[key] = value;
    }
  }

  for (const key of deferredKeys) {
    if (!(key in deferredPromises)) {
      deferredPromises[key] = new Promise((resolve, reject) => {
        resolvers[key] = { reject, resolve };
      });
    }
  }

  // A superseded navigation may discard deferred values before React observes
  // them. Mark each rejection as handled without changing the original
  // promise, so consumers that do await it still receive the same error.
  for (const promise of Object.values(deferredPromises)) {
    promise.catch(() => undefined);
  }

  if (deferredKeys.length === 0) {
    cleanupAbortHandler();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    return { deferredPromises, syncData };
  }

  // Reject every still-pending resolver and cancel the underlying reader. Used
  // both by the AbortSignal listener and by the readDeferredLines error path.
  const rejectAllPending = (reason: unknown): void => {
    for (const key of Object.keys(resolvers)) {
      resolvers[key]?.reject(reason);
      delete resolvers[key];
    }
    cancelReader(reason);
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      rejectAllPending(makeAbortError(signal.reason));
      return { deferredPromises, syncData };
    }
    cleanupAbortHandler();
    abortHandler = () => {
      rejectAllPending(makeAbortError(signal.reason));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  readDeferredLines(readLine, resolvers)
    .then(() => {
      // Stream ended normally. Any resolver that never received its chunk is
      // dropped without a settle event — surface a rejection so consumers
      // (e.g. <Await>) don't hang forever.
      for (const key of Object.keys(resolvers)) {
        const err = new Error(`[furin] deferred stream closed before "${key}" was resolved`);
        resolvers[key]?.reject(err);
        delete resolvers[key];
      }
    })
    .catch((err) => {
      for (const resolver of Object.values(resolvers)) {
        resolver.reject(err);
      }
    })
    .finally(() => {
      cleanupAbortHandler();
      try {
        reader.releaseLock();
      } catch {
        /* already released via reader.cancel() in the abort path */
      }
    });

  return { deferredPromises, syncData };
}

async function readDeferredLines(
  readLine: () => Promise<string | undefined>,
  resolvers: Record<
    string,
    { reject: (reason: unknown) => void; resolve: (value: unknown) => void }
  >
): Promise<void> {
  for (;;) {
    const line = await readLine();
    if (!line) {
      return;
    }
    const entry = JSON.parse(line) as {
      action?: "reject" | "resolve";
      key?: string;
      value?: SerovalNode;
    };
    if (typeof entry.key !== "string" || !entry.value) {
      continue;
    }
    const resolver = resolvers[entry.key];
    if (!resolver) {
      continue;
    }
    const value = fromCrossJSON(entry.value, {});
    if (entry.action === "reject") {
      resolver.reject(value);
    } else {
      resolver.resolve(value);
    }
    delete resolvers[entry.key];
  }
}
