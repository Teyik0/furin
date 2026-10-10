import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Headless implementation of the documented SDK boundary, not of the Furin host. */
export async function installSdk(
  root: string,
  mode?: "hung-quit" | "failed-window" | "close-window"
) {
  const directory = join(root, "node_modules/electrobun");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "electrobun",
      version: "2.0.2",
      exports: { "./package.json": "./package.json", "./main": "./main.ts" },
    })
  );
  await writeFile(
    join(directory, "main.ts"),
    `
    const generated = ${JSON.stringify(join(root, ".furin/electrobun"))};
    const handlers = new Map();
    const events = {
      on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
      off(name, fn) { handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== fn)); },
      emit(name, event) { for (const fn of handlers.get(name) ?? []) fn(event); }
    };
    export default { events };
    const views = new Set();
    export class BrowserWindow {
      webviewId = views.size + 1;
      closed;
      webview = { on() {}, setNavigationRules() {}, executeJavascript() {} };
      constructor(options) {
        ${mode === "failed-window" ? 'throw new Error("constructor failed");' : ""}
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "window-url"))}, options.url, {mode:0o600});
        views.add(this);
      }
      on(name, handler) {
        if (name === "close") {
          this.closed = handler;
          ${mode === "close-window" ? "setTimeout(() => this.close(), 10);" : ""}
        }
      }
      show() {}
      activate() {}
      close() {
        views.delete(this);
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "window-closed"))}, "closed");
        this.closed?.();
      }
      requestClose() { this.close(); }
    }
    export const BrowserView = { getAll: () => [...views] };
    export class Tray {
      visible = true; setMenu() {} on() {} remove() { this.visible = false; }
    }
    export const ApplicationMenu = { setApplicationMenu() {}, on() {} };
    export const Utils = {
      paths: { appData: ${JSON.stringify(root)} },
      openExternal(url) {
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "browser-url"))}, url, {mode:0o600});
        return true;
      },
      openPath: () => true, showItemInFolder() {},
      openFileDialog: async () => [], showMessageBox: async () => ({ response: 0 }),
      showNotification() {},
      quit(code) {
        const event = {};
        events.emit("before-quit", event);
        if (event.response?.allow === false) return false;
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "quit"))}, String(code));
        ${mode === "hung-quit" ? "setInterval(() => {}, 1000); return true;" : "setTimeout(() => process.exit(code), 0); return true;"}
      }
    };
    const info = { version: "", hash: "", updateAvailable: false, updateReady: false, error: "" };
    export const Updater = {
      async getLocalInfo() {
        const config = await Bun.file(generated + "/host.json").json();
        return { ...config.app, channel: "dev" };
      },
      checkForUpdate: async () => info, downloadUpdate: async () => {},
      applyUpdate: async () => {}, updateInfo: () => info, getStatusHistory: () => [],
      onStatusChange() {},
    };
  `
  );
}

export function sdkRunHeader(root: string): string {
  return `
    if (process.argv[2] !== "run") process.exit(0);
    const generated = ${JSON.stringify(join(root, ".furin/electrobun"))};
    const config = (await import(generated + "/electrobun.config.ts")).default;
    await import(require("node:path").resolve(generated, config.build.bun.entrypoint));
    const sdk = await import(${JSON.stringify(join(root, "node_modules/electrobun/main.ts"))});
  `;
}
