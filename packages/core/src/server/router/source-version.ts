import { statSync } from "node:fs";

let routeModuleGeneration = 0;

export function routeModuleSourceVersion(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return Bun.hash(`${stats.mtimeNs}:${stats.size}:${routeModuleGeneration}`).toString();
  } catch {
    return Bun.hash(`missing:${routeModuleGeneration}`).toString();
  }
}

export function invalidateRouteModuleSourceVersions(): void {
  routeModuleGeneration += 1;
}
