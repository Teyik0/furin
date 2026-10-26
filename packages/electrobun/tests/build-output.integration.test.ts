import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOST_IMPORT = /from ("[^"]+standard-host\.ts")/;
const NATIVE_CLIENT_IMPORT =
  /electrobun\/(?:main|view)|node:|bun:|standard-host|startDesktopBackend/;

test("package build removes stale outputs and emits config and server exports", async () => {
  const packageRoot = join(import.meta.dir, "..");
  const root = await mkdtemp(join(packageRoot, ".build-output-"));
  try {
    await cp(join(packageRoot, "src"), join(root, "src"), { recursive: true });
    for (const name of ["build.ts", "prepare-sdk.ts", "tsconfig.json", "tsconfig.dts.json"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Copy the build inputs before invoking the build.
      await cp(join(packageRoot, name), join(root, name));
    }
    await cp(join(packageRoot, "../../tsconfig.base.json"), join(root, "base.json"));
    await writeFile(
      join(root, "tsconfig.json"),
      (await Bun.file(join(root, "tsconfig.json")).text()).replace(
        "../../tsconfig.base.json",
        "./base.json"
      )
    );
    await mkdir(join(root, "dist"));
    await Promise.all(
      ["removed.js", "removed.d.ts"].map((name) => writeFile(join(root, "dist", name), "stale"))
    );
    const child = Bun.spawn([process.execPath, "build.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`Package build failed (${code}):\n${stdout}\n${stderr}`);
    }
    for (const name of ["removed.js", "removed.d.ts"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify each stale output is absent.
      expect(await Bun.file(join(root, "dist", name)).exists()).toBe(false);
    }
    for (const name of [
      "config.js",
      "config.d.ts",
      "server.js",
      "server.d.ts",
      "client.js",
      "client.d.ts",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify each public output exists.
      expect(await Bun.file(join(root, "dist", name)).exists()).toBe(true);
    }
    const client = await Bun.file(join(root, "dist/client.js")).text();
    expect(client.startsWith('"use client";')).toBe(true);
    expect(client).not.toMatch(NATIVE_CLIENT_IMPORT);
    const browser = await Bun.build({
      entrypoints: [join(root, "dist/client.js")],
      target: "browser",
      external: ["react"],
    });
    expect(browser.success, browser.logs.join("\n")).toBe(true);
    // A consumer resolves original SDK types using the prepared export map.
    await writeFile(
      join(root, "consumer.ts"),
      `
      import { Elysia } from "elysia";
      import { desktopApp, desktopContext } from "./dist/server";
      import { useDesktop, type OpenBrowserResult } from "./dist/client";
      import type { BrowserWindow } from "electrobun/main";
      export function Download() {
        const desktop = useDesktop();
        const opened: Promise<OpenBrowserResult> = desktop.browser.open("/any-untyped-url");
        // @ts-expect-error Only the documented browser capability is exposed.
        desktop.browser.openPath("/private");
        // @ts-expect-error The command accepts URLs, not arbitrary transport payloads.
        desktop.browser.open({ command: "quit" });
        return opened;
      }
      const api = new Elysia().use(desktopContext)
        .decorate({
          access: { admit(_request: Request): Response | undefined { return; } },
          torrents: { settings: { runInBackground: true } },
        })
        .macro({
          nativeOnly: {
            derive({ desktop, status }) {
              if (!desktop) return status(409, { error: "Desktop unavailable" });
              return { desktop };
            },
          },
        })
        .get("/native", ({ desktop }) => {
        const window: BrowserWindow | undefined = desktop?.window;
        window?.minimize();
        return { available: desktop !== null };
      });
      export const app = new Elysia().use(api)
        .use(desktopApp({ window: { title: "Consumer", titleBarStyle: "hiddenInset" } }))
        .onStop(() => {});
      export const configured = new Elysia().use(api)
        .use(desktopApp(({ access, torrents }) => ({
          admission: access.admit.bind(access),
          background: () => torrents.settings.runInBackground === true,
        })))
        .onStop(() => {})
        .get("/after", { nativeOnly: true }, ({ desktop }) => {
          const window: BrowserWindow | undefined = desktop.window;
          return window !== undefined;
        });
      export const explicit = new Elysia().use(api)
        .use(parent => desktopApp(parent, ({ access }) => ({ admission: access.admit.bind(access) })))
        .onStop(() => {});
    `
    );
    await writeFile(
      join(root, "consumer.tsconfig.json"),
      JSON.stringify({
        extends: ["./base.json", "./.furin/sdk/tsconfig.json"],
        compilerOptions: { incremental: false, types: ["bun"] },
        files: ["consumer.ts"],
        include: [],
      })
    );
    const compiler = Bun.spawn(
      [process.execPath, "x", "--no-install", "tsc", "-p", "consumer.tsconfig.json"],
      { cwd: root, stdout: "pipe", stderr: "pipe" }
    );
    const [consumerCode, consumerOutput, consumerError] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ]);
    expect(consumerCode, consumerOutput + consumerError).toBe(0);
    expect(await Bun.file(join(root, "dist/capabilities.d.ts")).text()).toContain(
      'from "electrobun/main"'
    );
    expect(await Bun.file(join(root, "dist/capabilities.d.ts")).text()).not.toContain(root);
    // Built entrypoints bundle the generator: it must still find its shipped assets.
    const probe = await Bun.build({
      entrypoints: [join(root, "src/prepare.ts")],
      external: ["elysia", "elysia/*"],
      naming: "prepare-probe.js",
      outdir: join(root, "dist"),
      target: "bun",
    });
    expect(probe.success).toBe(true);
    const { prepareDesktop } = await import(join(root, "dist/prepare-probe.js"));
    const project = join(root, "project");
    await mkdir(project);
    const generated: string = await prepareDesktop(
      project,
      { app: { name: "Probe", identifier: "local.furin.probe", version: "1.0.0" } },
      { mode: "dev", root: project, serverEntry: join(project, "src/server.ts") }
    );
    expect(await Bun.file(join(generated, "runtime.ts")).exists()).toBe(true);
    expect(await Bun.file(join(generated, "desktop-bridge.ts")).exists()).toBe(true);
    const main = await Bun.file(join(generated, "main.ts")).text();
    // Throws when main.ts no longer imports the standard host.
    const [, host] = HOST_IMPORT.exec(main) as RegExpExecArray;
    expect(await Bun.file(JSON.parse(host as string)).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
