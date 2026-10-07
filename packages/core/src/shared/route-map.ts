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

function compareRouteProperties(left: RouteMapEntry, right: RouteMapEntry): number {
  const leftProperty = routeTypeProperty(left.pattern);
  const rightProperty = routeTypeProperty(right.pattern);
  if (leftProperty === rightProperty) {
    return 0;
  }
  return leftProperty < rightProperty ? -1 : 1;
}

export function routeMapDeclaration(entries: RouteMapEntry[]): string {
  const sorted = entries.toSorted(compareRouteProperties);
  const properties = new Map<string, Set<string>>();
  for (const entry of sorted) {
    const property = routeTypeProperty(entry.pattern);
    const types = properties.get(property) ?? new Set<string>();
    types.add(`typeof import(${JSON.stringify(entry.importSpecifier)}).route`);
    properties.set(property, types);
  }
  const body = [...properties]
    .map(([property, types]) => `    ${property}: ${[...types].join(" | ")};`)
    .join("\n");
  const patterns = sorted
    .map(
      (entry) =>
        `    ${JSON.stringify(entry.pattern)}: typeof import(${JSON.stringify(entry.importSpecifier)}).route;`
    )
    .join("\n");
  return `declare module "@teyik0/furin/routes" {
  interface RouteMap {
${body}
  }

  interface RoutePatternMap {
${patterns}
  }
}`;
}
