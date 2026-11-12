// biome-ignore-all lint/performance/noBarrelFile: Explicit public package entrypoint; implementation modules remain SDK/Elysia independent.

export type {
  ApplicationRuntime,
  DesktopContext,
  DesktopHost,
  DesktopIdentity,
  DesktopSnapshot,
  NativeActionContext,
  OpenEvent,
} from "./capabilities";
export { defineNative } from "./commands";
export { getDesktopDevelopment } from "./development";
export type { DesktopSdk } from "./native-sdk";
export { getDesktopHost } from "./registry";
export {
  type DesktopAppModule,
  type DesktopBackend,
  getExternalUrl,
  startDesktopBackend,
  withShutdownDeadline,
} from "./runtime";
export { type DataDirectoryContext, resolveDesktopDataDir } from "./storage";
