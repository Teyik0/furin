import type { SearchParamsInput } from "../../shared/search-params.ts";

export const SCROLL_STORAGE_KEY = "__furin_scroll__";

export function getHistoryKey(state: unknown): string | undefined {
  return (state as { _furinKey?: string } | null)?._furinKey;
}

/**
 * Search furin recorded for the page committed at a history entry: the
 * server-validated query, or the typed search an in-place commit was given.
 */
export function getHistorySearch(state: unknown): SearchParamsInput | undefined {
  return (state as { _furinSearch?: SearchParamsInput } | null)?._furinSearch;
}

export function generateHistoryKey(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function saveScrollPosition(key: string): void {
  try {
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    const positions: Record<string, number> = raw ? JSON.parse(raw) : {};
    positions[key] = window.scrollY;
    const keys = Object.keys(positions);
    if (keys.length > 50) {
      delete positions[keys[0] as string];
    }
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // sessionStorage unavailable (private mode, quota exceeded, etc.)
  }
}

/**
 * Returns `true` when the server reports a different build-id from the one
 * embedded in the initial HTML (`<meta name="furin-build-id">`).
 */
export function isStaleDeployResponse(res: Response): boolean {
  const serverBuildId = res.headers.get("x-furin-build-id");
  if (!serverBuildId) {
    return false;
  }
  const metaEl =
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLMetaElement>('meta[name="furin-build-id"]');
  const clientBuildId = metaEl?.content;
  return Boolean(clientBuildId && serverBuildId !== clientBuildId);
}
