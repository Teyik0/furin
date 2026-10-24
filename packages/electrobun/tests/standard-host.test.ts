import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow } from "electrobun/main";
import { Elysia } from "elysia";
import { forwardNativeOpen } from "../src/native-instance";
import type { DesktopSdk } from "../src/native-sdk";
import { desktopApp, getApplicationRuntime } from "../src/server";
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
  const windows: { url: string; window: BrowserWindow }[] = [];
  const closed = Promise.withResolvers<void>();
  const phases: string[] = [];
  const scripts: string[] = [];
  const documents: (() => void)[] = [];
  const browserUrls: string[] = [];
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
  const sdk = {
    default: {
      events: {
        events: { app: { openUrl: (data: { url: string }) => ({ name: "open-url", data }) } },
        emitEvent(event: { name: string; data: { url: string } }) {
          emit(event.name, event);
        },
        on(name: string, callback: (event: unknown) => void) {
          const handlers = events.get(name) ?? [];
          handlers.push(callback);
          events.set(name, handlers);
        },
        off(name: string, callback: (event: unknown) => void) {
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
        windows.push({ url: options.url, window: this as unknown as BrowserWindow });
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
      static getAll() {
        return [];
      }
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
      openExternal(url: string) {
        browserUrls.push(url);
        return true;
      },
      openPath: () => true,
      showItemInFolder: () => undefined,
      openFileDialog: async () => [root],
      showMessageBox: async () => ({ response: 0 }),
      showNotification: () => undefined,
      quit(code: number) {
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
  } as unknown as DesktopSdk;
  const app = new Elysia()
    .use(
      desktopApp({
        background: () => background,
      })
    )
    .onStart((instance) => {
      const runtime = getApplicationRuntime(instance);
      expect(runtime.kind).toBe("desktop");
      phases.push("start");
      expect(windows).toHaveLength(0);
      phases.push("ready");
    })
    .onStop(() => {
      phases.push("stop");
    })
    .get("/", () => "private")
    .onStop(() => {
      phases.push("elysia-stop");
    });
  let desktop: Awaited<ReturnType<typeof runStandardDesktopHost>> | undefined;
  try {
    desktop = await runStandardDesktopHost(
      sdk,
      {
        config: {
          app: { ...identity, fileAssociations: [{ name: "Fixture", ext: ["tofu"] }] },
        },
        root,
        dataDir: root,
        mode: "build",
        load: async () => ({
          default: app.onStop(() => {
            phases.push("module-stop");
          }),
        }),
        testScript: "explicit native test",
        openBrowser: true,
      },
      () => {
        expect(phases).toEqual([]);
        sdk.default.events.on("open-url", (event: { data: { url: string } }) => {
          phases.push(event.data.url);
        });
        return Promise.resolve();
      }
    );
    if (!desktop) {
      throw new Error("Expected the primary native instance.");
    }
    expect(typeof desktop.restart).toBe("function");
    expect(phases).toEqual(["start", "ready"]);
    emit("open-url", { data: { url: "fixture://native" } });
    expect(phases).toEqual(["start", "ready", "fixture://native"]);
    await Bun.sleep(0);
    expect(phases).toEqual(["start", "ready", "fixture://native"]);
    const path = join(root, "Some file.tofu");
    expect(await forwardNativeOpen(root, identity, { type: "file", path })).toBe(true);
    expect(phases.at(-1)).toBe(pathToFileURL(path).href);
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
    desktop.window?.requestClose();
    await closed.promise;
    expect(desktop.snapshot().background).toBe(true);
    desktop.open();
    documents[1]?.();
    expect(scripts).toEqual(["explicit native test", "explicit native test"]);
    expect(windows).toHaveLength(2);
    expect(windows[1]?.url).not.toBe(first.url);
    background = false;
    expect(desktop.window).toBe(windows.at(1)?.window);
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
