import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopConfig } from "./config";
import { type DesktopAppModule, startDesktopBackend, withShutdownDeadline } from "./runtime";

export async function publishDevReady(
  path: string,
  ready: { origin: string; bootstrapOrigin: string; url: string }
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(ready), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  const settings: { config: DesktopConfig; serverEntry: string } = await Bun.file(
    join(import.meta.dir, "dev.json")
  ).json();
  const home = homedir();
  const xdg = process.env.XDG_DATA_HOME;
  let root = xdg && isAbsolute(xdg) ? xdg : join(home, ".local/share");
  if (process.platform === "darwin") {
    root = join(home, "Library/Application Support");
  } else if (process.platform === "win32") {
    root = process.env.LOCALAPPDATA ?? join(home, "AppData/Local");
  }
  const dataDir = settings.config.dataDir ?? join(root, settings.config.app.identifier);
  const backend = await startDesktopBackend(
    (): Promise<DesktopAppModule> => import(pathToFileURL(settings.serverEntry).href),
    dataDir,
    "dev"
  );
  const control = join(import.meta.dir, "control");
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(timer);
      let code = 0;
      try {
        await withShutdownDeadline(backend.stop());
      } catch (error) {
        console.error("[furin-electrobun] Dev shutdown failed:", error);
        code = 1;
      } finally {
        process.exit(code);
      }
    })();
    return closing;
  };
  process.on("SIGINT", () => {
    shutdown().catch(console.error);
  });
  process.on("SIGTERM", () => {
    shutdown().catch(console.error);
  });
  const timer = setInterval(() => {
    Bun.file(control)
      .text()
      .then((command) => {
        if (command) {
          return shutdown();
        }
      })
      .catch(console.error);
  }, 200);
  await publishDevReady(join(import.meta.dir, "ready.json"), {
    origin: backend.origin,
    bootstrapOrigin: backend.bootstrapOrigin,
    url: backend.url,
  });
  console.log("[furin-electrobun] dev", backend.origin, "data:", dataDir);
}
