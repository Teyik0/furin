// biome-ignore-all lint/performance/noAwaitInLoops: Readiness is polled before making real HTTP requests.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCommand } from "../src/cli";
import { prepareDesktop } from "../src/prepare";

for (const rootData of [false, true]) {
  test(`dev supervisor reloads sibling backend imports with ${rootData ? "root" : "child"} data storage`, async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-dev-watch-"));
    interface Ready {
      checkpoint: boolean;
      origin: string;
      url: string;
    }
    const events: Ready[] = [];
    let notify: (() => void) | undefined;
    let firstRun = true;
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        events.push((await request.json()) as Ready);
        notify?.();
        if (firstRun) {
          firstRun = false;
          return new Response("observe");
        }
        return new Response("ok");
      },
    });
    const nextEvent = async (): Promise<Ready> => {
      if (!events.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            notify = resolve;
            timer = setTimeout(() => reject(new Error("Missing SDK event")), 5000);
          });
        } finally {
          clearTimeout(timer);
          notify = undefined;
        }
      }
      const event = events.shift();
      if (!event) {
        throw new Error("Missing SDK event");
      }
      return event;
    };
    const sessions = new Map<string, string>();
    const response = async (ready: Ready): Promise<{ value: string; pid: number }> => {
      let cookie = sessions.get(ready.origin);
      if (!cookie) {
        const bootstrap = await fetch(ready.url, { redirect: "manual" });
        cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      }
      if (!cookie) {
        throw new Error("Missing dev session");
      }
      sessions.set(ready.origin, cookie);
      return (await fetch(ready.origin, { headers: { cookie } })).json() as Promise<{
        value: string;
        pid: number;
      }>;
    };
    let dev: Promise<void> | undefined;
    try {
      await mkdir(join(root, "src/server"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
      await writeFile(
        join(root, "furin.config.ts"),
        `export default { serverEntry: "src/server/index.tsx", desktop: {
        app: { name: "Fixture", identifier: "local.furin.fixture" },
        window: { width: 800, height: 600 },
        dataDir: ${JSON.stringify(rootData ? root : join(root, "storage/database"))}
      } };`
      );
      const entry = `
      import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
      import { value } from "../database";
      export default createDesktopApp().get("/", () => ({ value, pid: process.pid }));
    `;
      await writeFile(join(root, "src/server/index.tsx"), entry);
      await writeFile(join(root, "src/database.ts"), 'export const value = "first";');
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
      const send = (checkpoint) => fetch(${JSON.stringify(receiver.url.href)}, {
        method: "POST", body: JSON.stringify({ ...ready, checkpoint })
      });
      const watcher = watch("control", async () => {
        if (await Bun.file("control").text()) process.exit(0);
      });
      if (await (await send(false)).text() === "observe") {
        setTimeout(() => send(true), 700);
      }
    `
      );
      const directories = [
        "src/frontend",
        ".furin/output",
        ".git",
        "node_modules/cache",
        ".hutch",
        "dist",
        "build",
        ...(rootData ? [] : ["storage/database"]),
      ];
      for (const directory of directories) {
        await mkdir(join(root, directory), { recursive: true });
      }
      dev = desktopCommand("dev", root);
      const first = await nextEvent();
      const original = await response(first);
      expect(original.value).toBe("first");
      await mkdir(join(root, "src/new-directory"));
      for (const directory of directories) {
        await writeFile(
          join(root, directory, directory === "src/frontend" ? "page.tsx" : "write.ts"),
          "export {};"
        );
      }
      await writeFile(join(root, "src/frontend/page.jsx"), "export {};");
      await writeFile(join(root, "src/frontend/page.css"), "body {}");
      await writeFile(join(root, "src/server/component.tsx"), "export {};");
      const checkpoint = await nextEvent();
      expect(checkpoint.checkpoint).toBe(true);
      expect(await response(checkpoint)).toEqual(original);
      await writeFile(join(root, "src/database.ts"), 'export const value = "second";');
      const second = await nextEvent();
      expect(second.checkpoint).toBe(false);
      const updated = await response(second);
      expect(updated.value).toBe("second");
      expect(updated.pid).not.toBe(original.pid);
      expect(() => process.kill(original.pid, 0)).toThrow();
      const starting = join(root, ".replacement-starting");
      await writeFile(
        join(root, "src/server/index.tsx"),
        `${entry}
      await Bun.write(${JSON.stringify(starting)}, "starting");
      if (value === "second") await Bun.sleep(30_000);
      `
      );
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(starting).exists())) {
        if (Date.now() > deadline) {
          throw new Error("Replacement backend did not start.");
        }
        await Bun.sleep(25);
      }
      // A second source edit must cancel readiness and retry, not fail startup.
      await writeFile(join(root, "src/database.ts"), 'export const value = "third";');
      const replacement = await nextEvent();
      expect((await response(replacement)).value).toBe("third");
      await writeFile(
        join(root, "src/server/index.tsx"),
        entry.replace("{ value, pid:", '{ value: "entry", pid:')
      );
      const third = await nextEvent();
      expect(third.checkpoint).toBe(false);
      expect((await response(third)).value).toBe("entry");
    } finally {
      try {
        if (dev) {
          process.emit("SIGTERM");
          await dev;
        }
      } finally {
        receiver.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 15_000);
}

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
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: Credentials must have owner-only permissions.
      expect((await stat(readyPath)).mode & 0o777).toBe(0o600);
    }
    const response = await fetch(ready.url, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing dev session.");
    }
    const actual = (await (await fetch(ready.origin, { headers: { cookie } })).json()) as {
      cwd: string;
      data: string;
    };
    expect(await realpath(actual.cwd)).toBe(await realpath(root));
    expect(actual.data).toBe(dataDir);
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
