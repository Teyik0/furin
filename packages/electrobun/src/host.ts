// biome-ignore-all lint/performance/noBarrelFile: Explicit public package entrypoint; implementation modules remain SDK/Elysia independent.

export type {
  ApplicationRuntime,
  DesktopCapabilities,
  DesktopIdentity,
  DesktopSnapshot,
  NativeActionContext,
  NativeMenuItem,
  OpenEvent,
  ReadyContext,
  StartupContext,
} from "./capabilities";
export { getDesktopDevelopment } from "./development";
export type { DesktopSdk } from "./native-sdk";
export { type DesktopHostContext, type NativeHostSdk, runDesktopHost } from "./run-host";
export {
  type DesktopAppModule,
  type DesktopBackend,
  getExternalUrl,
  startDesktopBackend,
  withShutdownDeadline,
} from "./runtime";
export { runStandardDesktopHost, type StandardHostOptions } from "./standard-host";
