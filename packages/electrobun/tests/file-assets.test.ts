// biome-ignore-all lint/performance/noAwaitInLoops: Observe each real backend generation before the next edit.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("file assets survive dependency scanning and restart their owning server or host", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-file-assets-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let output: Promise<string[]> | undefined;
  const readyPath = join(root, ".furin/electrobun/ready.json");
  const ready = async (previous?: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Dev exited (${child.exitCode}, ${child.signalCode})\n${await output}`);
      }
      try {
        const value: { origin: string; url: string } = await Bun.file(readyPath).json();
        if (value.url !== previous) {
          return value;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await Bun.sleep(25);
    }
    throw new Error("File-asset development did not become ready.");
  };
  const response = async (generation: { origin: string; url: string }) => {
    const bootstrap = await fetch(generation.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing desktop session.");
    }
    const value = (await (await fetch(generation.origin, { headers: { cookie } })).json()) as {
      worker: string;
      pid: number;
    };
    return value;
  };
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default { desktop: {
        app: { name: "Assets", identifier: "local.furin.assets" },
        window: { width: 800, height: 600 },
        hostEntry: "src/host.ts", dataDir: ${JSON.stringify(join(root, ".data"))}
      } };`
    );
    await writeFile(
      join(root, "tsconfig.json"),
      '{"compilerOptions":{"paths":{"@runtime/*":["./runtime/*"]}}}'
    );
    await writeFile(join(root, "runtime/engine-worker.worker"), "worker one");
    await writeFile(join(root, "runtime/host-icon.bin"), "icon one");
    await writeFile(
      join(root, "src/worker-client.ts"),
      `import workerBundle from "@runtime/engine-worker.worker" with { type: "file" };
      export const readWorker = () => Bun.file(workerBundle).text();`
    );
    await writeFile(
      join(root, "src/server.ts"),
      `import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import { desktopApp } from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      import { readWorker } from "./worker-client";
      export default new Elysia().use(desktopApp()).get("/", async () => ({
        worker: await readWorker(), pid: process.pid
      }));`
    );
    await writeFile(
      join(root, "src/host.ts"),
      `import { runDesktopHost } from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      import icon from "../runtime/host-icon.bin" with { type: "file" };
      const sdk = { Utils: { paths: { appData: ${JSON.stringify(root)} }, quit: process.exit },
        default: { events: { on() {} } } };
      await Bun.write(${JSON.stringify(join(root, ".host-icon"))}, await Bun.file(icon).text());
      await runDesktopHost(sdk, async ({ startBackend }) => { await startBackend(); });`
    );
    const sdk = join(root, "node_modules/electrobun");
    await mkdir(join(sdk, "bin"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      '{"name":"electrobun","exports":{"./package.json":"./package.json"}}'
    );
    await writeFile(
      join(sdk, "bin/electrobun.cjs"),
      `if (process.argv[2] !== "run") process.exit(0);
      const config = (await import(process.cwd() + "/electrobun.config.ts")).default;
      await import(config.build.bun.entrypoint);`
    );
    const runner = join(root, ".runner.ts");
    await writeFile(
      runner,
      `import { desktopCommand } from ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))};
      process.on("message", () => process.emit("SIGTERM"));
      await desktopCommand("dev", process.cwd());
      process.exit(0);`
    );
    // A native Bun panic must only abort this child, never the test runner.
    child = Bun.spawn([process.execPath, runner], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ipc: () => undefined,
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const first = await ready();
    expect((await fetch(first.origin)).status).toBe(403);
    const original = await response(first);
    expect(original.worker).toBe("worker one");
    await writeFile(join(root, "runtime/engine-worker.worker"), "worker two");
    const second = await ready(first.url);
    const updated = await response(second);
    expect(updated.worker).toBe("worker two");
    expect(updated.pid).not.toBe(original.pid);
    expect(() => process.kill(original.pid, 0)).toThrow();
    await writeFile(join(root, "runtime/host-icon.bin"), "icon two");
    const third = await ready(second.url);
    expect((await response(third)).pid).not.toBe(updated.pid);
    expect(await Bun.file(join(root, ".host-icon")).text()).toBe("icon two");
    expect((await readdir(join(root, "runtime"))).sort()).toEqual([
      "engine-worker.worker",
      "host-icon.bin",
    ]);
    expect(await Bun.file(join(root, "src/server.js")).exists()).toBe(false);
    child.send("stop");
    expect(await child.exited, (await output).join("\n")).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.send("stop");
      }
      await child.exited;
      await output;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
