import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeRestart } from "../src/native-restart";

test("native restart waits for both process exits before running the launcher and preserves launch environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-native-restart-"));
  const children: Bun.Subprocess[] = [];
  const stop = (child: Bun.Subprocess) => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  };
  try {
    const runtime = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const parent = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(runtime, parent);
    const launcherSource = join(root, "launcher.ts");
    const result = join(root, "launched");
    await writeFile(
      launcherSource,
      `await Bun.write(${JSON.stringify(result)},JSON.stringify({
      pid:process.pid,value:process.env.FURIN_RESTART_TEST,
      parent:process.env.ELECTROBUN_LAUNCHER_PID,url:process.env.FURIN_NATIVE_OPEN
    }));`
    );
    const launcher = join(root, process.platform === "win32" ? "launcher.exe" : "launcher");
    const build = Bun.spawn(
      [process.execPath, "build", launcherSource, "--compile", "--outfile", launcher],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(await build.exited, await new Response(build.stderr).text()).toBe(0);
    const ready = Promise.withResolvers<void>();
    const restart = runNativeRestart(
      {
        pids: [runtime.pid, parent.pid],
        launcher,
        cwd: root,
        env: {
          ...process.env,
          FURIN_RESTART_TEST: "preserved",
          ELECTROBUN_LAUNCHER_PID: String(parent.pid),
          FURIN_NATIVE_OPEN: "already-processed",
        },
      },
      () => {
        ready.resolve();
        return Promise.resolve();
      }
    );
    await ready.promise;
    expect(await Bun.file(result).exists()).toBe(false);
    stop(runtime);
    await runtime.exited;
    expect(await Bun.file(result).exists()).toBe(false);
    stop(parent);
    await parent.exited;
    await restart;
    const deadline = Date.now() + 5000;
    // biome-ignore lint/performance/noAwaitInLoops: Observe the actual launcher output.
    while (!(await Bun.file(result).exists()) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    const actual = (await Bun.file(result).json()) as {
      pid: number;
      value: string;
      parent?: string;
      url?: string;
    };
    expect(actual.pid).not.toBe(runtime.pid);
    expect(actual.value).toBe("preserved");
    expect(actual.parent).toBeUndefined();
    expect(actual.url).toBeUndefined();
  } finally {
    for (const child of children) {
      stop(child);
    }
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
}, 15_000);
