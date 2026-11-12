import { toCrossJSON } from "seroval";
import type { RuntimeData } from "../../src/client/internal/runtime-types.ts";

const NAVIGATION_DATA_MARKER_RE = /[?&]_furin=data$/;

/**
 * Logical href (`pathname + search`) a mocked `fetch` received as an SPA
 * navigation data request (`<page>?_furin=data`), or `null` for any other
 * request.
 */
export function navigationDataPath(input: RequestInfo | URL, origin: string): string | null {
  const url = new URL(input instanceof Request ? input.url : String(input), origin);
  if (!NAVIGATION_DATA_MARKER_RE.test(url.search)) {
    return null;
  }
  return url.pathname + url.search.replace(NAVIGATION_DATA_MARKER_RE, "");
}

/** Single-line NDJSON response (CrossJSON-serialised) for `?_furin=data` navigation requests. */
export function makeNdjsonResponse(data: RuntimeData): Response {
  return new Response(`${JSON.stringify(toCrossJSON(data))}\n`, {
    headers: { "Content-Type": "application/x-ndjson" },
    status: 200,
  });
}
