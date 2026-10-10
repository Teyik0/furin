import { runDesktopDevelopment } from "./dev";
import { isDesktopDevelopmentEntry } from "./project";

// A preload is the Bun launcher boundary, never an application import hook.
// The managed SDK imports the original app with this same bunfig configuration.
if (
  !process.env.FURIN_DESKTOP_DEV &&
  process.execArgv.includes("--hot") &&
  (await isDesktopDevelopmentEntry(process.cwd(), Bun.main))
) {
  const key: unique symbol = Symbol.for("@teyik0/furin/desktop-dev-launcher");
  const owner = globalThis as typeof globalThis & { [key]?: Promise<void> };
  // Bun hot reload retains the owner. Re-evaluation must not launch another SDK.
  owner[key] ??= Promise.resolve().then(() => runDesktopDevelopment(process.cwd(), true));
  try {
    await owner[key];
    // Never fall through and evaluate the source app in the launcher process.
    process.exit(0);
  } catch (error) {
    console.error(`[furin-electrobun] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
