// biome-ignore lint/performance/noBarrelFile: This is the package's explicit public host capability entrypoint.
export {
  type DesktopAppModule,
  type DesktopBackend,
  getExternalUrl,
  startDesktopBackend,
  withShutdownDeadline,
} from "./runtime";
