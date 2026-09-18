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
  return prefix.slice(1).replaceAll("/", "-");
}

/**
 * `prefixSlug` is NOT injective: `/a-b` and `/a/b` both slug to `a-b`, so two
 * distinct prefixes can claim the same client dir and silently overwrite each
 * other's build output. A readable injective encoding is ambiguous anyway
 * (escaping `-` as `--` still confuses `/a-/b` with `/a/-b`), so we detect the
 * collision and fail fast instead.
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
