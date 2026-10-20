import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { DesktopSdk, NativeWindow } from "../src/native-sdk";
import { desktopApp } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";

test("standard host lifecycle and successful update handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-standard-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const events = new Map<string, ((event: unknown) => void)[]>();
  const emit = (name: string, event: unknown) => {
    for (const handler of events.get(name) ?? []) {
      handler(event);
    }
  };
  const windows: { url: string; window: NativeWindow }[] = [];
  const closed = Promise.withResolvers<void>();
  const phases: string[] = [];
  const scripts: string[] = [];
  const documents: (() => void)[] = [];
  const browserUrls: string[] = [];
  const errors: { operation: string; message: string }[] = [];
  let background = true;
  let quit: number | undefined;
  let authenticated: { origin: string; cookie: string } | undefined;
  const identity = {
    name: "Fixture",
    identifier: "local.furin.standard",
    channel: "dev",
    version: "1.0.0",
  };
  const info = {
    version: "1.1.0",
    hash: "new",
    updateAvailable: true,
    updateReady: true,
    error: "",
  };
  const sdk: DesktopSdk = {
    default: {
      events: {
        on(name, callback) {
          const handlers = events.get(name) ?? [];
          handlers.push(callback);
          events.set(name, handlers);
        },
        off(name, callback) {
          events.set(
            name,
            (events.get(name) ?? []).filter((fn) => fn !== callback)
          );
        },
      },
    },
    BrowserWindow: class {
      webviewId = windows.length + 1;
      private closeHandler: (() => void) | undefined;
      webview = {
        on(name: string, callback: (event: unknown) => void) {
          if (name === "dom-ready") {
            documents.push(() => callback({}));
          }
        },
        executeJavascript(script: string) {
          scripts.push(script);
        },
        setNavigationRules() {
          /* Headless SDK: no native navigation surface. */
        },
      };
      constructor(options: { url: string }) {
        expect(phases).toContain("ready");
        windows.push({ url: options.url, window: this });
      }
      on(_name: "close", callback: () => void) {
        this.closeHandler = callback;
      }
      show() {
        /* Headless SDK window. */
      }
      activate() {
        /* Headless SDK window. */
      }
      close() {
        this.closeHandler?.();
        closed.resolve();
      }
      requestClose() {
        this.close();
      }
    },
    BrowserView: { getAll: () => [] },
    Session: {
      fromPartition: () => ({ cookies: { set: () => true, get: () => [], remove: () => true } }),
    },
    Tray: class {
      visible = true;
      setMenu() {
        /* No native tray in this SDK boundary fixture. */
      }
      on() {
        /* No native tray in this SDK boundary fixture. */
      }
      remove() {
        this.visible = false;
      }
    },
    ApplicationMenu: { setApplicationMenu: () => undefined, on: () => undefined },
    Utils: {
      paths: { appData: root },
      openExternal(url) {
        browserUrls.push(url);
        return true;
      },
      openPath: () => true,
      showItemInFolder: () => undefined,
      openFileDialog: async () => [root],
      showMessageBox: async () => ({ response: 0 }),
      showNotification: () => undefined,
      quit(code) {
        quit = code;
      },
    },
    Updater: {
      getLocalInfo() {
        emit("open-url", { data: { url: "fixture://early" } });
        return Promise.resolve(identity);
      },
      checkForUpdate: async () => info,
      downloadUpdate: () => Promise.resolve(),
      async applyUpdate() {
        const event: { response?: { allow: boolean } } = {};
        emit("before-quit", event);
        expect(event.response?.allow).not.toBe(false);
        if (!authenticated) {
          throw new Error("Missing session");
        }
        // The backend has fully drained before the SDK hands off to the new version.
        await expect(
          fetch(authenticated.origin, { headers: { cookie: authenticated.cookie } })
        ).rejects.toThrow();
      },
      updateInfo: () => info,
      getStatusHistory: () => [
        { status: "launching-new-version", message: "Handoff", timestamp: Date.now() },
      ],
      onStatusChange: () => undefined,
    },
  };
  const app = new Elysia()
    .use(
      desktopApp({
        async onStartup({ runtime }) {
          expect(runtime.kind).toBe("desktop");
          if (runtime.kind === "desktop") {
            expect(await runtime.desktop.dialogs.selectDirectory()).toBe(root);
          }
          phases.push("start");
        },
        onReady() {
          phases.push("ready");
        },
        onShutdown() {
          phases.push("stop");
        },
        background: () => background,
        onOpen({ event }) {
          if (event.type === "url" && event.url === "fixture://broken") {
            throw new Error("broken open");
          }
          phases.push(event.type === "url" ? event.url : event.path);
        },
        onError({ operation, error }) {
          errors.push({ operation, message: error instanceof Error ? error.message : "" });
        },
      })
    )
    .get("/", () => "private")
    .onStop(() => {
      phases.push("elysia-stop");
    });
  let desktop: Awaited<ReturnType<typeof runStandardDesktopHost>> | undefined;
  try {
    desktop = await runStandardDesktopHost(sdk, {
      config: {
        app: identity,
        window: { width: 800, height: 600 },
        tray: {
          mac: { image: "icon.png" },
          win: { image: "icon.png" },
          linux: { image: "icon.png" },
        },
      },
      root,
      dataDir: root,
      mode: "build",
      load: async () => ({
        default: app,
        onShutdown() {
          phases.push("module-stop");
        },
      }),
      testScript: "explicit native test",
      openBrowser: true,
    });
    if (!desktop) {
      throw new Error("Expected the primary native instance.");
    }
    expect(typeof desktop.restart).toBe("function");
    expect(phases).toEqual(["start", "ready", "fixture://early"]);
    emit("open-url", { data: { url: "fixture://broken" } });
    await Bun.sleep(10);
    expect(errors).toEqual([{ operation: "open", message: "broken open" }]);
    documents[0]?.();
    expect(scripts).toEqual(["explicit native test"]);
    const [first] = windows;
    if (!first) {
      throw new Error("No native window");
    }
    const initial = await fetch(first.url, { redirect: "manual" });
    expect(initial.status).toBe(303);
    authenticated = {
      origin: new URL(initial.headers.get("location") ?? "").origin,
      cookie: initial.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
    expect((await fetch(authenticated.origin)).status).toBe(403);
    {
      expect(browserUrls).toHaveLength(1);
      const [url] = browserUrls;
      if (!url) {
        throw new Error("Browser did not open.");
      }
      expect(url).not.toBe(first.url);
      const browser = await fetch(url, { redirect: "manual" });
      expect(browser.status).toBe(303);
      expect(new URL(browser.headers.get("location") ?? "").origin).toBe(authenticated.origin);
      const cookie = browser.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toBe(authenticated.cookie);
      expect(await (await fetch(authenticated.origin, { headers: { cookie } })).text()).toBe(
        "private"
      );
      expect((await fetch(url, { redirect: "manual" })).status).toBe(410);
    }
    await desktop.window.background();
    await closed.promise;
    expect(desktop.snapshot().background).toBe(true);
    desktop.window.open();
    documents[1]?.();
    expect(scripts).toEqual(["explicit native test", "explicit native test"]);
    expect(windows).toHaveLength(2);
    expect(windows[1]?.url).not.toBe(first.url);
    background = false;
    await expect(desktop.window.background()).rejects.toThrow("background");
    await desktop.updates.install();
    expect(desktop.snapshot().phase).toBe("quitting");
    // The handoff itself drains the whole backend; the SDK may exit without another quit.
    expect(phases.slice(-3).toSorted()).toEqual(["elysia-stop", "module-stop", "stop"]);
    await expect(fetch(authenticated.origin)).rejects.toThrow();
    await desktop.quit();
    expect(quit).toBe(0);
    expect(phases.filter((phase) => phase === "stop")).toHaveLength(1);
  } finally {
    try {
      await desktop?.quit();
    } finally {
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
});
