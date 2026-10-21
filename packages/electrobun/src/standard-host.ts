import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAssociations } from "./associations";
import type {
  DesktopCapabilities,
  DesktopIdentity,
  DesktopSnapshot,
  NativeActionContext,
  NativeMenuItem,
  NativeOperation,
  NativeUpdateStatus,
  OpenEvent,
} from "./capabilities";
import type { DesktopConfig } from "./config";
import { getDesktopDevelopment } from "./development";
import { deliverToNativeOwner, openNativeInstance } from "./native-instance";
import { armNativeRestart, nativeLauncherPath } from "./native-restart";
import type { DesktopSdk, NativeTray, NativeWindow, SdkMenuItem } from "./native-sdk";
import { nativeLaunchEvents } from "./open-events";
import { type DesktopMode, type DesktopState, getDesktopEntry, getDesktopState } from "./registry";
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

function trayPlatform(): "mac" | "win" | "linux" {
  if (process.platform === "darwin") {
    return "mac";
  }
  if (process.platform === "win32") {
    return "win";
  }
  return "linux";
}

/** Composition of the public SDK, not a second native runtime or updater. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Startup coordinates the single SDK/controller owner and its failure cleanup in one scope.
export async function runStandardDesktopHost(
  sdk: DesktopSdk,
  supplied?: StandardHostOptions
): Promise<DesktopCapabilities | undefined> {
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
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  let failureCode = 0;
  let startupError: string | undefined;
  let state: DesktopState | undefined;
  let window: NativeWindow | undefined;
  let tray: NativeTray | undefined;
  let closing: Promise<void> | undefined;
  let installing: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  let quitRequested = false;
  let allowUpdateQuit = false;
  const actions = new Map<string, (context: NativeActionContext) => unknown>();
  const listeners = new Set<(status: NativeUpdateStatus) => void>();
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
  const report = (operation: NativeOperation) => (error: unknown) => {
    console.error(`[furin-electrobun] Native ${operation} failed.`);
    try {
      state?.hooks?.onError?.({ operation, error });
    } catch {
      console.error("[furin-electrobun] Native error reporting failed.");
    }
  };
  const context = (): NativeActionContext => ({ identity, desktop });
  const menus = (items: NativeMenuItem[]): SdkMenuItem[] =>
    items.map((item) => {
      if ("type" in item) {
        return { type: "divider" };
      }
      const { onSelect, submenu, ...fields } = item;
      if (onSelect && item.role) {
        throw new Error("A native menu item cannot combine a role and an action.");
      }
      let action: string | undefined;
      if (onSelect) {
        action = crypto.randomUUID();
        actions.set(action, onSelect);
      }
      return {
        ...fields,
        type: "normal",
        label: fields.label ?? "",
        ...(action ? { action } : {}),
        ...(submenu ? { submenu: menus(submenu) } : {}),
      };
    });
  const dispatch = (event: unknown) => {
    if (object(event) && object(event.data) && typeof event.data.action === "string") {
      const action = actions.get(event.data.action);
      if (action) {
        Promise.resolve()
          .then(() => action(context()))
          .catch(report("action"));
      }
    }
  };
  const open = (): DesktopSnapshot => {
    clearTimeout(backgroundTimer);
    const active = requireBackend();
    if (window) {
      window.show();
      window.activate();
      return desktop.snapshot();
    }
    const origins = [active.origin, active.bootstrapOrigin].filter(Boolean);
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
    const created = new sdk.BrowserWindow({
      title: identity.name,
      frame: options.config.window,
      url: active.createWindowUrl(),
      renderer: "native",
      sandbox: true,
      allowedProtocols: { views: false, appData: false },
      navigationRules: JSON.stringify(["^*", ...origins.map((origin) => `${origin}/*`)]),
    });
    const newWindowEvent = `new-window-open-${created.webviewId}`;
    window = created;
    created.on("close", () => {
      sdk.default.events.off?.(newWindowEvent, external);
      if (window !== created) {
        return;
      }
      window = undefined;
      if (
        phase === "ready" &&
        !options.manager &&
        !(state?.hooks?.background?.() && tray?.visible)
      ) {
        desktop.quit().catch(report("quit"));
      }
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
    return desktop.snapshot();
  };
  const desktop: DesktopCapabilities = {
    window: {
      open,
      async background() {
        requireBackend();
        if (!state?.hooks?.background?.()) {
          throw new Error("Enable background mode first.");
        }
        if (!tray?.visible) {
          throw new Error("The system tray is unavailable; the window stays open.");
        }
        // Do not destroy the view before its HTTP action response can be delivered.
        const target = window;
        backgroundTimer = setTimeout(() => {
          if (window === target && phase === "ready") {
            target?.requestClose();
          }
        }, 100);
        await Promise.resolve();
      },
    },
    browser: {
      open(destination) {
        const active = requireBackend();
        // A system browser cannot receive a natively installed TLS window session.
        return !active.session && sdk.Utils.openExternal(active.createWindowUrl(destination));
      },
    },
    shell: {
      openExternal: (url) => sdk.Utils.openExternal(url),
      openPath: (path) => sdk.Utils.openPath(path),
      showItemInFolder: (path) => sdk.Utils.showItemInFolder(path),
    },
    dialogs: {
      async selectDirectory(selected) {
        const paths = await sdk.Utils.openFileDialog({
          ...selected,
          canChooseDirectory: true,
          canChooseFiles: false,
          allowsMultipleSelection: false,
        });
        return paths[0] ?? null;
      },
      message: (message) => sdk.Utils.showMessageBox(message),
    },
    notifications: { show: (notification) => sdk.Utils.showNotification(notification) },
    associations: {
      read: (target) => association.read(target),
      requestDefault: (target) => association.requestDefault(target),
    },
    updates: {
      check: () => sdk.Updater.checkForUpdate(),
      download: () => sdk.Updater.downloadUpdate(),
      snapshot: () => sdk.Updater.updateInfo(),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
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
      windows: window ? 1 : 0,
      webviews: sdk.BrowserView.getAll().length,
      trayVisible: tray?.visible ?? false,
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
          clearTimeout(backgroundTimer);
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
            listeners.clear();
            actions.clear();
            queued.length = 0;
            tray?.remove();
            const previous = window;
            window = undefined;
            previous?.webview?.setNavigationRules(["^*"]);
            previous?.close();
            phase = "stopped";
            const result = sdk.Utils.quit(code);
            quitRequested = result !== false;
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
        // biome-ignore lint/complexity/noVoid: The native event does not await a manager callback.
        void options.manager({ ...context(), backend, startupError });
      } else {
        open();
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
    const { config, root } = options;
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
      (config.protocols ?? []).some(
        (scheme) => !(config.sdk?.app?.urlSchemes ?? []).includes(scheme)
      )
    ) {
      throw new Error("Registered protocols must also be declared in sdk.app.urlSchemes.");
    }
    const initial = process.env.FURIN_NATIVE_OPEN;
    delete process.env.FURIN_NATIVE_OPEN;
    if (initial) {
      capture({ data: { url: initial } });
    }
    queued.push(
      ...nativeLaunchEvents(
        Bun.argv.slice(2),
        config.sdk?.app?.urlSchemes ?? [],
        config.sdk?.app?.fileAssociations?.flatMap((item) =>
          item.ext.map((extension) => extension.toLowerCase())
        ) ?? [],
        options.root
      )
    );
    instance = await openNativeInstance({
      dataDir: options.dataDir,
      identity,
      schemes: config.sdk?.app?.urlSchemes ?? [],
      extensions:
        config.sdk?.app?.fileAssociations?.flatMap((item) =>
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
      schemes: config.sdk?.app?.urlSchemes ?? [],
      files: (config.sdk?.app?.fileAssociations ?? []).map((item) => ({
        name: item.name,
        extensions: item.ext,
        mimeType: item.mimeType,
      })),
    });
    sdk.Updater.onStatusChange((status) => {
      for (const listener of listeners) {
        try {
          listener(status);
        } catch (error) {
          report("updates")(error);
        }
      }
    });
    if (options.startServer !== false) {
      try {
        starting = startDesktopBackend(
          async () => {
            const module = await options.load();
            state = module.default ? getDesktopState(module.default) : getDesktopEntry()?.state;
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
    const image = config.tray?.[trayPlatform()];
    if (image) {
      tray = new sdk.Tray({
        image: resolve(
          options.mode === "dev" ? root : join(dirname(Bun.main), "../furin"),
          image.image
        ),
        template: "template" in image && image.template === true,
        title: identity.channel === "dev" ? "DEV" : "",
        width: 18,
        height: 18,
      });
      tray.setMenu(
        menus([
          ...(options.manager
            ? [{ label: "Servers…", onSelect: () => options.manager?.({ ...context(), backend }) }]
            : []),
          ...((backend ? state?.hooks?.tray?.(context()) : undefined) ?? [
            { label: `Open ${identity.name}`, onSelect: () => open() },
            { label: "Open in browser", onSelect: () => desktop.browser.open() },
            { type: "divider" },
            { label: `Quit ${identity.name}`, onSelect: () => desktop.quit() },
          ]),
        ])
      );
      tray.on("tray-clicked", dispatch);
    }
    if (process.platform !== "linux") {
      sdk.ApplicationMenu.setApplicationMenu(
        menus([
          ...(options.manager
            ? [
                {
                  label: "Servers",
                  submenu: [
                    {
                      label: "Servers…",
                      accelerator: "CmdOrCtrl+Shift+S",
                      onSelect: () => options.manager?.({ ...context(), backend }),
                    },
                  ],
                },
              ]
            : []),
          ...((backend ? state?.hooks?.menus?.(context()) : undefined) ?? [
            {
              label: identity.name,
              submenu: [{ role: "about" }, { type: "divider" }, { role: "quit" }],
            },
            {
              label: "Edit",
              submenu: ["undo", "redo", "cut", "copy", "paste", "selectAll"].map((role) => ({
                role,
              })),
            },
          ]),
        ])
      );
      sdk.ApplicationMenu.on("application-menu-clicked", dispatch);
    }
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
