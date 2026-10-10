import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { DesktopSdk, NativeWindow } from "../src/native-sdk";
import { desktopApp } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";

test.each(["success", "reported", "throw", "cancelled"] as const)(
  "standard host lifecycle and update handoff: %s",
  async (handoff) => {
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
          expect(
            (await fetch(authenticated.origin, { headers: { cookie: authenticated.cookie } }))
              .status
          ).toBe(503);
          if (handoff === "throw") {
            throw new Error("Helper failed");
          }
          if (handoff === "reported") {
            info.error = "Helper failed";
          }
        },
        updateInfo: () => info,
        getStatusHistory: () =>
          handoff === "cancelled"
            ? []
            : [{ status: "launching-new-version", message: "Handoff", timestamp: Date.now() }],
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
            phases.push(event.type === "url" ? event.url : event.path);
          },
        })
      )
      .get("/", () => "private");
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
        load: async () => ({ default: app }),
        testScript: handoff === "success" ? "explicit native test" : undefined,
        openBrowser: handoff === "success",
      });
      if (!desktop) {
        throw new Error("Expected the primary native instance.");
      }
      expect(phases).toEqual(["start", "ready", "fixture://early"]);
      documents[0]?.();
      expect(scripts).toEqual(handoff === "success" ? ["explicit native test"] : []);
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
      if (handoff === "success") {
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
      } else {
        expect(browserUrls).toEqual([]);
      }
      await desktop.window.background();
      await closed.promise;
      expect(desktop.snapshot().background).toBe(true);
      desktop.window.open();
      documents[1]?.();
      expect(scripts).toEqual(
        handoff === "success" ? ["explicit native test", "explicit native test"] : []
      );
      expect(windows).toHaveLength(2);
      expect(windows[1]?.url).not.toBe(first.url);
      background = false;
      await expect(desktop.window.background()).rejects.toThrow("background");
      if (handoff === "success") {
        await desktop.updates.install();
        expect(desktop.snapshot().phase).toBe("quitting");
      } else {
        await expect(desktop.updates.install()).rejects.toThrow(
          handoff === "cancelled" ? "cancelled" : "Helper failed"
        );
        expect(desktop.snapshot().phase).toBe("ready");
        expect(
          (await fetch(authenticated.origin, { headers: { cookie: authenticated.cookie } })).status
        ).toBe(200);
        expect(phases.filter((phase) => phase === "start")).toHaveLength(2);
        expect(phases.filter((phase) => phase === "ready")).toHaveLength(2);
      }
      await desktop.quit();
      expect(quit).toBe(0);
      expect(phases.filter((phase) => phase === "stop")).toHaveLength(
        handoff === "success" ? 1 : 2
      );
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
  }
);
