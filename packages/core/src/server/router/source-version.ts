import { developmentGraphs, devGraph } from "../dev/graph.ts";
import { defaultInstanceBucket, scopedInstance } from "../instance.ts";

export function routeModuleSourceVersion(path: string): string {
  // Bun's runtime plugin loads modules outside any runtime scope. Use the
  // graphs whose routes depend on this source (or that have no snapshot yet).
  // A version only advances when the source or a recorded dependency changes,
  // so an unchanged module keeps one ESM identity for every importer.
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
