import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopConfig } from "./config";
import { getDesktopDevelopment } from "./development";
import {
  type DesktopAppModule,
  type DesktopBackend,
  startDesktopBackend,
  withShutdownDeadline,
} from "./runtime";

interface NativeQuitEvent {
  response?: { allow: boolean };
}

export interface NativeHostSdk {
  default: {
    events: { on: (name: "before-quit", handler: (event: NativeQuitEvent) => void) => unknown };
  };
  Utils: { paths: { appData: string }; quit: (code: number) => void };
}

export interface DesktopHostContext<Sdk extends NativeHostSdk> {
  sdk: Sdk;
  startBackend: (options?: { dataDir?: string }) => Promise<{
    backend: DesktopBackend;
    module: DesktopAppModule;
  }>;
}

/** The caller supplies its canonical SDK; this module never imports a second SDK graph. */
export async function runDesktopHost<Sdk extends NativeHostSdk>(
  sdk: Sdk,
  setup: (context: DesktopHostContext<Sdk>) => void | Promise<void>
): Promise<void> {
  let pending: Promise<{ backend: DesktopBackend; module: DesktopAppModule }> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      let code = 0;
      try {
        await withShutdownDeadline(
          (async () => {
            if (pending) {
              await (await pending).backend.stop();
            }
          })()
        );
      } catch (error) {
        code = 1;
        throw error;
      } finally {
        sdk.Utils.quit(code);
      }
    })();
    return closing;
  };
  try {
    const development = await getDesktopDevelopment();
    const config: DesktopConfig =
      development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
    await setup({
      sdk,
      startBackend(options) {
        if (pending) {
          throw new Error("The native host already owns a backend.");
        }
        const dataDir =
          options?.dataDir ??
          config.dataDir ??
          join(sdk.Utils.paths.appData, config.app.identifier);
        if (!isAbsolute(dataDir)) {
          throw new Error("Native host dataDir must be absolute.");
        }
        const entry = development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js");
        pending = (async () => {
          let loaded: Promise<DesktopAppModule> | undefined;
          const load = () => {
            loaded ??= import(pathToFileURL(entry).href);
            return loaded;
          };
          const backend = await startDesktopBackend(load, dataDir, development ? "dev" : "build");
          return { backend, module: await load() };
        })();
        return pending;
      },
    });
    if (!pending) {
      throw new Error("The native host must call startBackend().");
    }
    const { backend } = await pending;
    sdk.default.events.on("before-quit", (event) => {
      if (closing || event.response?.allow === false) {
        return;
      }
      event.response = { allow: false };
      shutdown().catch(console.error);
    });
    if (development) {
      await development.ready(backend, shutdown);
    } else {
      const stop = () => {
        shutdown().catch(console.error);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
  } catch (error) {
    try {
      if (pending) {
        await withShutdownDeadline(
          pending.then(
            ({ backend }) => backend.stop(),
            (startupError: unknown) => {
              if (startupError !== error) {
                throw startupError;
              }
            }
          )
        );
      }
    } catch (cleanupError) {
      // biome-ignore lint/style/useErrorCause: Preserve both native setup and backend cleanup failures.
      throw new AggregateError([error, cleanupError], "Native host setup and cleanup failed.", {
        cause: error,
      });
    } finally {
      sdk.Utils.quit(1);
    }
    throw error;
  }
}
