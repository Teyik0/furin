import { join } from "node:path";
import { publishDevReady } from "./dev-server";
import { type DesktopBackend, withShutdownDeadline } from "./runtime";

/** Available only to a custom host launched by the desktop dev supervisor. */
export async function getDesktopDevelopment() {
  const settings = process.env.FURIN_DESKTOP_DEV;
  if (!settings) {
    return;
  }
  const { root, serverEntry }: { root: string; serverEntry: string } =
    await Bun.file(settings).json();
  const directory = join(settings, "..");
  // Call after loading the SDK, which resolves native resources from its launch CWD.
  process.chdir(root);
  return {
    serverEntry,
    async ready(backend: DesktopBackend, shutdown: () => Promise<void>) {
      let closing: Promise<void> | undefined;
      const stop = () => {
        closing ??= withShutdownDeadline(shutdown()).finally(() => clearInterval(timer));
        closing.catch((error) => {
          console.error("[furin-electrobun] Custom dev shutdown failed:", error);
          process.exit(1);
        });
      };
      const timer = setInterval(() => {
        Bun.file(join(directory, "control"))
          .text()
          .then((command) => {
            if (command) {
              stop();
            }
          })
          .catch(console.error);
      }, 100);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await publishDevReady(join(directory, "ready.json"), {
        origin: backend.origin,
        bootstrapOrigin: backend.bootstrapOrigin,
        url: backend.url,
      });
    },
  };
}
