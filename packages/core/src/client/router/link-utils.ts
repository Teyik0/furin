import { buildSearchParams, type SearchParamsInput } from "../../shared/search-params.ts";
import type { CacheEntry } from "./types.ts";

const HASH_FRAGMENT_RE = /#.*$/;
/** Strips one or more trailing slashes — used by `buildDataEndpoint` in static mode. */
export const TRAILING_SLASHES_RE = /\/+$/;

export type NavigationHrefPolicy = "blocked" | "external" | "internal";

export function navigationHrefPolicy(
  href: string,
  currentOrigin: string | undefined
): NavigationHrefPolicy {
  for (let index = 0; index < href.length; index += 1) {
    const code = href.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return "blocked";
    }
  }
  let url: URL;
  try {
    url = new URL(href, currentOrigin ?? "http://localhost");
  } catch {
    return "blocked";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "blocked";
  }
  if (currentOrigin === undefined) {
    return href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")
      ? "external"
      : "internal";
  }
  return url.origin === currentOrigin ? "internal" : "external";
}

export function decodeHashFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function isSameOriginFetchResult(
  input: RequestInfo | URL,
  responseUrl: string,
  currentOrigin: string
): boolean {
  if (responseUrl.length === 0) {
    return false;
  }
  try {
    let inputUrl: string;
    if (typeof input === "string") {
      inputUrl = input;
    } else if (input instanceof URL) {
      inputUrl = input.href;
    } else {
      inputUrl = input.url;
    }
    return (
      new URL(inputUrl, currentOrigin).origin === currentOrigin &&
      new URL(responseUrl, currentOrigin).origin === currentOrigin
    );
  } catch {
    return false;
  }
}

/**
 * Substitutes typed path params into a route pattern: `/board/:boardId` with
 * `{ boardId: 42 }` → `/board/42`. The `*` wildcard segment (catch-all) is
 * replaced from `params["*"]`. Unknown segments are left untouched so
 * partially-applied patterns stay visible.
 *
 * @internal Exported for unit testing only.
 */
export function applyLinkParams(
  to: string,
  params: Record<string, string | number> | null | undefined
): string {
  if (!params) {
    return to;
  }
  let url = to.replaceAll(/:([a-zA-Z0-9_]+)/g, (match: string, name: string) =>
    name in params ? encodeURIComponent(String(params[name])) : match
  );
  const wildcard: string | number | undefined = params["*"];
  if (wildcard !== undefined && url.includes("/*")) {
    const encodedWildcard = String(wildcard).split("/").map(encodeURIComponent).join("/");
    url = url.replace("/*", () => `/${encodedWildcard}`);
  }
  return url;
}

/**
 * Builds a full href string from a pathname, optional search params, and optional hash.
 * Null/undefined search values are omitted.
 *
 * @internal Exported for unit testing only.
 */
export function buildHref(
  to: string,
  search: SearchParamsInput | null | undefined,
  hash: string | undefined,
  searchDefaults?: SearchParamsInput
): string {
  let url = to;
  if (search && Object.keys(search).length > 0) {
    const params = buildSearchParams(search, searchDefaults);
    const qs = params.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }
  if (hash) {
    url += `#${hash}`;
  }
  return url;
}

/**
 * Parses the `X-Furin-Revalidate` response header and calls `invalidate` for
 * each path entry. Header format: `"/path1,/path2:layout,/path3"`
 */
export function applyRevalidateHeader(
  headers: Headers,
  invalidate: (path: string, type: "page" | "layout" | undefined) => void
): void {
  const headerValue = headers.get("x-furin-revalidate");
  if (!headerValue) {
    return;
  }
  applyRevalidateEntries(headerValue.split(","), invalidate);
}

export function applyRevalidateEntries(
  entries: Iterable<string>,
  invalidate: (path: string, type: "page" | "layout" | undefined) => void
): void {
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.endsWith(":layout")) {
      invalidate(trimmed.slice(0, -":layout".length), "layout");
    } else {
      invalidate(trimmed, "page");
    }
  }
}

/**
 * Returns `true` when `currentPath` is targeted by at least one invalidation entry.
 *
 * @internal Exported for unit testing only.
 */
export function shouldAutoRefreshPath(
  currentPath: string,
  invalidations: ReadonlyArray<{ path: string; type: "page" | "layout" }>
): boolean {
  const normalizedCurrent = currentPath.split("?")[0] ?? currentPath;
  return invalidations.some(({ path, type }) => {
    if (type === "page") {
      return path === normalizedCurrent;
    }
    const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
    return normalizedCurrent === path || normalizedCurrent.startsWith(prefix);
  });
}

export function stripHashFromHref(href: string): string {
  return href.replace(HASH_FRAGMENT_RE, "");
}

/** Strips trailing slashes from a pathname or href. Root `/` is preserved.
 *  Query strings and hashes are preserved and re-attached after normalization. */
export function normalizeHref(href: string): string {
  const url = new URL(href, "http://localhost");
  let { pathname } = url;
  if (pathname !== "/") {
    pathname = pathname.replace(/\/+$/g, "");
  }
  return pathname + url.search + url.hash;
}

/** Strips a single trailing slash from a pathname. Root `/` and empty string are preserved. */
export function normalizePath(path: string): string {
  if (path === "/" || path === "") {
    return path;
  }
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** @internal Exported for unit testing only. */
export function shouldRefetch(entry: CacheEntry): boolean {
  return Date.now() - entry.createdAt > entry.staleTime;
}

/**
 * Decides whether a native `<a>` click should be intercepted and converted
 * to an SPA navigation. Returns the logical href to navigate to, or `null`
 * when the browser should handle the click normally.
 *
 * @internal Exported for unit testing only.
 */
export function shouldInterceptClick(
  anchor: { href: string; target: string; hasAttribute: (name: string) => boolean },
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  basePath: string,
  currentOrigin: string,
  currentPathname: string
): string | null {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }

  if (anchor.target && anchor.target !== "_self") {
    return null;
  }

  if (anchor.hasAttribute("download")) {
    return null;
  }

  const { href } = anchor;
  if (!href) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return null;
  }

  if (url.origin !== currentOrigin) {
    return null;
  }

  // Hash-only navigation on the same page — let the browser handle scrolling.
  if (normalizePath(url.pathname) === normalizePath(currentPathname) && url.hash) {
    return null;
  }

  const logicalPath = normalizeHref(toLogical(url.pathname, basePath));
  const normalizedBase = normalizePath(basePath);
  const normalizedPathname = normalizePath(url.pathname);
  if (
    normalizedBase &&
    normalizedPathname !== normalizedBase &&
    !normalizedPathname.startsWith(`${normalizedBase}/`)
  ) {
    return null;
  }
  return logicalPath + url.search + url.hash;
}

/** Strips basePath prefix from a physical pathname, returning the logical path. */
export function toLogical(physicalPathname: string, basePath: string): string {
  if (
    basePath &&
    physicalPathname.startsWith(basePath) &&
    // Require a path boundary after the prefix so "/furin" doesn't match "/furinity/foo"
    (physicalPathname.length === basePath.length || physicalPathname[basePath.length] === "/")
  ) {
    return physicalPathname.slice(basePath.length) || "/";
  }
  return physicalPathname;
}
