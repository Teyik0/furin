// biome-ignore-all lint/performance/noAwaitInLoops: route-frame parsing consumes ordered chunks and retries sequentially
import type { SerovalNode } from "seroval";
import { fromCrossJSON, toCrossJSON } from "seroval";
import {
  getRscSourceState,
  isRscSource,
  type RscSourceKind,
  restoreRscSource,
} from "../rsc/shared.tsx";
import { mergeQuerySeeds, type QuerySeed } from "./sync-query.ts";

const FRAME_VERSION = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_ROUTE_FRAME_STREAM_BYTES = 8 * 1024 * 1024;
const RSC_DESCRIPTOR = "__furinRsc";

interface RouteFrameEnvelope {
  __furinRouteFrame: typeof FRAME_VERSION | 3;
  frame: RouteFrame;
}

export type RouteFrame =
  | { type: "data"; deferredKeys: readonly string[]; value: SerovalNode; references?: true }
  | {
      type: "defer-resolve";
      key: string;
      value: SerovalNode;
      queries?: SerovalNode;
      references?: true;
    }
  | { type: "defer-reject"; key: string; value: SerovalNode }
  | { type: "rsc-start"; id: string; kind: RscSourceKind }
  | { type: "rsc-chunk"; id: string; value: string }
  | { type: "rsc-end"; id: string }
  | { type: "rsc-error"; id: string; digest: string };

interface CollectedRscSource {
  bytes: Uint8Array;
  descriptor: RscDescriptor;
  id: string;
  kind: RscSourceKind;
}

interface RscDescriptor {
  __furinRsc: string;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function extractRscSources(
  value: unknown,
  sources: CollectedRscSource[],
  seen: WeakMap<object, unknown>,
  idPrefix: string
): unknown {
  if (isRscSource(value)) {
    const state = getRscSourceState(value);
    if (state === undefined) {
      return value;
    }
    const id = `${idPrefix}-${sources.length}`;
    const descriptor = { [RSC_DESCRIPTOR]: id } satisfies RscDescriptor;
    sources.push({ bytes: state.bytes, descriptor, id, kind: state.kind });
    return descriptor;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const previous = seen.get(value);
  if (previous !== undefined) {
    return previous;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) {
      result.push(extractRscSources(entry, sources, seen, idPrefix));
    }
    return result;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: { [key: string]: unknown } = {};
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    result[key] = extractRscSources(entry, sources, seen, idPrefix);
  }
  return result;
}

function bytesToFrameValues(bytes: Uint8Array): string[] {
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + 64 * 1024, text.length);
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd8_00 && lastCodeUnit <= 0xdb_ff) {
        end -= 1;
      }
      chunks.push(`utf8:${text.slice(offset, end)}`);
      offset = end;
    }
    return chunks.length > 0 ? chunks : ["utf8:"];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 48 * 1024) {
    let binary = "";
    for (const byte of bytes.subarray(offset, offset + 48 * 1024)) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(`base64:${btoa(binary)}`);
  }
  return chunks.length > 0 ? chunks : ["base64:"];
}

function frameValueToBytes(value: string): Uint8Array {
  if (value.startsWith("utf8:")) {
    return new TextEncoder().encode(value.slice(5));
  }
  if (!value.startsWith("base64:")) {
    throw new Error("[furin] malformed RSC route frame encoding");
  }
  const binary = atob(value.slice(7));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeFrame(frame: RouteFrame): string {
  const envelope: RouteFrameEnvelope = { __furinRouteFrame: FRAME_VERSION, frame };
  const line = JSON.stringify(envelope);
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) {
    throw new Error(`[furin] route frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);
  }
  return `${line}\n`;
}

export function serializeRouteFrame(frame: RouteFrame): string {
  return encodeFrame(frame);
}

export function serializeRouteFrameValue(
  value: unknown,
  idPrefix = "rsc"
): {
  rscFrames: string;
  value: SerovalNode;
  references?: true;
} {
  const sources: CollectedRscSource[] = [];
  const serializable = extractRscSources(value, sources, new WeakMap(), idPrefix);
  const rscFrames = sources
    .flatMap((source) => [
      encodeFrame({ id: source.id, kind: source.kind, type: "rsc-start" }),
      ...bytesToFrameValues(source.bytes).map((chunk) =>
        encodeFrame({ id: source.id, type: "rsc-chunk", value: chunk })
      ),
      encodeFrame({ id: source.id, type: "rsc-end" }),
    ])
    .join("");

  return sources.length > 0
    ? {
        rscFrames,
        references: true,
        value: toCrossJSON({
          value: serializable,
          references: sources.map((source) => source.descriptor),
        }),
      }
    : { rscFrames, value: toCrossJSON(serializable) };
}

export function containsRscSource(value: unknown): boolean {
  return containsRscSourceInner(value, new WeakSet());
}

function containsRscSourceInner(value: unknown, seen: WeakSet<object>): boolean {
  if (isRscSource(value)) {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsRscSourceInner(entry, seen));
  }
  return (
    isPlainObject(value) &&
    Object.values(value).some((entry) => containsRscSourceInner(entry, seen))
  );
}

export function serializeRouteFrames(
  data: object,
  deferredKeys: readonly string[] | undefined
): string {
  const sources: CollectedRscSource[] = [];
  const serializable = extractRscSources(data, sources, new WeakMap(), "rsc");
  const lines = [
    encodeFrame({
      deferredKeys: deferredKeys ?? [],
      type: "data",
      value: toCrossJSON(serializable),
      ...(sources.length > 0 && {
        references: true,
        value: toCrossJSON({
          value: serializable,
          references: sources.map((source) => source.descriptor),
        }),
      }),
    }),
  ];
  for (const source of sources) {
    lines.push(encodeFrame({ id: source.id, kind: source.kind, type: "rsc-start" }));
    for (const value of bytesToFrameValues(source.bytes)) {
      lines.push(encodeFrame({ id: source.id, type: "rsc-chunk", value }));
    }
    lines.push(encodeFrame({ id: source.id, type: "rsc-end" }));
  }
  const payload = lines.join("");
  if (new TextEncoder().encode(payload).byteLength > MAX_ROUTE_FRAME_STREAM_BYTES) {
    throw new Error(
      `[furin] route frame stream exceeds the ${MAX_ROUTE_FRAME_STREAM_BYTES}-byte limit`
    );
  }
  return payload;
}

export function isRouteFrameLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { __furinRouteFrame?: unknown };
    return parsed.__furinRouteFrame === FRAME_VERSION || parsed.__furinRouteFrame === 3;
  } catch {
    return false;
  }
}

function hydrateRscDescriptors(
  value: unknown,
  sources: Map<string, unknown>,
  references: Set<object> | undefined,
  seen: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (references === undefined ? isRscDescriptor(value) : references.has(value)) {
    const id = (value as RscDescriptor).__furinRsc;
    const source = sources.get(id);
    if (source === undefined) {
      throw new Error(`[furin] RSC route frame "${id}" is missing`);
    }
    return source;
  }
  const previous = seen.get(value);
  if (previous !== undefined) {
    return previous;
  }
  if (Array.isArray(value)) {
    seen.set(value, value);
    for (let i = 0; i < value.length; i += 1) {
      value[i] = hydrateRscDescriptors(value[i], sources, references, seen);
    }
    return value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  seen.set(value, value);
  for (const [key, entry] of Object.entries(value)) {
    Reflect.set(value, key, hydrateRscDescriptors(entry, sources, references, seen));
  }
  return value;
}

function collectRscDescriptorIds(
  value: unknown,
  ids: Set<string>,
  references: Set<object> | undefined,
  seen: WeakSet<object>
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (references === undefined ? isRscDescriptor(value) : references.has(value)) {
    ids.add((value as RscDescriptor).__furinRsc);
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    collectRscDescriptorIds(entry, ids, references, seen);
  }
}

function isRscDescriptor(value: object): boolean {
  return isPlainObject(value) && typeof (value as { __furinRsc?: unknown }).__furinRsc === "string";
}

function decodeFrameValue(
  frame: { value: SerovalNode; references?: true },
  version: number
): { value: unknown; references: Set<object> | undefined } {
  const decoded = fromCrossJSON(frame.value, {});
  if (frame.references) {
    const packed = decoded as { value: unknown; references: object[] };
    return { value: packed.value, references: new Set(packed.references) };
  }
  return { value: decoded, references: version === 3 ? undefined : new Set() };
}

export async function parseRouteFrameLines(
  firstLine: string,
  readLine: () => Promise<string | undefined>
): Promise<{
  abort: (reason: unknown) => void;
  completion: Promise<void>;
  deferredPromises: { [key: string]: Promise<unknown> };
  syncData: { [key: string]: unknown };
}> {
  let byteLength = 0;
  let dataValue: unknown;
  let dataReferences: Set<object> | undefined;
  const pending = new Map<string, { chunks: Uint8Array[]; kind: RscSourceKind }>();
  const sources = new Map<string, unknown>();
  const deferredPromises: { [key: string]: Promise<unknown> } = {};
  const resolvers = new Map<
    string,
    { reject: (reason: unknown) => void; resolve: (value: unknown) => void }
  >();
  const rejectPending = (reason: unknown): void => {
    for (const resolver of resolvers.values()) {
      resolver.reject(reason);
    }
    resolvers.clear();
  };
  const deferredRscValues = new Map<
    string,
    { ids: Set<string>; value: unknown; references: Set<object> | undefined }
  >();
  const tryResolveDeferredRscValues = (): void => {
    for (const [key, deferred] of deferredRscValues) {
      if ([...deferred.ids].some((id) => !sources.has(id))) {
        continue;
      }
      resolvers
        .get(key)
        ?.resolve(
          hydrateRscDescriptors(deferred.value, sources, deferred.references, new WeakMap())
        );
      resolvers.delete(key);
      deferredRscValues.delete(key);
    }
  };
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded state machine validates every versioned frame variant
  const processLine = (line: string): void => {
    byteLength += new TextEncoder().encode(line).byteLength + 1;
    if (byteLength > MAX_ROUTE_FRAME_STREAM_BYTES) {
      throw new Error(
        `[furin] route frame stream exceeds the ${MAX_ROUTE_FRAME_STREAM_BYTES}-byte limit`
      );
    }
    const envelope = JSON.parse(line) as RouteFrameEnvelope;
    if (envelope.__furinRouteFrame !== FRAME_VERSION && envelope.__furinRouteFrame !== 3) {
      throw new Error("[furin] unsupported route frame version");
    }
    const { frame } = envelope;
    if (frame.type === "data") {
      const decoded = decodeFrameValue(frame, envelope.__furinRouteFrame);
      dataValue = decoded.value;
      dataReferences = decoded.references;
      if (frame.deferredKeys.length > 0 && dataValue && typeof dataValue === "object") {
        const data = dataValue as { __furinQueries?: QuerySeed[] };
        data.__furinQueries ??= [];
      }
      for (const key of frame.deferredKeys) {
        deferredPromises[key] = new Promise((resolve, reject) => {
          resolvers.set(key, { reject, resolve });
        });
        deferredPromises[key]?.catch(() => undefined);
      }
    } else if (frame.type === "rsc-start") {
      pending.set(frame.id, { chunks: [], kind: frame.kind });
    } else if (frame.type === "rsc-chunk") {
      const source = pending.get(frame.id);
      if (source === undefined) {
        throw new Error(`[furin] RSC chunk received before start for "${frame.id}"`);
      }
      source.chunks.push(frameValueToBytes(frame.value));
    } else if (frame.type === "rsc-end") {
      const source = pending.get(frame.id);
      if (source === undefined) {
        throw new Error(`[furin] RSC end received before start for "${frame.id}"`);
      }
      const length = source.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of source.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      sources.set(frame.id, restoreRscSource(source.kind, bytes));
      pending.delete(frame.id);
      tryResolveDeferredRscValues();
    } else if (frame.type === "rsc-error") {
      throw new Error(`[furin] RSC stream failed (${frame.digest})`);
    } else if (frame.type === "defer-resolve") {
      if (frame.queries && dataValue && typeof dataValue === "object") {
        const data = dataValue as { __furinQueries?: QuerySeed[] };
        mergeQuerySeeds(
          (data.__furinQueries ??= []),
          fromCrossJSON(frame.queries, {}) as QuerySeed[]
        );
      }
      const { value, references } = decodeFrameValue(frame, envelope.__furinRouteFrame);
      const ids = new Set<string>();
      collectRscDescriptorIds(value, ids, references, new WeakSet());
      if ([...ids].some((id) => !sources.has(id))) {
        deferredRscValues.set(frame.key, { ids, value, references });
      } else {
        resolvers
          .get(frame.key)
          ?.resolve(hydrateRscDescriptors(value, sources, references, new WeakMap()));
        resolvers.delete(frame.key);
      }
    } else if (frame.type === "defer-reject") {
      resolvers.get(frame.key)?.reject(fromCrossJSON(frame.value, {}));
      resolvers.delete(frame.key);
    }
  };

  processLine(firstLine);
  if (dataValue === undefined) {
    throw new Error("[furin] route frame stream has no data frame");
  }
  const expectedSources = new Set<string>();
  collectRscDescriptorIds(dataValue, expectedSources, dataReferences, new WeakSet());
  while ([...expectedSources].some((id) => !sources.has(id))) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const line = await readLine();
    if (line === undefined) {
      throw new Error("[furin] route frame stream ended before an RSC source completed");
    }
    processLine(line);
  }
  const data = hydrateRscDescriptors(dataValue, sources, dataReferences, new WeakMap());
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[furin] route data frame must decode to an object");
  }

  const completion = (async () => {
    for (;;) {
      const line = await readLine();
      if (line === undefined) {
        break;
      }
      processLine(line);
    }
    if (pending.size > 0) {
      throw new Error("[furin] route frame stream ended before an RSC source completed");
    }
    if (deferredRscValues.size > 0) {
      throw new Error("[furin] route frame stream ended before an RSC source completed");
    }
    for (const [key, resolver] of resolvers) {
      resolver.reject(new Error(`[furin] deferred stream closed before "${key}" was resolved`));
    }
    resolvers.clear();
  })().catch((error: unknown) => {
    rejectPending(error);
    throw error;
  });

  return {
    abort: rejectPending,
    completion,
    deferredPromises,
    syncData: data as { [key: string]: unknown },
  };
}
