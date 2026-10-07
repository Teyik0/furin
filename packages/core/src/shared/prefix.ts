// Naming helpers shared between the runtime (furin.ts) and the build
// pipeline (adapter/bun.ts) — both must agree on where a mounted app's
// client assets live on disk.

/**
 * On-disk client dir name for a mounted app: the root instance keeps the
 * historical `client/`, prefixed instances get `client-<slug>/` next to it.
 */
export function clientDirNameForPrefix(prefix: string): string {
  return prefix === "" ? "client" : `client-${prefixSlug(prefix)}`;
}

/** Canonical deployed path, shared by routing, PPR state and cache invalidation. */
export function physicalPath(prefix: string, path: string): string {
  if (prefix === "") {
    return path;
  }
  return path === "/" ? prefix : `${prefix}${path}`;
}

/** Filesystem-safe slug for a mount prefix (`/admin/v2` → `admin-v2`). */
export function prefixSlug(prefix: string): string {
  return prefix
    .slice(1)
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("-", "%2D").replaceAll(".", "%2E"))
    .join("-");
}

/**
 * Validate generated directory identities before writing any artifacts.
 */
export function assertNoPrefixSlugCollisions(prefixes: string[]): void {
  const byDirName = new Map<string, string>();
  for (const prefix of prefixes) {
    const dirName = clientDirNameForPrefix(prefix);
    const existing = byDirName.get(dirName);
    if (existing !== undefined && existing !== prefix) {
      throw new Error(
        `[furin] prefixes "${existing}" and "${prefix}" both map to the client directory ` +
          `"${dirName}" — rename one of them so their slugs (\`/\` → \`-\`) no longer collide.`
      );
    }
    byDirName.set(dirName, prefix);
  }
}
