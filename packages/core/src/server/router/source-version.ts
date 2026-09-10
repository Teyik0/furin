import { devGraph } from "../dev/graph.ts";

export function routeModuleSourceVersion(path: string): string {
  return devGraph(undefined).sourceVersion(path);
}

export function invalidateRouteModuleSourceVersions(): void {
  devGraph(undefined).invalidateModules();
}
