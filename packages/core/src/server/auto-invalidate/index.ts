// biome-ignore-all lint/performance/noBarrelFile: auto-invalidate has a small public/internal surface gathered for tests and furin.ts exports
export { furinInvalidate } from "./plugin.ts";
export { autoInvalidateRegistry } from "./registry.ts";
export { revalidateTag } from "./runtime.ts";
export type { InvalidationInput, InvalidationRule } from "./types.ts";
