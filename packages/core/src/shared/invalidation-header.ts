const PATH_DELIMITERS_RE = /[,:?#]/g;

/** Escape the path before appending the protocol's optional layout marker. */
export function encodeInvalidationEntry(path: string, type: "page" | "layout"): string {
  const encoded = encodeURI(path.toWellFormed()).replace(
    PATH_DELIMITERS_RE,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return type === "layout" ? `${encoded}:layout` : encoded;
}

export function decodeInvalidationEntry(entry: string): { path: string; type: "page" | "layout" } {
  const trimmed = entry.trim();
  const type = trimmed.endsWith(":layout") ? "layout" : "page";
  const path = type === "layout" ? trimmed.slice(0, -":layout".length) : trimmed;
  try {
    return { path: decodeURIComponent(path), type };
  } catch {
    return { path, type };
  }
}

/**
 * Whether an invalidation of `path` covers `urlPath`: a page invalidation
 * covers the path itself, a layout invalidation also every path below it.
 */
export function isInvalidatedPath(urlPath: string, path: string, type: "page" | "layout"): boolean {
  if (type === "page") {
    return urlPath === path;
  }
  const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
  return urlPath === path || urlPath.startsWith(prefix);
}

/** Entries have already escaped their paths separately from the type marker. */
export function serializeInvalidationPaths(paths: readonly string[]): string {
  return paths.join(",");
}
