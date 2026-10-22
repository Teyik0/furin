import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Headless implementation of the documented SDK boundary, not of the Furin host. */
export async function installSdk(
  root: string,
  mode?: "hung-quit" | "failed-window" | "close-window" | "immediate-quit",
  options?: {
    channel?: string;
    metadataFromCwd?: boolean;
    handoff?: "reported" | "throw" | "cancelled";
  }
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
      webview = {
        on(name, callback) { if(name === "dom-ready") setTimeout(() => callback({}), 0); },
        setNavigationRules() {},
        executeJavascript(script) {
          require("node:fs").appendFileSync(${JSON.stringify(join(root, "test-scripts"))}, JSON.stringify(script)+"\\n", {mode:0o600});
        }
      };
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
    const cookies = new Map();
    export const Session = {
      fromPartition(partition) {
        return { cookies: { set(cookie) {
          require("node:fs").appendFileSync(${JSON.stringify(join(root, "native-cookies"))}, JSON.stringify({ partition, ...cookie })+"\\n", {mode:0o600});
          cookies.set(cookie.name, {...cookie, httpOnly: process.env.FURIN_FIXTURE_INSECURE_COOKIE ? false : cookie.httpOnly});
          return true;
        }, get(filter) { return [...cookies.values()].filter(cookie => cookie.name === filter.name); }, remove(url,name) { cookies.delete(name); return true; } } };
      }
    };
    export class Tray {
      visible = true; setMenu() {} on() {} remove() { this.visible = false; }
    }
    export const ApplicationMenu = { setApplicationMenu() {}, on() {} };
    export let quitting = false;
    export const Utils = {
      paths: { get appData() { return process.env.FIXTURE_APP_DATA ?? ${JSON.stringify(root)}; } },
      openExternal(url) {
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "browser-url"))}, url, {mode:0o600});
        return true;
      },
      openPath: () => true, showItemInFolder() {},
      openFileDialog: async () => [], showMessageBox: async (message) => {
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "error-dialog"))},JSON.stringify(message));
        return { response: 0 };
      },
      showNotification() {},
      quit(code) {
        const event = {};
        events.emit("before-quit", event);
        if (event.response?.allow === false) return false;
        quitting = true;
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "quit"))}, String(code));
        ${mode === "immediate-quit" ? "process.exit(code);" : ""}
        ${mode === "hung-quit" ? "setInterval(() => {}, 1000); return true;" : "setTimeout(() => process.exit(code), 0); return true;"}
      }
    };
    const info = { version: "", hash: "", updateAvailable: ${!!options?.handoff}, updateReady: ${!!options?.handoff}, error: "" };
    export const Updater = {
      async getLocalInfo() {
        ${
          options?.metadataFromCwd
            ? `
          events.emit("open-url", {data:{url:"fixture://early"}});
          return await Bun.file("../Resources/version.json").json();
        `
            : ""
        }
        const config = await Bun.file(generated + "/host.json").json();
        return { ...config.app, channel: ${JSON.stringify(options?.channel ?? "dev")} };
      },
      checkForUpdate: async () => info, downloadUpdate: async () => {},
      applyUpdate: async () => {
        ${options?.handoff === "throw" ? 'throw new Error("Native update helper failed");' : ""}
        ${options?.handoff === "reported" ? 'info.error="Native update helper failed";' : ""}
      },
      updateInfo: () => info, getStatusHistory: () => [],
      onStatusChange() {},
    };
  `
  );
  const projection = join(root, ".furin/electrobun/.hutch/devkit/api/sdks/main");
  await mkdir(projection, { recursive: true });
  await writeFile(
    join(root, ".furin/electrobun/.hutch/devkit/package.json"),
    '{"exports":{".":"./api/sdks/main/index.ts","./main":"./api/sdks/main/index.ts"}}'
  );
  await writeFile(
    join(projection, "index.ts"),
    `export * from ${JSON.stringify(join(directory, "main.ts"))};\nexport {default} from ${JSON.stringify(join(directory, "main.ts"))};\n`
  );
}

export function sdkRunHeader(root: string): string {
  return `
    if (process.argv[2] !== "run") process.exit(0);
    const generated = ${JSON.stringify(join(root, ".furin/electrobun"))};
    const config = (await import(generated + "/electrobun.config.ts")).default;
    await import(require("node:path").resolve(generated, config.build.bun.entrypoint));
    const sdk = await import(${JSON.stringify(join(root, "node_modules/electrobun/main.ts"))});
    // Native quit has been requested; do not start the mock launcher's next phase.
    if (sdk.quitting) await new Promise(() => {});
  `;
}
