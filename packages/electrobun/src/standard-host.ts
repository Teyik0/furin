import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAssociations } from "./associations";
import type {
  DesktopCapabilities,
  DesktopIdentity,
  DesktopSnapshot,
  NativeActionContext,
  NativeMenuItem,
  NativeUpdateStatus,
  OpenEvent,
} from "./capabilities";
import type { DesktopConfig } from "./config";
import { getDesktopDevelopment } from "./development";
import { forwardNativeOpen, openNativeInstance } from "./native-instance";
import type { DesktopSdk, NativeTray, NativeWindow, SdkMenuItem } from "./native-sdk";
import { nativeLaunchEvents } from "./open-events";
import { type DesktopMode, type DesktopState, getDesktopState } from "./registry";
import {
  type DesktopAppModule,
  type DesktopBackend,
  getExternalUrl,
  startDesktopBackend,
  withShutdownDeadline,
  withStartupDeadline,
} from "./runtime";

export interface StandardHostOptions {
  config: DesktopConfig;
  dataDir: string;
  load: () => Promise<DesktopAppModule>;
  mode: DesktopMode;
  openBrowser?: boolean;
  root: string;
  /** Explicit opt-in only. The script executes on each new document's dom-ready. */
  testScript?: string;
}

function object(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object";
}

async function resolveOptions(
  sdk: DesktopSdk,
  supplied: StandardHostOptions | undefined,
  development: Awaited<ReturnType<typeof getDesktopDevelopment>>
): Promise<StandardHostOptions> {
  if (supplied) {
    return supplied;
  }
  const config: DesktopConfig =
    development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
  return {
    config,
    root: development?.root ?? dirname(Bun.main),
    mode: development ? "dev" : "build",
    dataDir: config.dataDir ?? join(sdk.Utils.paths.appData, config.app.identifier),
    load: () =>
      import(
        pathToFileURL(development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js")).href
      ),
    openBrowser: !!development && process.env.FURIN_DEV_OPEN_BROWSER === "1",
    testScript: process.env.FURIN_NATIVE_TEST_SCRIPT
      ? await Bun.file(process.env.FURIN_NATIVE_TEST_SCRIPT).text()
      : undefined,
  };
}

async function forwardQueued(dataDir: string, identity: DesktopIdentity, queued: OpenEvent[]) {
  if (!queued.length) {
    if (!(await forwardNativeOpen(dataDir, identity))) {
      throw new Error("The native instance is unavailable.");
    }
    return;
  }
  for (const event of queued) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserve ordering of OS-delivered native events.
    if (!(await forwardNativeOpen(dataDir, identity, event))) {
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
      flush().catch(report);
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
  let state: DesktopState | undefined;
  let window: NativeWindow | undefined;
  let tray: NativeTray | undefined;
  let closing: Promise<void> | undefined;
  let installing: Promise<void> | undefined;
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
  const report = () => console.error("[furin-electrobun] Native action failed.");
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
          .catch(report);
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
    const origins = [active.origin, active.bootstrapOrigin];
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
      if (phase === "ready" && !(state?.hooks?.background?.() && tray?.visible)) {
        desktop.quit().catch(report);
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
      open: (destination) => sdk.Utils.openExternal(requireBackend().createWindowUrl(destination)),
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
        const active = requireBackend();
        if (!sdk.Updater.updateInfo().updateReady) {
          return Promise.reject(new Error("Download an update first."));
        }
        phase = "updating";
        if (state) {
          state.paused = true;
        }
        installing = (async () => {
          try {
            await withShutdownDeadline(state?.stop() ?? Promise.resolve());
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
            phase = "recovering";
            try {
              await withStartupDeadline(state?.recover?.(active) ?? Promise.resolve());
              phase = "ready";
              await flush();
            } catch (recovery) {
              await withShutdownDeadline(state?.stop() ?? Promise.resolve());
              // biome-ignore lint/style/useErrorCause: Preserve both handoff and recovery failures, with handoff as the primary cause.
              throw new AggregateError(
                [error, recovery],
                "Update handoff and service recovery failed.",
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
                  if (!(error instanceof DOMException && error.name === "AbortError")) {
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
          await instance?.stop();
          sdk.default.events.off?.("open-url", capture);
          sdk.default.events.off?.("reopen", reopen);
          sdk.default.events.off?.("before-quit", beforeQuit);
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
          sdk.Utils.quit(code);
        }
      })();
      return closing;
    },
  };
  const reopen = () => {
    if (phase === "ready") {
      open();
    }
  };
  let association: ReturnType<typeof createAssociations>;
  const beforeQuit = (event: unknown) => {
    if (!object(event) || phase === "stopped" || allowUpdateQuit) {
      return;
    }
    event.response = { allow: false };
    if (!installing) {
      desktop.quit().catch(report);
    }
  };
  sdk.default.events.on("reopen", reopen);
  sdk.default.events.on("before-quit", beforeQuit);
  let flushing: Promise<void> | undefined;
  flush = () => {
    flushing ??= (async () => {
      while (phase === "ready" && queued.length) {
        const event = queued.shift();
        if (event) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: Deliver the next native event only after its predecessor settles.
            await state?.hooks?.onOpen?.({ ...context(), event });
          } catch {
            report();
          }
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };
  try {
    development = supplied ? undefined : await getDesktopDevelopment();
    options = await resolveOptions(sdk, supplied, development);
    const { config, root } = options;
    identity = await sdk.Updater.getLocalInfo();
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
        flush().catch(report);
      },
      onActivate: reopen,
    });
    if (!instance) {
      await forwardQueued(options.dataDir, identity, queued);
      sdk.default.events.off?.("open-url", capture);
      sdk.default.events.off?.("reopen", reopen);
      sdk.default.events.off?.("before-quit", beforeQuit);
      phase = "stopped";
      sdk.Utils.quit(0);
      return;
    }
    await association.registerProtocols(config.protocols ?? []);
    sdk.Updater.onStatusChange((status) => {
      for (const listener of listeners) {
        try {
          listener(status);
        } catch {
          report();
        }
      }
    });
    starting = startDesktopBackend(
      async () => {
        const module = await options.load();
        state = getDesktopState(module.default);
        return module;
      },
      options.dataDir,
      options.mode,
      { kind: "desktop", identity, desktop, signal: lifetime.signal }
    );
    backend = await starting;
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
        menus(
          state?.hooks?.tray?.(context()) ?? [
            { label: `Open ${identity.name}`, onSelect: () => open() },
            { label: "Open in browser", onSelect: () => desktop.browser.open() },
            { type: "divider" },
            { label: `Quit ${identity.name}`, onSelect: () => desktop.quit() },
          ]
        )
      );
      tray.on("tray-clicked", dispatch);
    }
    if (process.platform !== "linux") {
      sdk.ApplicationMenu.setApplicationMenu(
        menus(
          state?.hooks?.menus?.(context()) ?? [
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
          ]
        )
      );
      sdk.ApplicationMenu.on("application-menu-clicked", dispatch);
    }
    phase = "ready";
    await flush();
    open();
    if (options.openBrowser) {
      desktop.browser.open();
    }
    if (development) {
      await development.ready(backend, desktop.quit);
    }
    return desktop;
  } catch (error) {
    failureCode = 1;
    try {
      await desktop.quit();
    } catch (cleanup) {
      // biome-ignore lint/style/useErrorCause: Preserve both the original startup failure and cleanup failure.
      throw new AggregateError([error, cleanup], "Native startup and cleanup failed.", {
        cause: error,
      });
    }
    throw error;
  }
}
