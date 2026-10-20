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
import { defaultDesktopDataDir, resolveDesktopDataDir } from "./storage";

interface NativeQuitEvent {
  response?: { allow: boolean };
}

export interface NativeHostSdk {
  default: {
    events: { on: (name: "before-quit", handler: (event: NativeQuitEvent) => void) => unknown };
  };
  Updater?: { getLocalInfo: () => Promise<{ channel: string }> };
  Utils: { paths: { appData: string }; quit: (code: number) => void };
}

export interface DesktopHostContext<Sdk extends NativeHostSdk> {
  sdk: Sdk;
  startBackend: (options?: { dataDir?: string }) => Promise<{
    backend: DesktopBackend;
    module: DesktopAppModule;
  }>;
}

async function hostDataDir(
  policy: DesktopConfig["dataDir"],
  config: DesktopConfig,
  appData: string,
  identity: { channel: string } | undefined,
  development: Awaited<ReturnType<typeof getDesktopDevelopment>>
): Promise<string> {
  if (typeof policy === "object" && !identity) {
    throw new Error("Runtime dataDir policy requires the SDK Updater metadata.");
  }
  const dataDir =
    policy === undefined
      ? defaultDesktopDataDir(
          appData,
          config.app.identifier,
          identity?.channel ?? (development ? "dev" : "")
        )
      : await resolveDesktopDataDir(policy, {
          channel: identity?.channel ?? "",
          root: development?.root ?? dirname(Bun.main),
          mode: development ? "dev" : "build",
        });
  if (!isAbsolute(dataDir)) {
    throw new Error("Native host dataDir must be absolute.");
  }
  return dataDir;
}

/** The caller supplies its canonical SDK; this module never imports a second SDK graph. */
export async function runDesktopHost<Sdk extends NativeHostSdk>(
  sdk: Sdk,
  setup: (context: DesktopHostContext<Sdk>) => void | Promise<void>
): Promise<void> {
  let pending: Promise<{ backend: DesktopBackend; module: DesktopAppModule }> | undefined;
  let closing: Promise<void> | undefined;
  // Native quits stay vetoed until the backend has drained; only the final quit passes.
  let drained = false;
  const quit = (code: number) => {
    drained = true;
    sdk.Utils.quit(code);
  };
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
        quit(code);
      }
    })();
    return closing;
  };
  sdk.default.events.on("before-quit", (event) => {
    if (drained || (!closing && event.response?.allow === false)) {
      return;
    }
    event.response = { allow: false };
    shutdown().catch(console.error);
  });
  try {
    const identity = await sdk.Updater?.getLocalInfo();
    const development = await getDesktopDevelopment();
    const config: DesktopConfig =
      development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
    await setup({
      sdk,
      startBackend(options) {
        if (pending) {
          throw new Error("The native host already owns a backend.");
        }
        const entry = development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js");
        pending = (async () => {
          const dataDir = await hostDataDir(
            options?.dataDir ?? config.dataDir,
            config,
            sdk.Utils.paths.appData,
            identity,
            development
          );
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
      quit(1);
    }
    throw error;
  }
}
