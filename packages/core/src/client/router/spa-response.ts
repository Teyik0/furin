import { navigationDataHref } from "../../shared/navigation-data.ts";
import { physicalPath } from "../../shared/prefix.ts";
import { findRouteFailure } from "../../shared/route-matches.ts";
import { TRAILING_SLASHES_RE, toLogical } from "./link-utils.ts";
import type { SpaResponseKind } from "./types.ts";

/**
 * Pure classifier for an SPA-nav fetch result. Takes the HTTP status and the
 * already-parsed `__FURIN_DATA__` payload.
 *
 * A failed route match is trusted over the raw HTTP status — proxies / CDNs
 * sometimes rewrite the status code but pass the body through untouched. A
 * non-2xx response without a failed match triggers a bail so the browser
 * handles it (could be an error page, redirect, etc.).
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
  const failure = findRouteFailure(data);
  if (failure?.status === "error") {
    return { error: failure.error, kind: "error" };
  }
  if (((status >= 200 && status < 300) || status === 404) && failure?.status === "notFound") {
    return { error: failure.error, kind: "not-found" };
  }
  if (status >= 200 && status < 300) {
    return { kind: "ok" };
  }
  return { kind: "bail" };
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
 *   • **Runtime (SSR/ISR/dev)** — the page URL with `_furin=data` appended.
 *   • **Static export** — `${basePath}<logicalPathname>/__furin_data.ndjson`.
 *
 * @internal Exported for unit testing.
 */
export function buildDataEndpoint(
  basePath: string,
  logicalHref: string,
  staticMode: boolean
): string {
  const parsed = new URL(logicalHref, "http://x");
  if (!staticMode) {
    return navigationDataHref(physicalPath(basePath, parsed.pathname) + parsed.search);
  }
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
