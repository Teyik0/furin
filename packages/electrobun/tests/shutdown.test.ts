import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";

test("generated SDK host closes the window and quits with failure when cleanup hangs", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-shutdown-"));
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  try {
    const output = join(root, ".furin/build/bun");
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "app.js"),
      `
      import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
      export default createDesktopApp().get("/", () => "ready");
      export function onShutdown() {
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      }
    `
    );
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
        window: { width: 800, height: 600 },
        dataDir: join(root, "data"),
      },
      { mode: "build", root, serverEntry: join(root, "server.ts") }
    );
    // A native SDK window cannot be launched by a child test. These fixtures
    // implement its public close-event/close/quit boundary, not backend cleanup.
    const entries = join(generated, ".hutch/devkit/api/sdks/main/entries");
    await mkdir(entries, { recursive: true });
    await writeFile(
      join(entries, "browser-window.ts"),
      `
      import { writeFileSync } from "node:fs";
      export class BrowserWindow {
        webviewId = 1;
        webview = { setNavigationRules() {} };
        on(name, callback) { if (name === "close") setTimeout(callback, 10); }
        close() { writeFileSync(${JSON.stringify(join(root, "window-closed"))}, "closed"); }
      }
    `
    );
    await writeFile(join(entries, "events.ts"), "export default { on() {} };");
    await writeFile(
      join(entries, "utils.ts"),
      `
      import { writeFileSync } from "node:fs";
      export const paths = { appData: ${JSON.stringify(root)} };
      export function openExternal() {}
      export function quit(code) {
        writeFileSync(${JSON.stringify(join(root, "quit"))}, String(code));
        process.exit(code);
      }
    `
    );
    const bundle = join(root, "bundle/app");
    await cp(join(generated, "furin"), join(bundle, "furin"), { recursive: true });
    const built = await Bun.build({
      entrypoints: [join(generated, "main.ts")],
      target: "bun",
      format: "esm",
      outdir: join(bundle, "bun"),
      naming: "index.js",
    });
    expect(built.success).toBe(true);
    child = Bun.spawn([process.execPath, join(bundle, "bun/index.js")], {
      cwd: bundle,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const status = await Promise.race([child.exited, Bun.sleep(6500).then(() => "hung")]);
    expect(status).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("5 seconds");
    expect(await Bun.file(join(root, "window-closed")).text()).toBe("closed");
    expect(await Bun.file(join(root, "quit")).text()).toBe("1");
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 9000);
