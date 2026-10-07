// biome-ignore-all lint/performance/noAwaitInLoops: Wait for the owned dev helper before starting the SDK host.
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";

test.each(["build", "dev"] as const)(
  "SDK failure drains %s once and quits(1)",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "furin-startup-"));
    let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    let helper: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    try {
      const artifact = join(root, ".furin/build/bun");
      await mkdir(artifact, { recursive: true });
      const entry = mode === "build" ? join(artifact, "app.js") : join(root, "server.ts");
      await writeFile(
        entry,
        `import { appendFileSync } from "node:fs";
import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
export default createDesktopApp().get("/", () => "ready");
export function onShutdown() { appendFileSync(${JSON.stringify(join(root, "stopped"))}, "stop\\n"); }`
      );
      const generated = await prepareDesktop(
        root,
        {
          app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
          window: { width: 800, height: 600 },
          dataDir: join(root, "data"),
        },
        { mode, root, serverEntry: entry }
      );
      if (mode === "dev") {
        helper = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
        const deadline = Date.now() + 3000;
        while (!(await Bun.file(join(generated, "ready.json")).exists())) {
          if (helper.exitCode !== null || Date.now() > deadline) {
            throw new Error("Dev helper failed to start.");
          }
          await Bun.sleep(10);
        }
      }
      const entries = join(generated, ".hutch/devkit/api/sdks/main/entries");
      await mkdir(entries, { recursive: true });
      await writeFile(
        join(entries, "browser-window.ts"),
        'export class BrowserWindow { constructor() { throw new Error("constructor failed"); } }'
      );
      await writeFile(join(entries, "events.ts"), "export default { on() {} };");
      await writeFile(
        join(entries, "utils.ts"),
        `import { writeFileSync } from "node:fs";
export const paths = { appData: ${JSON.stringify(root)} };
export function openExternal() {}
export function quit(code) { writeFileSync(${JSON.stringify(join(root, "quit"))}, String(code)); process.exit(code); }`
      );
      const bundle = join(root, "bundle/app");
      if (mode === "build") {
        await cp(join(generated, "furin"), join(bundle, "furin"), { recursive: true });
      }
      const built = await Bun.build({
        entrypoints: [join(generated, "main.ts")],
        target: "bun",
        format: "esm",
        outdir: join(bundle, "bun"),
        naming: "index.js",
      });
      expect(built.success).toBe(true);
      child = Bun.spawn([process.execPath, join(bundle, "bun/index.js")], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await Promise.race([child.exited, Bun.sleep(6500).then(() => "hung")])).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("constructor failed");
      if (helper) {
        expect(await Promise.race([helper.exited, Bun.sleep(6500).then(() => "hung")])).toBe(0);
      }
      expect(await Bun.file(join(root, "stopped")).text()).toBe("stop\n");
      expect(await Bun.file(join(root, "quit")).text()).toBe("1");
    } finally {
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      if (helper?.exitCode === null) {
        helper.kill("SIGKILL");
        await helper.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  9000
);
