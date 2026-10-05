// biome-ignore-all lint/performance/noAwaitInLoops: Readiness is polled before making real HTTP requests.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCommand } from "../src/cli";
import { prepareDesktop } from "../src/prepare";

test("dev helper keeps consuming CWD and drains through the control file without SDK signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-dev-"));
  const entry = join(root, "server.ts");
  await writeFile(
    entry,
    `
    import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
    export default createDesktopApp().get("/", () => ({
      cwd: process.cwd(), data: process.env.FURIN_APP_DATA_DIR
    }));
    export async function onShutdown() {
      await Bun.write(${JSON.stringify(join(root, "closed"))}, "closed");
    }
  `
  );
  const dataDir = join(root, "data");
  const generated = await prepareDesktop(
    root,
    {
      app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
      window: { width: 800, height: 600 },
      dataDir,
    },
    { mode: "dev", root, serverEntry: entry }
  );
  const child = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const readyPath = join(generated, "ready.json");
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(readyPath).exists())) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error("Dev helper did not start.");
      }
      await Bun.sleep(25);
    }
    const ready: { origin: string; bootstrapOrigin: string; url: string } =
      await Bun.file(readyPath).json();
    expect(ready.bootstrapOrigin).toBe(new URL(ready.url).origin);
    // biome-ignore lint/suspicious/noBitwiseOperators: Credentials must have owner-only permissions.
    expect((await stat(readyPath)).mode & 0o777).toBe(0o600);
    const response = await fetch(ready.url, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing dev session.");
    }
    expect(await (await fetch(ready.origin, { headers: { cookie } })).json()).toEqual({
      cwd: await realpath(root),
      data: dataDir,
    });
    await writeFile(join(generated, "control"), "close");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain(ready.url);
    expect(await Bun.file(join(root, "closed")).text()).toBe("closed");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dev supervisor terminates its ready worker when onShutdown holds an active handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-dev-hung-"));
  let pid: number | undefined;
  try {
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
      import { writeFileSync } from "node:fs";
      import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
      writeFileSync(${JSON.stringify(join(root, ".worker.pid"))}, String(process.pid));
      export default createDesktopApp().get("/", () => "ready");
      export function onShutdown() {
        writeFileSync(${JSON.stringify(join(root, ".cleanup"))}, "started");
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      }
    `
    );
    // The SDK command boundary exits like a closed window; no GUI is launched.
    const sdk = join(root, "node_modules/electrobun");
    await mkdir(join(sdk, "bin"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      '{"name":"electrobun","version":"2.0.2","exports":{"./package.json":"./package.json"}}'
    );
    await writeFile(join(sdk, "bin/electrobun.cjs"), "process.exit(0);");
    const result = await Promise.race([
      desktopCommand("dev", root).then(
        () => "unexpected success",
        (error: Error) => error.message
      ),
      Bun.sleep(6500).then(() => "supervisor never settled"),
    ]);
    const workerPid = Number(await Bun.file(join(root, ".worker.pid")).text());
    pid = workerPid;
    expect(result).toContain("5 seconds");
    expect(await Bun.file(join(root, ".cleanup")).text()).toBe("started");
    expect(() => process.kill(workerPid, 0)).toThrow();
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already reaped by the supervisor. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 9000);

test("dev helper reports cleanup failure and exits with status one", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-dev-failed-"));
  const entry = join(root, "server.ts");
  await writeFile(
    entry,
    `
    import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
    export default createDesktopApp().get("/", () => "ready");
    export function onShutdown() { throw new Error("resource close failed"); }
  `
  );
  const generated = await prepareDesktop(
    root,
    {
      app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
      window: { width: 800, height: 600 },
      dataDir: join(root, "data"),
    },
    { mode: "dev", root, serverEntry: entry }
  );
  const child = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(join(generated, "ready.json")).exists())) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error("Dev helper did not start.");
      }
      await Bun.sleep(25);
    }
    await writeFile(join(generated, "control"), "stop");
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("resource close failed");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
