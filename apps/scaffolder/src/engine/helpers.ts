/**
 * Converts any string to kebab-case.
 * "My Cool App" → "my-cool-app"
 * "MyCoolApp"   → "my-cool-app"
 */
export function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2") // camelCase → camel-case
    .replace(/[\s_]+/g, "-") // spaces / underscores → dash
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") // strip non-alphanumeric
    .replace(/-{2,}/g, "-") // collapse multiple dashes
    .replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
}

/**
 * Converts any string to PascalCase.
 * "my-cool-app" → "MyCoolApp"
 */
export function toPascalCase(input: string): string {
  return toKebabCase(input)
    .split("-")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join("");
}

/**
 * Converts any string to camelCase.
 * "my-cool-app" → "myCoolApp"
 */
export function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Normalizes a package name for use in package.json "name" field.
 * Must be lowercase kebab-case and non-empty.
 */
export function normalizePackageName(input: string): string {
  const normalized = toKebabCase(input);
  if (!normalized) {
    throw new Error(`Cannot derive a valid package name from "${input}"`);
  }
  return normalized;
}
