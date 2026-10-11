import type React from "react";
import { createElement } from "react";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import { DefaultErrorFallback, DefaultNotFoundScreen } from "../default-screens.tsx";
import type { FurinServerErrorPayload } from "../server-error.ts";
import { TRAILING_SLASHES_RE, toLogical } from "./link-utils.ts";
import type { ClientSegmentBoundary, SpaResponseKind } from "./types.ts";

function isFurinErrorPayload(
  value: unknown
): value is { digest: string; message: string; status: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as { digest?: unknown; message?: unknown; status?: unknown };
  return (
    typeof v.digest === "string" && typeof v.message === "string" && typeof v.status === "number"
  );
}

/**
 * Pure classifier for an SPA-nav fetch result. Takes the HTTP status and the
 * already-parsed `__FURIN_DATA__` payload.
 *
 * Sentinels (`__furinError`, `__furinStatus`) are trusted over the raw HTTP
 * status — proxies / CDNs sometimes rewrite the status code but pass the body
 * through untouched. A non-2xx response without any sentinel triggers a bail
 * so the browser handles it (could be an error page, redirect, etc.).
 *
 * @internal Exported for unit testing only.
 */
export function classifySpaResponse(
  status: number,
  data: Record<string, unknown> | null
): SpaResponseKind {
  if (!data) {
    return { kind: "bail" };
  }
  if (isFurinErrorPayload(data.__furinError)) {
    return { error: data.__furinError, kind: "error" };
  }
  if (((status >= 200 && status < 300) || status === 404) && data.__furinStatus === 404) {
    const notFound = data.__furinNotFound as { data?: unknown; message?: string } | undefined;
    return { error: notFound ?? {}, kind: "not-found" };
  }
  if (status >= 200 && status < 300) {
    return { kind: "ok" };
  }
  return { kind: "bail" };
}

/**
 * Picks the deepest not-found component declared on the match's boundary chain.
 *
 * @internal Exported for unit testing only.
 */
export function pickDeepestNotFound(
  boundaries: ClientSegmentBoundary[] | undefined
): NotFoundComponent | undefined {
  if (!boundaries) {
    return;
  }
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const seg = boundaries[i];
    if (seg?.notFound) {
      return seg.notFound;
    }
  }
}

const DefaultClientNotFoundFallback: NotFoundComponent = ({ error }) =>
  createElement(DefaultNotFoundScreen, { message: error.message });

/**
 * Builds the bare not-found element rendered inline by RouterProvider on SPA
 * navigation when the server signalled a 404.
 *
 * @internal Exported for unit testing only.
 */
export function buildNotFoundPageElement(
  boundaries: ClientSegmentBoundary[] | undefined,
  error: { data?: unknown; message?: string }
): React.ReactNode {
  const Fallback = pickDeepestNotFound(boundaries) ?? DefaultClientNotFoundFallback;
  return createElement(Fallback, { error });
}

export function buildErrorPageElement(
  boundaries: ClientSegmentBoundary[] | undefined,
  error: FurinServerErrorPayload,
  reset: () => void
): React.ReactNode {
  const Fallback = boundaries?.findLast((segment) => segment.error)?.error ?? DefaultErrorFallback;
  return createElement(Fallback, { error, reset });
}

/**
 * Parses the HTML payload of a page response into the pieces `fetchPageState`
 * cares about: the document (for title), the __FURIN_DATA__ loader payload,
 * and the logical `finalHref` after any server-side redirect.
 */
export async function parsePageResponse(
  res: Response,
  basePath: string
): Promise<{ data: Record<string, unknown> | null; finalHref: string | undefined; title: string }> {
  let finalHref: string | undefined;
  if (res.redirected) {
    const final = new URL(res.url);
    finalHref = toLogical(final.pathname, basePath) + final.search;
  }
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const dataEl = doc.getElementById("__FURIN_DATA__");
  const data = dataEl ? JSON.parse(dataEl.textContent || "{}") : null;
  return { data, finalHref, title: doc.title };
}

/**
 * Builds the URL the SPA navigation flow uses to fetch a route's loader data.
 *
 * Two transports are supported:
 *
 *   • **Runtime (SSR/ISR/dev)** — `${basePath}/_furin/data?path=<logicalHref>`.
 *   • **Static export** — `${basePath}<logicalPathname>/__furin_data.ndjson`.
 *
 * @internal Exported for unit testing.
 */
export function buildDataEndpoint(
  basePath: string,
  logicalHref: string,
  staticMode: boolean
): string {
  if (!staticMode) {
    return `${basePath}/_furin/data?path=${encodeURIComponent(logicalHref)}`;
  }
  const parsed = new URL(logicalHref, "http://x");
  const pathname = parsed.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${basePath}${pathname}/__furin_data.ndjson`;
}

/**
 * Reads `<meta name="furin-mode" content="static">` from the document at boot.
 *
 * @internal Exported for unit testing.
 */
export function detectStaticMode(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="furin-mode"]');
  return meta?.content === "static";
}
