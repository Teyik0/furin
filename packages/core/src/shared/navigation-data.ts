/**
 * SPA navigation fetches a page's loader data from the page URL itself with
 * `?_furin=data` appended. Being part of the URL, the marker gives documents
 * and data payloads distinct HTTP cache keys on every CDN, without `Vary`.
 * The server strips it before routing, so guards, schemas, loaders and render
 * caches all see the page URL.
 *
 * Both sides edit the query textually so the page's own parameters keep their
 * exact encoding (and therefore their cache keys).
 */
const NAVIGATION_DATA_TOKEN = "_furin=data";

/** Appends the navigation data marker to a page href without a fragment. */
export function navigationDataHref(href: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}${NAVIGATION_DATA_TOKEN}`;
}

/**
 * The search string without the navigation data marker, or `undefined` when
 * the request carries no marker.
 */
export function stripNavigationDataSearch(search: string): string | undefined {
  const entries = search.slice(1).split("&");
  const kept = entries.filter((entry) => entry !== NAVIGATION_DATA_TOKEN);
  if (kept.length === entries.length) {
    return;
  }
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}
