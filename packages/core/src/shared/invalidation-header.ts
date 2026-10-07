/** Preserve the existing comma-delimited protocol while escaping arbitrary paths. */
export function serializeInvalidationPaths(paths: readonly string[]): string {
  return paths.map((path) => encodeURI(path).replaceAll(",", "%2C")).join(",");
}
