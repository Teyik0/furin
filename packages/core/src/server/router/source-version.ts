import { developmentGraphs, devGraph } from "../dev/graph.ts";

export function routeModuleSourceVersion(path: string): string {
  const current = devGraph(undefined);
  // Bun's runtime plugin may lose the request scope while loading a transitive
  // import. Include the unscoped graph and graphs whose routes depend on this
  // source so an unrelated app's refresh cannot change its virtual identity.
  const relevant = developmentGraphs().filter((graph) => {
    const { snapshot } = graph;
    return (
      snapshot === null ||
      graph.dependsOn(snapshot.root.path, path) ||
      snapshot.routes.some((route) => graph.dependsOn(route.path, path))
    );
  });
  return String(
    Math.max(
      ...(relevant.length > 0 ? relevant : [current]).map((graph) =>
        Number(graph.sourceVersion(path))
      )
    )
  );
}

export function invalidateRouteModuleSourceVersions(): void {
  devGraph(undefined).invalidateModules();
}
