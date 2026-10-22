import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserWindow } from "electrobun/main";
import type { RPCWithTransport } from "electrobun/main/rpc";
import { createAssociations } from "./associations";
import type {
  DesktopContext,
  DesktopIdentity,
  DesktopSnapshot,
  DesktopWindowOptions,
  NativeActionContext,
  OpenEvent,
} from "./capabilities";
import type { DesktopConfig } from "./config";
import { getDesktopDevelopment } from "./development";
import { deliverToNativeOwner, openNativeInstance } from "./native-instance";
import { armNativeRestart, nativeLauncherPath } from "./native-restart";
import type { DesktopSdk } from "./native-sdk";
import { nativeLaunchEvents } from "./open-events";
import {
  type DesktopMode,
  type DesktopState,
  getDesktopEntry,
  getDesktopState,
  setDesktopHost,
} from "./registry";
import {
  type DesktopAppModule,
  type DesktopBackend,
  getExternalUrl,
  startDesktopBackend,
  withShutdownDeadline,
} from "./runtime";
import { defaultDesktopDataDir, resolveDesktopDataDir } from "./storage";

export interface StandardHostOptions {
  config: DesktopConfig;
  dataDir: string;
  load: () => Promise<DesktopAppModule>;
  /** Application-owned trusted server manager; also used by the native menu and tray. */
  manager?: (
    context: NativeActionContext & { backend?: DesktopBackend; startupError?: string }
  ) => void | Promise<void>;
  mode: DesktopMode;
  /** Return true when an app-private native event was handled by the manager. */
  onOpen?: (context: NativeActionContext & { event: OpenEvent }) => boolean | Promise<boolean>;
  openBrowser?: boolean;
  root: string;
  /** A client-only host must not load the application module. */
  startServer?: boolean;
  /** Explicit opt-in only. The script executes on each new document's dom-ready. */
  testScript?: string;
}

const PARENT_PID = /^[1-9]\d*$/;

function object(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object";
}

async function resolveOptions(
  sdk: DesktopSdk,
  identity: DesktopIdentity,
  supplied: StandardHostOptions | undefined,
  development: Awaited<ReturnType<typeof getDesktopDevelopment>>
): Promise<StandardHostOptions> {
  const restartDirectory = process.env.FURIN_RESTART_DATA_DIR;
  delete process.env.FURIN_RESTART_DATA_DIR;
  if (supplied) {
    return { ...supplied, dataDir: restartDirectory ?? supplied.dataDir };
  }
  const config: DesktopConfig =
    development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
  const root = development?.root ?? dirname(Bun.main);
  const mode = development ? "dev" : "build";
  return {
    config,
    root,
    mode,
    dataDir:
      restartDirectory ??
      (config.dataDir === undefined
        ? defaultDesktopDataDir(sdk.Utils.paths.appData, config.app.identifier, identity.channel)
        : await resolveDesktopDataDir(config.dataDir, { root, mode, channel: identity.channel })),
    load: () =>
      import(
        pathToFileURL(development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js")).href
      ),
    openBrowser: !!development && process.env.FURIN_DEV_OPEN_BROWSER === "1",
    testScript: process.env.FURIN_NATIVE_TEST_SCRIPT
      ? await Bun.file(
          resolve(development?.root ?? process.cwd(), process.env.FURIN_NATIVE_TEST_SCRIPT)
        ).text()
      : undefined,
  };
}

async function forwardQueued(dataDir: string, identity: DesktopIdentity, queued: OpenEvent[]) {
  if (!queued.length) {
    if (!(await deliverToNativeOwner(dataDir, identity))) {
      throw new Error("The native instance is unavailable.");
    }
    return;
  }
  for (const event of queued) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserve ordering of OS-delivered native events.
    if (!(await deliverToNativeOwner(dataDir, identity, event))) {
      throw new Error("The native instance is unavailable.");
    }
  }
}

function installWindowSession(sdk: DesktopSdk, active: DesktopBackend): void {
  if (active.session) {
    const session = sdk.Session.fromPartition("persist:default");
    const cookie = {
      name: active.session.name,
      value: active.session.value,
      domain: "127.0.0.1",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict" as const,
    };
    if (!session.cookies.set(cookie)) {
      throw new Error("The native window session could not be installed.");
    }
    const installed = session.cookies
      .get({ name: cookie.name })
      .find((item) => item.value === cookie.value);
    if (
      !(
        installed?.httpOnly &&
        installed.secure &&
        installed.path === "/" &&
        installed.domain === "127.0.0.1" &&
        installed.sameSite?.toLowerCase() === "strict"
      )
    ) {
      session.cookies.remove(active.origin, cookie.name);
      throw new Error(
        "The native SDK cannot preserve HttpOnly, Secure, host-only and SameSite window cookies. Update the SDK before opening TLS windows."
      );
    }
  }
}

/** Composition of the public SDK, not a second native runtime or updater. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Startup coordinates the single SDK/controller owner and its failure cleanup in one scope.
export async function runStandardDesktopHost(
  sdk: DesktopSdk,
  supplied?: StandardHostOptions,
  loadNativeEntry?: () => Promise<unknown>
): Promise<DesktopContext | undefined> {
  const queued: OpenEvent[] = [];
  let flush = () => Promise.resolve();
  const capture = (event: unknown) => {
    if (!(object(event) && object(event.data)) || typeof event.data.url !== "string") {
      return;
    }
    try {
      const url = new URL(event.data.url);
      queued.push(
        url.protocol === "file:"
          ? { type: "file", path: fileURLToPath(url) }
          : { type: "url", url: url.href }
      );
      flush().catch(report("open"));
    } catch {
      console.error("[furin-electrobun] Invalid native open event.");
    }
  };
  // Subscribe before any asynchronous config, SDK metadata or application loading.
  sdk.default.events.on("open-url", capture);
  let phase: DesktopSnapshot["phase"] = "starting";
  let backend: DesktopBackend | undefined;
  let starting: Promise<DesktopBackend> | undefined;
  let instance: Awaited<ReturnType<typeof openNativeInstance>>;
  const lifetime = new AbortController();
  let failureCode = 0;
  let startupError: string | undefined;
  let state: DesktopState | undefined;
  let window: BrowserWindow | undefined;
  const windows = new Map<string, BrowserWindow>();
  let closing: Promise<void> | undefined;
  let installing: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  let quitRequested = false;
  let allowUpdateQuit = false;
  let identity: DesktopIdentity;
  let options: StandardHostOptions;
  let development: Awaited<ReturnType<typeof getDesktopDevelopment>>;
  const requireBackend = () => {
    if (!backend || phase !== "ready") {
      throw new Error("Desktop application is not ready.");
    }
    return backend;
  };
  // The console never prints error details: native events can carry OAuth URLs.
  const report = (operation: "open" | "action" | "updates" | "quit") => (_error: unknown) => {
    console.error(`[furin-electrobun] Native ${operation} failed.`);
  };
  const context = (): NativeActionContext => ({ identity, desktop });
  const createWindow = <T extends RPCWithTransport>(
    name: string,
    selected: DesktopWindowOptions<T>,
    path: string
  ): BrowserWindow<T> => {
    const active = requireBackend();
    if (windows.has(name)) {
      throw new Error(`Desktop window already exists: ${name}`);
    }
    let platform: "mac" | "win" | "linux" = "linux";
    if (process.platform === "darwin") {
      platform = "mac";
    }
    if (process.platform === "win32") {
      platform = "win";
    }
    const packaged = options.config.build?.[platform];
    const renderer = selected.renderer ?? packaged?.defaultRenderer ?? "native";
    if (renderer === "cef" && !packaged?.bundleCEF) {
      throw new Error(`CEF windows require build.${platform}.bundleCEF: true.`);
    }
    const origins = [active.origin, active.bootstrapOrigin].filter(Boolean);
    installWindowSession(sdk, active);
    const created = new sdk.BrowserWindow<T>({
      title: identity.name,
      ...selected,
      url: active.createWindowUrl(path),
      html: null,
      viewsRoot: null,
      renderer,
      sandbox: selected.sandbox ?? !selected.rpc,
      allowedProtocols: { views: false, appData: false },
      navigationRules: JSON.stringify(["^*", ...origins.map((origin) => `${origin}/*`)]),
    });
    const newWindowEvent = `new-window-open-${created.webviewId}`;
    windows.set(name, created);
    if (name === "main") {
      window = created;
    }
    created.on("close", () => {
      sdk.default.events.off?.(newWindowEvent, external);
      windows.delete(name);
      if (window === created) {
        window = undefined;
      }
      if (phase !== "ready" || options.manager || windows.size !== 0) {
        return;
      }
      try {
        if (state?.hooks?.background?.()) {
          return;
        }
      } catch (error) {
        report("action")(error);
      }
      desktop.quit().catch(report("quit"));
    });
    const external = (event: unknown) => {
      if (!(object(event) && object(event.data))) {
        return;
      }
      const url = getExternalUrl(event.data.detail, origins);
      if (url) {
        sdk.Utils.openExternal(url);
      }
    };
    created.webview?.on("will-navigate", external);
    sdk.default.events.on(newWindowEvent, external);
    if (options.testScript) {
      const script = options.testScript;
      created.webview?.on("dom-ready", () => created.webview?.executeJavascript(script));
    }
    return created;
  };
  const open = (): BrowserWindow => {
    requireBackend();
    if (window) {
      window.show();
      window.activate();
      return window;
    }
    return createWindow("main", state?.hooks?.window ?? {}, "/");
  };
  const closeWindows = () => {
    const failures: unknown[] = [];
    const attempt = (cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      attempt(() => {
        for (const tray of sdk.Tray.getAll()) {
          attempt(() => tray.remove());
        }
      });
      for (const owned of windows.values()) {
        attempt(() => owned.webview?.setNavigationRules(["^*"]));
        attempt(() => owned.close());
      }
    } finally {
      window = undefined;
      windows.clear();
      setDesktopHost(undefined);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Native window cleanup failed.");
    }
  };
  const quitNative = (code: number) => {
    const failures: unknown[] = [];
    let exitCode = code;
    try {
      closeWindows();
    } catch (error) {
      failures.push(error);
      exitCode = 1;
    }
    phase = "stopped";
    try {
      const result: unknown = sdk.Utils.quit(exitCode);
      quitRequested = result !== false;
    } catch (error) {
      process.exitCode = 1;
      failures.push(error);
    }
    if (failures.length) {
      development?.reportFailure("shutdown-failure");
      report("quit")(failures[0]);
      if (failures.length === 1) {
        throw failures[0];
      }
      throw new AggregateError(failures, "Native shutdown failed.");
    }
  };
  const desktop: DesktopContext = {
    get window() {
      return window;
    },
    open,
    windows: {
      get: (name) => windows.get(name),
      create(name, { path, ...selected }) {
        if (name === "main") {
          throw new Error("The main window is reserved; use desktop.open().");
        }
        return createWindow(name, selected, path);
      },
    },
    browser: {
      open(destination) {
        const active = requireBackend();
        // A system browser cannot receive a natively installed TLS window session.
        return !active.session && sdk.Utils.openExternal(active.createWindowUrl(destination));
      },
    },
    associations: {
      read: (target) => association.read(target),
      requestDefault: (target) => association.requestDefault(target),
    },
    updates: {
      install() {
        if (installing) {
          return installing;
        }
        if (!(backend || options.manager)) {
          throw new Error("Desktop application is not ready.");
        }
        if (!sdk.Updater.updateInfo().updateReady) {
          return Promise.reject(new Error("Download an update first."));
        }
        phase = "updating";
        if (state) {
          state.paused = true;
        }
        installing = (async () => {
          try {
            // The SDK may exit right after the handoff: drain the whole backend first.
            await backend?.stop();
            allowUpdateQuit = true;
            await sdk.Updater.applyUpdate();
            const info = sdk.Updater.updateInfo();
            if (info.error) {
              throw new Error(info.error);
            }
            if (sdk.Updater.getStatusHistory().at(-1)?.status !== "launching-new-version") {
              throw new Error("Native update handoff was cancelled.");
            }
            phase = "quitting";
          } catch (error) {
            allowUpdateQuit = false;
            try {
              await sdk.Utils.showMessageBox({
                type: "error",
                title: "Update failed",
                message: "The update could not be installed. The application will restart.",
                detail: error instanceof Error ? error.message : String(error),
                buttons: ["Restart application"],
                defaultId: 0,
                cancelId: 0,
              });
              allowUpdateQuit = true;
              await desktop.restart();
            } catch (restartError) {
              // biome-ignore lint/style/useErrorCause: Preserve both update and restart failures.
              throw new AggregateError(
                [error, restartError],
                "Update handoff and native restart failed.",
                { cause: error }
              );
            }
            throw error;
          } finally {
            installing = undefined;
          }
        })();
        return installing;
      },
    },
    snapshot: () => ({
      phase,
      background: !window,
      windows: windows.size,
      webviews: sdk.BrowserView.getAll().length,
      trayVisible: sdk.Tray.getAll().some((tray) => tray.visible),
    }),
    restart() {
      if (restarting) {
        return restarting;
      }
      if (!(backend || options.manager) || closing) {
        return Promise.reject(new Error("Desktop application cannot restart now."));
      }
      restarting = (async () => {
        phase = "restarting";
        let cancel: (() => void) | undefined;
        if (development) {
          development.requestRestart();
        } else {
          const launcher = nativeLauncherPath(Bun.main);
          const parent = process.env.ELECTROBUN_LAUNCHER_PID;
          const pids = [process.pid];
          if (parent && PARENT_PID.test(parent)) {
            pids.push(Number(parent));
          }
          const helper = await armNativeRestart(
            {
              launcher,
              cwd: dirname(launcher),
              pids,
              env: { ...process.env, FURIN_RESTART_DATA_DIR: options.dataDir },
            },
            join(dirname(Bun.main), "native-restart.js")
          );
          ({ cancel } = helper);
        }
        try {
          await desktop.quit();
        } catch (error) {
          if (!quitRequested) {
            cancel?.();
          }
          throw error;
        }
      })();
      return restarting;
    },
    quit() {
      if (installing && !allowUpdateQuit) {
        return Promise.reject(new Error("Native update in progress."));
      }
      closing ??= (async () => {
        phase = "quitting";
        lifetime.abort();
        let code = failureCode;
        try {
          await withShutdownDeadline(
            (async () => {
              if (starting && !backend) {
                await starting.catch((error: unknown) => {
                  if (error !== lifetime.signal.reason) {
                    throw error;
                  }
                });
              }
              await backend?.stop();
            })()
          );
        } catch (error) {
          code = 1;
          const timeout =
            error instanceof Error && error.message.includes("shutdown exceeded 5 seconds");
          development?.reportFailure(timeout ? "shutdown-timeout" : "shutdown-failure");
          if (timeout) {
            console.error("[furin-electrobun] Desktop shutdown exceeded 5 seconds.");
          }
          throw error;
        } finally {
          const backendCode = code;
          code = 1;
          try {
            await instance?.stop();
            code = backendCode;
          } finally {
            sdk.default.events.off?.("open-url", capture);
            sdk.default.events.off?.("reopen", reopen);
            sdk.default.events.off?.("before-quit", beforeQuit);
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            sdk.Updater.onStatusChange(null);
            queued.length = 0;
            quitNative(code);
          }
        }
        if (!quitRequested) {
          throw new Error("Native quit was vetoed; restart was cancelled.");
        }
      })();
      return closing;
    },
  };
  const reopen = () => {
    if (phase === "ready") {
      if (!backend && options.manager) {
        Promise.resolve()
          .then(() => options.manager?.({ ...context(), backend, startupError }))
          .catch(report("action"));
      } else {
        try {
          open();
        } catch (error) {
          report("open")(error);
        }
      }
    }
  };
  let association: ReturnType<typeof createAssociations>;
  const beforeQuit = (event: unknown) => {
    if (!object(event) || phase === "stopped" || allowUpdateQuit) {
      return;
    }
    event.response = { allow: false };
    if (!installing) {
      desktop.quit().catch(report("quit"));
    }
  };
  sdk.default.events.on("reopen", reopen);
  sdk.default.events.on("before-quit", beforeQuit);
  const stop = () => {
    desktop.quit().catch(report("quit"));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let flushing: Promise<void> | undefined;
  flush = () => {
    flushing ??= (async () => {
      while (phase === "ready" && queued.length) {
        const event = queued.shift();
        if (event) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: Deliver the next native event only after its predecessor settles.
            const handled = await options.onOpen?.({ ...context(), event });
            if (!handled) {
              await state?.hooks?.onOpen?.({ ...context(), event });
            }
          } catch (error) {
            report("open")(error);
          }
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };
  try {
    // SDK metadata resolves relative to native launch CWD and caches its result.
    identity = await sdk.Updater.getLocalInfo();
    development = await getDesktopDevelopment();
    options = await resolveOptions(sdk, identity, supplied, development);
    const { config } = options;
    lifetime.signal.throwIfAborted();
    if (identity.identifier !== config.app.identifier) {
      throw new Error("SDK identity does not match desktop configuration.");
    }
    if (!isAbsolute(options.dataDir)) {
      throw new Error("Native host dataDir must be absolute.");
    }
    association = createAssociations({
      identity,
      dataDir: options.dataDir,
      helper: join(dirname(Bun.main), "native-open.js"),
      openExternal: (url) => sdk.Utils.openExternal(url),
    });
    if (
      (config.protocols ?? []).some((scheme) => !(config.app?.urlSchemes ?? []).includes(scheme))
    ) {
      throw new Error("Registered protocols must also be declared in app.urlSchemes.");
    }
    const initial = process.env.FURIN_NATIVE_OPEN;
    delete process.env.FURIN_NATIVE_OPEN;
    if (initial) {
      capture({ data: { url: initial } });
    }
    queued.push(
      ...nativeLaunchEvents(
        Bun.argv.slice(2),
        config.app?.urlSchemes ?? [],
        config.app?.fileAssociations?.flatMap((item) =>
          item.ext.map((extension) => extension.toLowerCase())
        ) ?? [],
        options.root
      )
    );
    instance = await openNativeInstance({
      dataDir: options.dataDir,
      identity,
      schemes: config.app?.urlSchemes ?? [],
      extensions:
        config.app?.fileAssociations?.flatMap((item) =>
          item.ext.map((extension) => extension.toLowerCase())
        ) ?? [],
      onOpen(event) {
        queued.push(event);
        flush().catch(report("open"));
      },
      onActivate: reopen,
    });
    if (!instance) {
      await forwardQueued(options.dataDir, identity, queued);
      sdk.default.events.off?.("open-url", capture);
      sdk.default.events.off?.("reopen", reopen);
      sdk.default.events.off?.("before-quit", beforeQuit);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      phase = "stopped";
      sdk.Utils.quit(0);
      return;
    }
    await association.registerHandlers({
      protocols: config.protocols ?? [],
      schemes: config.app?.urlSchemes ?? [],
      files: (config.app?.fileAssociations ?? []).map((item) => ({
        name: item.name,
        extensions: item.ext,
        mimeType: item.mimeType,
      })),
    });
    setDesktopHost(desktop);
    if (options.startServer !== false) {
      try {
        starting = startDesktopBackend(
          async () => {
            const module = await options.load();
            state = module.default ? getDesktopState(module.default) : getDesktopEntry()?.state;
            await loadNativeEntry?.();
            return module;
          },
          options.dataDir,
          options.mode,
          { kind: "desktop", identity, desktop, signal: lifetime.signal }
        );
        backend = await starting;
      } catch (error) {
        if (!options.manager) {
          throw error;
        }
        startupError = error instanceof Error ? error.message : "The local server could not start.";
        starting = undefined;
      }
    }
    lifetime.signal.throwIfAborted();
    phase = "ready";
    await flush();
    await options.manager?.({ ...context(), backend, startupError });
    if (backend) {
      open();
    }
    if (options.openBrowser && backend) {
      desktop.browser.open();
    }
    if (development) {
      await development.ready(backend, desktop.quit);
    }
    return desktop;
  } catch (error) {
    const cancelled = !!closing && error === lifetime.signal.reason;
    if (!cancelled) {
      failureCode = 1;
      console.error("[furin-electrobun] Native startup failed:", error);
    }
    try {
      await desktop.quit();
    } catch (cleanup) {
      // biome-ignore lint/style/useErrorCause: Preserve both the original startup failure and cleanup failure.
      throw new AggregateError([error, cleanup], "Native startup and cleanup failed.", {
        cause: error,
      });
    }
    if (!cancelled) {
      throw error;
    }
  }
}
