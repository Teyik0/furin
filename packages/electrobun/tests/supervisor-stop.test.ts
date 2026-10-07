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

async function fixture(mode: "early" | "signal" | "backend-signal" | "hung" | "failed") {
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
  await writeFile(join(root, "furin.config.ts"), 'export default { serverEntry: "server.ts" };');
  await writeFile(
    join(root, "furin.desktop.config.ts"),
    `export default {
      app: { name: "Fixture", identifier: "local.furin.fixture" },
      window: { width: 800, height: 600 },
      dataDir: ${JSON.stringify(join(root, ".data"))}
    };`
  );
  await writeFile(
    join(root, "server.ts"),
    `
    import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
    await Bun.write(${JSON.stringify(join(root, ".backend.pid"))}, String(process.pid));
    ${
      mode === "early"
        ? `await fetch(${JSON.stringify(receiver.url.href)}, {
        method: "POST", body: JSON.stringify({ pid: process.pid })
      });
      setInterval(() => {}, 1000);
      await new Promise(() => {});`
        : ""
    }
    export default createDesktopApp().get("/", () => "ready");
    export async function onShutdown() {
      await Bun.write(${JSON.stringify(join(root, ".cleanup"))}, "closed");
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
              ? `process.kill(Number(await Bun.file(${JSON.stringify(join(root, ".backend.pid"))}).text()), "SIGINT");
          process.exit(0);`
              : 'process.kill(process.pid, "SIGINT");'
          }
        }
      });`
    }
    await fetch(${JSON.stringify(receiver.url.href)}, {
      method: "POST", body: JSON.stringify({ pid: process.pid, childPid, url: ready.url })
    });
  `
  );
  const supervisor = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "dev"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    root,
    supervisor,
    started: bounded(started),
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

test("Ctrl-C before readiness is an intentional stop, not a startup failure", async () => {
  const dev = await fixture("early");
  try {
    const worker = await dev.started;
    dev.supervisor.kill("SIGINT");
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
    dev.supervisor.kill("SIGINT");
    expect(await bounded(dev.supervisor.exited)).toBe(0);
    expect(await Bun.file(join(dev.root, ".cleanup")).text()).toBe("closed");
    expect(() => process.kill(window.pid, 0)).toThrow();
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(window.url).toBeDefined();
    expect(await new Response(dev.supervisor.stdout).text()).not.toContain(window.url as string);
    expect(await new Response(dev.supervisor.stderr).text()).toBe("");
  } finally {
    await dev.close();
  }
}, 12_000);

test("user cancellation also accepts an interrupted owned backend", async () => {
  const dev = await fixture("backend-signal");
  try {
    await dev.started;
    dev.supervisor.kill("SIGINT");
    expect(await bounded(dev.supervisor.exited)).toBe(0);
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(await new Response(dev.supervisor.stderr).text()).toBe("");
  } finally {
    await dev.close();
  }
}, 12_000);

test("user cancellation still reports an actual backend cleanup failure", async () => {
  const dev = await fixture("failed");
  try {
    await dev.started;
    dev.supervisor.kill("SIGINT");
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
    dev.supervisor.kill("SIGINT");
    expect(await bounded(dev.supervisor.exited)).toBe(1);
    expect(await new Response(dev.supervisor.stderr).text()).toContain("5 seconds");
    expect(() => process.kill(window.pid, 0)).toThrow();
    expect(window.childPid).toBeDefined();
    expect(() => process.kill(window.childPid as number, 0)).toThrow();
    const workerPid = Number(await Bun.file(join(dev.root, ".backend.pid")).text());
    expect(() => process.kill(workerPid, 0)).toThrow();
  } finally {
    await dev.close();
  }
}, 12_000);
