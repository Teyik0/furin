// biome-ignore-all lint/performance/noAwaitInLoops: Process exit polling must be bounded and sequential.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Started {
  childPid?: number;
  pid: number;
  url?: string;
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Supervisor did not settle")), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectExited(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (process.platform !== "win32") {
      const status = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const state = (await new Response(status.stdout).text()).trim();
      if ((await status.exited) === 0 && state.startsWith("Z")) {
        return; // Exited orphan awaiting reaping, not a live descendant leak.
      }
    }
    await Bun.sleep(25);
  }
  throw new Error(`Owned process ${pid} is still live.`);
}

async function fixture(
  mode: "early" | "crash" | "signal" | "backend-signal" | "hung" | "failed",
  ipc?: boolean
) {
  const root = await mkdtemp(join(tmpdir(), "furin-supervisor-stop-"));
  let observed: Started | undefined;
  const { promise: started, resolve: receive } = Promise.withResolvers<Started>();
  const receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      observed = (await request.json()) as Started;
      receive(observed);
      return new Response("ok");
    },
  });
  await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(
    join(root, "furin.config.ts"),
    `export default { serverEntry: "server.ts", desktop: {
      app: { name: "Fixture", identifier: "local.furin.fixture" },
      window: { width: 800, height: 600 },
      dataDir: ${JSON.stringify(join(root, ".data"))}
    } };`
  );
  await writeFile(
    join(root, "server.ts"),
    `
    import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
    await Bun.write(${JSON.stringify(join(root, ".backend.pid"))}, String(process.pid));
    ${
      mode === "early" || mode === "crash"
        ? `await fetch(${JSON.stringify(receiver.url.href)}, {
        method: "POST", body: JSON.stringify({ pid: process.pid })
      });
      ${mode === "crash" ? "process.exit(7);" : ""}
      setInterval(() => {}, 1000);
      await new Promise(() => {});`
        : ""
    }
    export default createDesktopApp().get("/", () => "ready");
    export async function onShutdown() {
      await Bun.write(${JSON.stringify(join(root, ".cleanup"))}, "closed");
      ${
        mode === "backend-signal"
          ? `
      process.removeAllListeners("SIGINT");
      if (process.platform === "win32") process.exit(130);
      process.kill(process.pid, "SIGINT");
      await new Promise(() => {});
      `
          : ""
      }
      ${mode === "failed" ? 'throw new Error("fixture cleanup failed");' : ""}
    }
  `
  );
  const sdk = join(root, "node_modules/electrobun");
  await mkdir(join(sdk, "bin"), { recursive: true });
  await writeFile(
    join(sdk, "package.json"),
    '{"name":"electrobun","version":"2.0.2","exports":{"./package.json":"./package.json"}}'
  );
  await writeFile(
    join(sdk, "bin/electrobun.cjs"),
    `
    if (process.argv[2] !== "run") process.exit(0);
    const { watch } = require("node:fs");
    const ready = await Bun.file("ready.json").json();
    ${
      mode === "hung"
        ? `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore", stderr: "ignore"
      });
      const childPid = child.pid;`
        : "const childPid = undefined;"
    }
    setInterval(() => {}, 1000);
    ${
      mode === "hung"
        ? ""
        : `watch("control", async () => {
        if (await Bun.file("control").text()) {
          ${
            mode === "backend-signal"
              ? `if (process.platform !== "win32") {
            process.kill(Number(await Bun.file(${JSON.stringify(join(root, ".backend.pid"))}).text()), "SIGINT");
          }
          process.exit(0);`
              : 'if (process.platform === "win32") process.exit(130); else process.kill(process.pid, "SIGINT");'
          }
        }
      });`
    }
    await fetch(${JSON.stringify(receiver.url.href)}, {
      method: "POST", body: JSON.stringify({ pid: process.pid, childPid, url: ready.url })
    });
  `
  );
  const runner = join(root, ".supervisor.ts");
  await writeFile(
    runner,
    `import { desktopCommand } from ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))};
process.on("message", (signal) => {
  if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal);
});
try { await desktopCommand("dev", process.cwd()); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { process.disconnect(); }`
  );
  const supervisor = Bun.spawn([process.execPath, runner], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    ipc: () => undefined,
  });
  return {
    root,
    supervisor,
    started: bounded(started),
    interrupt() {
      if (ipc || process.platform === "win32") {
        supervisor.send("SIGINT");
      } else {
        supervisor.kill("SIGINT");
      }
    },
    async close() {
      if (supervisor.exitCode === null) {
        supervisor.kill("SIGKILL");
        await supervisor.exited;
      }
      const pidFile = Bun.file(join(root, ".backend.pid"));
      const workerPid = (await pidFile.exists()) ? Number(await pidFile.text()) : undefined;
      for (const pid of [observed?.childPid, observed?.pid, workerPid]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
      }
      receiver.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("an unexpected backend exit before readiness remains a failure", async () => {
  const dev = await fixture("crash");
  try {
    await dev.started;
    expect(await bounded(dev.supervisor.exited)).toBe(1);
    expect(await new Response(dev.supervisor.stderr).text()).toContain("(7)");
  } finally {
    await dev.close();
  }
}, 12_000);

test("Ctrl-C before readiness is an intentional stop, not a startup failure", async () => {
  const dev = await fixture("early");
  try {
    const worker = await dev.started;
    dev.interrupt();
    expect(await bounded(dev.supervisor.exited)).toBe(0);
    expect(() => process.kill(worker.pid, 0)).toThrow();
    expect(await new Response(dev.supervisor.stderr).text()).toBe("");
  } finally {
    await dev.close();
  }
}, 12_000);

test("Ctrl-C after readiness accepts a signal-terminated SDK and still drains the backend", async () => {
  const dev = await fixture("signal");
  try {
    const window = await dev.started;
    dev.interrupt();
    const status = await bounded(dev.supervisor.exited);
    const diagnostic = await new Response(dev.supervisor.stderr).text();
    expect(status, diagnostic).toBe(0);
    expect(await Bun.file(join(dev.root, ".cleanup")).text()).toBe("closed");
    expect(() => process.kill(window.pid, 0)).toThrow();
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(window.url).toBeDefined();
    expect(await new Response(dev.supervisor.stdout).text()).not.toContain(window.url as string);
    expect(diagnostic).toBe("");
  } finally {
    await dev.close();
  }
}, 12_000);

test("IPC-delivered shutdown invokes the supervisor signal handler and drains the backend", async () => {
  const dev = await fixture("signal", true);
  try {
    await dev.started;
    dev.interrupt();
    const status = await bounded(dev.supervisor.exited);
    const diagnostic = await new Response(dev.supervisor.stderr).text();
    expect(status, diagnostic).toBe(0);
    expect(await Bun.file(join(dev.root, ".cleanup")).text()).toBe("closed");
    expect(diagnostic).toBe("");
  } finally {
    await dev.close();
  }
}, 12_000);

test("user cancellation also accepts an interrupted owned backend", async () => {
  const dev = await fixture("backend-signal");
  try {
    await dev.started;
    dev.interrupt();
    const status = await bounded(dev.supervisor.exited);
    const diagnostic = await new Response(dev.supervisor.stderr).text();
    expect(status, diagnostic).toBe(0);
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(diagnostic).toBe("");
    // POSIX exits by signal; Windows models Bun's numeric interrupted-child status.
    const worker = Bun.spawn(
      [process.execPath, join(dev.root, ".furin/electrobun/dev-server.ts")],
      { cwd: dev.root, stdout: "ignore", stderr: "ignore" }
    );
    try {
      expect(await bounded(worker.exited)).not.toBe(0);
      if (process.platform === "win32") {
        expect(worker.exitCode).toBe(130);
      } else {
        expect(worker.signalCode).toBe("SIGINT");
      }
    } finally {
      if (worker.exitCode === null) {
        worker.kill("SIGKILL");
        await worker.exited;
      }
    }
  } finally {
    await dev.close();
  }
}, 12_000);

test("user cancellation still reports an actual backend cleanup failure", async () => {
  const dev = await fixture("failed");
  try {
    await dev.started;
    dev.interrupt();
    expect(await bounded(dev.supervisor.exited)).toBe(1);
    expect(await new Response(dev.supervisor.stderr).text()).toContain("fixture cleanup failed");
  } finally {
    await dev.close();
  }
}, 12_000);

test("a hung SDK window is bounded and its owned process group is terminated", async () => {
  const dev = await fixture("hung");
  try {
    const window = await dev.started;
    dev.interrupt();
    expect(await bounded(dev.supervisor.exited)).toBe(1);
    expect(await new Response(dev.supervisor.stderr).text()).toContain("5 seconds");
    expect(() => process.kill(window.pid, 0)).toThrow();
    expect(window.childPid).toBeDefined();
    await expectExited(window.childPid as number);
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
  } finally {
    await dev.close();
  }
}, 12_000);
