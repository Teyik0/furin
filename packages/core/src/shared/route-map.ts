export interface RouteMapEntry {
  importSpecifier: string;
  pattern: string;
}

function routeTypeProperty(pattern: string): string {
  const segments = pattern.split("/");
  const isDynamicSegment = (segment: string): boolean => segment.startsWith(":") || segment === "*";
  if (!segments.some(isDynamicSegment)) {
    return JSON.stringify(pattern);
  }
  const template = segments
    .map((segment) => {
      if (isDynamicSegment(segment)) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: emits TypeScript syntax
        return "${string}";
      }
      return segment.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
    })
    .join("/");
  return `[path: \`${template}\`]`;
}

export function routeMapDeclaration(entries: RouteMapEntry[]): string {
  const body = entries
    .toSorted((left, right) => left.pattern.localeCompare(right.pattern))
    .map(
      (entry) =>
        `    ${routeTypeProperty(entry.pattern)}: typeof import(${JSON.stringify(entry.importSpecifier)}).route;`
    )
    .join("\n");
  return `declare module "@teyik0/furin/routes" {
  interface RouteMap {
${body}
  }
}`;
}
