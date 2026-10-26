import { desktopCommand } from "./cli";

/** Optional addon entrypoint loaded by the core CLI only for desktop projects. */
export function runDesktopDevelopment(cwd: string, openBrowser: boolean): Promise<void> {
  return desktopCommand("dev", cwd, undefined, { openBrowser });
}
