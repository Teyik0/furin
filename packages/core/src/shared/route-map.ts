export interface RouteMapEntry {
  importSpecifier: string;
  pattern: string;
}

/** Code-unit order: stable across runs, platforms and locales. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Declares one `RouteMap` entry per exact route pattern. Concrete paths
 * (`/weather/paris`) are resolved against these patterns by the client types,
 * so the declaration never needs overlapping index signatures.
 */
export function routeMapDeclaration(entries: RouteMapEntry[]): string {
  const specifiers = new Map<string, Set<string>>();
  for (const entry of entries) {
    const patternSpecifiers = specifiers.get(entry.pattern) ?? new Set<string>();
    patternSpecifiers.add(entry.importSpecifier);
    specifiers.set(entry.pattern, patternSpecifiers);
  }
  const body = [...specifiers.keys()]
    .toSorted(compareCodeUnits)
    .map((pattern) => {
      const types = [...(specifiers.get(pattern) ?? [])]
        .toSorted(compareCodeUnits)
        .map((specifier) => `typeof import(${JSON.stringify(specifier)}).route`);
      return `    ${JSON.stringify(pattern)}: ${types.join(" | ")};`;
    })
    .join("\n");
  return `declare module "@teyik0/furin/routes" {
  interface RouteMap {
${body}
  }
}`;
}
