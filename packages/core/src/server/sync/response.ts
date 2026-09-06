import { type Context, ElysiaCustomStatusResponse, StatusMap } from "elysia";
import type { StoredResponse } from "./adapter.ts";

const NON_REPLAYABLE_HEADERS = new Set([
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
]);
export const MAX_SYNC_REPLAY_RESPONSE_BYTES = 1024 * 1024;
const UNREPLAYABLE_SYNC_RESPONSE_BODY = new TextEncoder().encode(
  JSON.stringify({
    code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    message:
      "This mutation response cannot be replayed safely. Return a small bounded response or set sync: false on the route.",
  })
);

export type StoreResponseResult =
  | { kind: "stored"; response: StoredResponse }
  | { kind: "unreplayable"; response: StoredResponse };

function statusCode(status: Context["set"]["status"]): number {
  if (typeof status === "number") {
    return status;
  }
  return status === undefined ? 200 : StatusMap[status];
}

function unwrapStatusResponse(value: unknown): { status: number; value: unknown } | undefined {
  if (!(value instanceof ElysiaCustomStatusResponse)) {
    return;
  }
  return { status: value.code, value: value.response };
}

function responseHeaders(headers: Context["set"]["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NON_REPLAYABLE_HEADERS.has(name.toLowerCase())) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        result.append(name, String(entry));
      }
    }
  }
  return result;
}

function storedResponseResult(
  headers: Headers,
  body: Uint8Array,
  status: number
): StoreResponseResult {
  if (body.byteLength > MAX_SYNC_REPLAY_RESPONSE_BYTES) {
    return unreplayable();
  }
  return {
    kind: "stored",
    response: {
      body,
      headers: [...headers.entries()],
      status,
    },
  };
}

function responseContentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) {
    return;
  }
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array | undefined> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const contentLength = responseContentLength(response);
  if (contentLength === undefined || contentLength > MAX_SYNC_REPLAY_RESPONSE_BYTES) {
    return;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: response body chunks must be read sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_SYNC_REPLAY_RESPONSE_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function unreplayable(): StoreResponseResult {
  return {
    kind: "unreplayable",
    response: {
      body: UNREPLAYABLE_SYNC_RESPONSE_BODY.slice(),
      headers: [["content-type", "application/json;charset=utf-8"]],
      status: 500,
    },
  };
}

export function mergeStoredResponseHeaders(
  storedResponse: StoredResponse,
  headers: Context["set"]["headers"]
): StoredResponse {
  const headerEntries: [string, string][] = [];
  for (const [name, value] of storedResponse.headers) {
    if (!NON_REPLAYABLE_HEADERS.has(name.toLowerCase())) {
      headerEntries.push([name, value]);
    }
  }
  const merged = new Headers(headerEntries);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NON_REPLAYABLE_HEADERS.has(name.toLowerCase())) {
      merged.delete(name);
      for (const entry of Array.isArray(value) ? value : [value]) {
        merged.append(name, String(entry));
      }
    }
  }
  return {
    ...storedResponse,
    headers: [...merged.entries()],
  };
}

export async function storeResponse(
  responseValue: unknown,
  set: Context["set"]
): Promise<StoreResponseResult> {
  if (responseValue instanceof Response) {
    const clone = responseValue.clone();
    const body = await readBoundedResponseBody(clone);
    if (body === undefined) {
      return unreplayable();
    }
    const headers = new Headers(
      [...clone.headers.entries()].filter(
        ([name]) => !NON_REPLAYABLE_HEADERS.has(name.toLowerCase())
      )
    );
    return storedResponseResult(headers, body, clone.status);
  }

  const headers = responseHeaders(set.headers);
  const statusResponse = unwrapStatusResponse(responseValue);
  const value = statusResponse?.value ?? responseValue;
  const responseStatus = statusResponse ? statusResponse.status : statusCode(set.status);
  let body: Uint8Array;
  if (value === undefined || value === null) {
    body = new Uint8Array();
  } else if (typeof value === "string") {
    headers.set("content-type", headers.get("content-type") ?? "text/plain;charset=utf-8");
    body = new TextEncoder().encode(value);
  } else {
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    body = new TextEncoder().encode(JSON.stringify(value));
  }
  return storedResponseResult(headers, body, responseStatus);
}

export function replayResponse(stored: StoredResponse): Response {
  const body =
    stored.status === 204 || stored.status === 205 || stored.status === 304
      ? null
      : stored.body.slice();
  const headerEntries: [string, string][] = [];
  for (const [name, value] of stored.headers) {
    if (!NON_REPLAYABLE_HEADERS.has(name.toLowerCase())) {
      headerEntries.push([name, value]);
    }
  }
  return new Response(body, {
    headers: new Headers(headerEntries),
    status: stored.status,
  });
}
