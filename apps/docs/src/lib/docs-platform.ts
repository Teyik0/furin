// Kept apart from the navigation data so layout code that only needs the
// platform does not ship every page description in the initial bundle.
export type DocsPlatform = "web" | "desktop";

const DOCS_PATH_END_RE = /[?#].*$/;

export function getDocsPlatform(pathname: string): DocsPlatform {
  const path = pathname.replace(DOCS_PATH_END_RE, "");
  return path === "/docs/desktop" || path.startsWith("/docs/desktop/") ? "desktop" : "web";
}
