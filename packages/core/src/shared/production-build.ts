let productionBuildScope: import("node:async_hooks").AsyncLocalStorage<boolean> | undefined;
let productionBuildScopePromise:
  | Promise<import("node:async_hooks").AsyncLocalStorage<boolean>>
  | undefined;

export async function withProductionBuild<T>(build: () => Promise<T>): Promise<T> {
  productionBuildScopePromise ??= import("node:async_hooks").then(({ AsyncLocalStorage }) => {
    productionBuildScope = new AsyncLocalStorage<boolean>();
    return productionBuildScope;
  });
  const scope = await productionBuildScopePromise;
  return scope.run(true, build);
}

export function isProductionBuild(): boolean {
  return (
    productionBuildScope?.getStore() === true ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "production")
  );
}
