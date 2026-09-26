let productionBuildScope: import("node:async_hooks").AsyncLocalStorage<boolean> | undefined;

export async function withProductionBuild<T>(build: () => Promise<T>): Promise<T> {
  productionBuildScope ??= new (await import("node:async_hooks")).AsyncLocalStorage<boolean>();
  return productionBuildScope.run(true, build);
}

export function isProductionBuild(): boolean {
  return productionBuildScope?.getStore() === true || process.env.NODE_ENV === "production";
}
