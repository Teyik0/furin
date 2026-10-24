import { expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { BrowserWindow } from "electrobun/main";
import type { RPCWithTransport } from "electrobun/main/rpc";
import { Elysia, status } from "elysia";
import type { DesktopContext } from "../src/capabilities";
import { getDesktopHost } from "../src/host";
import type { DesktopSdk } from "../src/native-sdk";
import { getDesktopState } from "../src/registry";
import { desktopApp, desktopContext } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";
import { installSdk } from "./fixtures/sdk";

test("managed windows keep SDK identity and independent APIs share the live controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-windows-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const identity = { name: "Fixture", identifier: "local.furin.windows", version: "1.0.0" };
  let desktop: DesktopContext | undefined;
  let failBackground = false;
  let backgroundReads = 0;
  // Declared before host installation: provider must resolve the live value later.
  const api = new Elysia().use(desktopContext).post("/minimize", ({ desktop: context }) => {
    if (!context) {
      return status(409, { error: "Desktop unavailable" });
    }
    context.window?.minimize();
    return { same: context === getDesktopHost(), ok: true };
  });
  expect(getDesktopState(api)).toBeUndefined();
  const app = new Elysia()
    .use(
      desktopApp({
        window: {
          title: "Principal",
          titleBarStyle: "hiddenInset",
          frame: { width: 902, height: 701 },
        },
        background: () => {
          backgroundReads += 1;
          if (failBackground) {
            throw new Error("Policy failed");
          }
          return true;
        },
      })
    )
    .use(api)
    .get("/options", () => "options");
  try {
    await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
    Object.defineProperty(sdk.Utils, "quit", { value: () => true });
    desktop = await runStandardDesktopHost(sdk, {
      config: { app: identity },
      dataDir: join(root, "data"),
      root,
      mode: "build",
      load: async () => ({ default: app }),
    });
    if (!desktop?.window) {
      throw new Error("Missing principal window");
    }
    expect(Object.is(desktop, getDesktopHost())).toBe(true);
    expect(desktop.window).toBeInstanceOf(sdk.BrowserWindow);
    expect(sdk.BrowserWindow.getById(desktop.window.id)).toBe(desktop.window);
    expect(desktop.windows.get("main")).toBe(desktop.window);
    const client = treaty(app);
    const response = await client.minimize.post();
    expectTypeOf(response.error).not.toBeAny();
    expect(response.data).toEqual({ same: true, ok: true });
    // SDK boundary fixture exposes constructor inputs without replacing any Furin method.
    const first = desktop.window as BrowserWindow & {
      minimized: boolean;
      options: { title: string; titleBarStyle: string; frame: { width: number }; url: string };
    };
    expect(first.minimized).toBe(true);
    expect(first.options.title).toBe("Principal");
    expect(first.options.titleBarStyle).toBe("hiddenInset");
    expect(first.options.frame.width).toBe(902);
    const options = desktop.windows.create("options", { path: "/options", title: "Options" });
    expect(options).toBeInstanceOf(sdk.BrowserWindow);
    expect(desktop.windows.get("options")).toBe(options);
    const { url } = (options as BrowserWindow & { options: { url: string } }).options;
    expect(url).not.toBe(first.options.url);
    const bootstrap = await fetch(url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(new URL(bootstrap.headers.get("location") ?? "").pathname).toBe("/options");
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(
      await (await fetch(bootstrap.headers.get("location") ?? "", { headers: { cookie } })).text()
    ).toBe("options");
    expect((await fetch(url, { redirect: "manual" })).status).toBe(410);
    expect(() => desktop?.windows.create("external", { path: "https://evil.test" })).toThrow(
      "origin"
    );
    first.close();
    expect(desktop.window).toBeUndefined();
    const reopened = desktop.open();
    expect(reopened).toBeInstanceOf(sdk.BrowserWindow);
    expect(reopened).not.toBe(first);
    expect(desktop.window).toBe(reopened);
    expect(desktop.open()).toBe(reopened);
    options.close();
    reopened.close();
    expect(backgroundReads).toBe(1);
    const last = desktop.open();
    failBackground = true;
    expect(() => last.close()).not.toThrow();
    expect(backgroundReads).toBe(2);
    await desktop.quit();
    expect(desktop.window).toBeUndefined();
    expect(desktop.windows.get("options")).toBeUndefined();
    expect(getDesktopHost()).toBeNull();
  } finally {
    await desktop?.quit();
    if (previous === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

// Compile-time assertion only: exact SDK RPC generics survive create without
// pretending a dynamic string lookup can recover an unrelated schema.
export function createTypedWindow<T extends RPCWithTransport>(
  desktop: DesktopContext,
  rpc: T,
  sdk: DesktopSdk
) {
  const window = desktop.windows.create("typed", { path: "/options", rpc });
  expectTypeOf(window).toEqualTypeOf<BrowserWindow<T>>();
  const original = new sdk.BrowserWindow({ rpc });
  expectTypeOf(original).toEqualTypeOf<BrowserWindow<T>>();
  const originalRpc: T | undefined = window.webview.rpc;
  return { window, originalRpc };
}

test("quit during async Elysia startup creates no window and cleans up once", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-window-cancel-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stops = 0;
  const app = new Elysia()
    .use(desktopApp({ window: { title: "Cancelled" } }))
    .onStart(async () => {
      entered.resolve();
      await release.promise;
    })
    .onStop(() => {
      stops += 1;
    });
  try {
    const identity = { name: "Fixture", identifier: "local.furin.cancel", version: "1.0.0" };
    await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
    Object.defineProperty(sdk.Utils, "quit", { value: () => true });
    const starting = runStandardDesktopHost(sdk, {
      config: { app: identity },
      dataDir: join(root, "data"),
      root,
      mode: "build",
      load: async () => ({ default: app }),
    });
    await entered.promise;
    const stopping = getDesktopHost()?.quit();
    await stopping;
    await starting;
    expect(stops).toBe(1);
    expect(await Bun.file(join(root, "window-url")).exists()).toBe(false);
    expect(getDesktopHost()).toBeNull();
  } finally {
    release.resolve();
    await app.stop(true);
    if (previous === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["tray", "fence", "main", "extra", "quit"] as const) {
  test(`native ${failure} cleanup failure still drains every managed object and quits once`, async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-cleanup-failure-"));
    const previous = process.env.FURIN_APP_DATA_DIR;
    const previousExitCode = process.exitCode;
    const identity = { name: "Fixture", identifier: "local.furin.cleanup", version: "1.0.0" };
    const attempts: string[] = [];
    const codes: number[] = [];
    let desktop: DesktopContext | undefined;
    const attempt = (name: string) => {
      attempts.push(name);
      if (name === failure) {
        throw new Error(`SDK ${name} failed`);
      }
    };
    try {
      await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
      await installSdk(root);
      const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
      Object.defineProperty(sdk.Utils, "quit", {
        value: (code: number) => {
          codes.push(code);
          attempt("quit");
          return true;
        },
      });
      desktop = await runStandardDesktopHost(sdk, {
        config: { app: identity },
        dataDir: join(root, "data"),
        root,
        mode: "build",
        load: async () => ({ default: new Elysia().use(desktopApp()).get("/", () => "ready") }),
      });
      if (!desktop?.window) {
        throw new Error("Missing main window");
      }
      const extra = desktop.windows.create("extra", { path: "/" });
      const tray = new sdk.Tray({ title: "Fixture", image: "" });
      const secondTray = new sdk.Tray({ title: "Second", image: "" });
      Object.defineProperty(sdk.Tray, "getAll", { value: () => [tray, secondTray] });
      Object.defineProperty(tray, "remove", { value: () => attempt("tray") });
      Object.defineProperty(secondTray, "remove", { value: () => attempt("second tray") });
      Object.defineProperty(desktop.window.webview, "setNavigationRules", {
        value: () => attempt("fence"),
      });
      Object.defineProperty(desktop.window, "close", { value: () => attempt("main") });
      Object.defineProperty(extra.webview, "setNavigationRules", {
        value: () => attempt("extra fence"),
      });
      Object.defineProperty(extra, "close", { value: () => attempt("extra") });
      await expect(desktop.quit()).rejects.toThrow(
        failure === "quit" ? "SDK quit failed" : "Native window cleanup failed"
      );
      expect(attempts).toEqual([
        "tray",
        "second tray",
        "fence",
        "main",
        "extra fence",
        "extra",
        "quit",
      ]);
      expect(codes).toEqual([failure === "quit" ? 0 : 1]);
      expect(desktop.window).toBeUndefined();
      expect(desktop.windows.get("main")).toBeUndefined();
      expect(desktop.windows.get("extra")).toBeUndefined();
      expect(getDesktopHost()).toBeNull();
      await expect(desktop.quit()).rejects.toThrow();
      expect(codes).toHaveLength(1);
      if (failure === "quit") {
        expect(process.exitCode).toBe(1);
      }
    } finally {
      await desktop?.quit().catch(() => undefined);
      process.exitCode = previousExitCode ?? 0;
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
