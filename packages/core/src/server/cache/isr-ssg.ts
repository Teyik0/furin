import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import { type Cache, createRouteCache, pathWithoutSearch } from "./route-cache";

export interface ISRCacheEntry {
  generatedAt: number;
  html: string;
  revalidate: number;
}

export interface SsgCacheEntry {
  cachedAt: number;
  html: string;
  /**
   * NDJSON payload identical in shape to what the live `/_furin/data` endpoint
   * emits. Persisted alongside the HTML by the static adapter so SPA navigation
   * on a static-hosted deployment can fetch loader data without going through
   * a runtime endpoint that does not exist on a file server.
   */
  ndjson: string;
  status: number;
  tags?: string[];
}

/** Maximum number of pre-rendered HTML entries (per mode) before LRU eviction. */
const MAX_HTML_CACHE_SIZE = 1000;

interface HtmlRouteCacheOptions<Entry> {
  onDelete?: (key: string, entry: Entry) => void;
}

/**
 * Builds the LRU cache backing one render mode's pre-rendered HTML. ISR and SSG
 * share the same eviction bound and the same `onDelete` hook — which keeps the
 * auto-invalidate path registry in sync — and differ only in entry shape and
 * the diagnostic `name`.
 */
export function createHtmlRouteCache<Entry>(
  mode: "isr" | "ssg",
  options?: HtmlRouteCacheOptions<Entry>
): Cache<Entry> {
  return createRouteCache<Entry>({
    maxSize: MAX_HTML_CACHE_SIZE,
    name: `render:${mode}-html`,
    onDelete: (key, entry) => {
      autoInvalidateRegistry.unregisterPath(key, `render:${mode}-html`);
      options?.onDelete?.(key, entry);
    },
    pathFromKey: pathWithoutSearch,
  });
}
