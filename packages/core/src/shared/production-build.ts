import { AsyncLocalStorage } from "node:async_hooks";

const productionBuildScope = new AsyncLocalStorage<boolean>();

export function withProductionBuild<T>(build: () => Promise<T>): Promise<T> {
  return productionBuildScope.run(true, build);
}

export function isProductionBuild(): boolean {
  return productionBuildScope.getStore() === true || process.env.NODE_ENV === "production";
}
