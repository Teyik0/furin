import { developmentGraphs, devGraph } from "../dev/graph.ts";

export function routeModuleSourceVersion(path: string): string {
  const current = devGraph(undefined);
  // Bun's runtime plugin may lose the request scope while loading a transitive
  // import. Every development graph records those imports, so use the newest
  // revision across them to keep the virtual module identity consistent.
  return String(
    Math.max(
      ...[...new Set([current, ...developmentGraphs()])].map((graph) =>
        Number(graph.sourceVersion(path))
      )
    )
  );
}

export function invalidateRouteModuleSourceVersions(): void {
  for (const graph of new Set([devGraph(undefined), ...developmentGraphs()])) {
    graph.invalidateModules();
  }
}
