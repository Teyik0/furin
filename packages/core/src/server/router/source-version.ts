import { developmentGraphs, devGraph } from "../dev/graph.ts";
import { defaultInstanceBucket, scopedInstance } from "../instance.ts";

export function routeModuleSourceVersion(path: string): string {
  // Bun's runtime plugin loads modules outside any runtime scope. Use the
  // graphs whose routes depend on this source (or that have no snapshot yet)
  // so an unrelated app's refresh cannot change its virtual identity.
  const current = devGraph(scopedInstance() ?? defaultInstanceBucket());
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
