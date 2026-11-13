// biome-ignore-all lint/performance/noAwaitInLoops: Observe development processes sequentially.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSdk, sdkRunHeader } from "./fixtures/sdk";

const CORE_CLI = join(import.meta.dir, "../../core/src/cli/index.ts");

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const nativeEntry = (pids: string, reply: string) => `import { appendFileSync } from "node:fs";
import Electrobun from "electrobun/main";
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
Electrobun.events.on("open-url", (event) =>
  appendFileSync(${JSON.stringify(join(pids, "../native-opens"))}, event.data.url + "\\n"));
export default {
  ping: async () => ${JSON.stringify(reply)},
  // What the SDK emits when the OS opens a registered URL.
  open: async (url: string) => Electrobun.events.emitEvent(Electrobun.events.events.app.openUrl({ url })),
};`;

/** A desktop project whose native entry records each shell process it runs in. */
async function createProject(mode?: "hung-quit" | "failed-window") {
  const root = await mkdtemp(join(tmpdir(), "furin-desktop-dev-"));
  const shellPids = join(root, "shell-pids");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
  await symlink(join(import.meta.dir, ".."), join(root, "node_modules/@teyik0/furin-electrobun"));
  await symlink(join(import.meta.dir, "../../core"), join(root, "node_modules/@teyik0/furin"));
  await writeFile(
    join(root, "package.json"),
    '{"name":"fixture","version":"1.0.0","type":"module"}'
  );
  await writeFile(
    join(root, "furin.config.ts"),
    `export default { desktop: {
      app: { name: "Fixture", identifier: "local.furin.desktop-dev" },
      build: { bun: { entrypoint: "src/desktop.ts" } },
      dataDir: ${JSON.stringify(join(root, ".data"))}
    } };`
  );
  await writeFile(join(root, "src/value.ts"), 'export const value = "first";');
  await writeFile(join(root, "src/desktop.ts"), nativeEntry(shellPids, "pong"));
  await writeFile(
    join(root, "src/server.ts"),
    `import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
    import { appendFileSync } from "node:fs";
    import { desktopApp } from "@teyik0/furin-electrobun/server";
    import { value } from "./value";
    export default new Elysia()
      .use(desktopApp({
        window: { title: "Fixture" },
        onOpen: (event) =>
          appendFileSync(${JSON.stringify(join(root, "backend-opens"))}, JSON.stringify({ ...event, value }) + "\\n"),
      }))
      .get("/value", () => ({ value, pid: process.pid, dataDir: process.env.FURIN_APP_DATA_DIR }))
      .post("/minimize", async ({ desktop }) => {
        await desktop?.window.minimize();
        return { minimized: await desktop?.window.isMinimized() };
      })
      .post("/open", async ({ desktop, query }) =>
        (desktop?.native as { open: (url: string) => Promise<void> }).open(query.url ?? ""))
      .post("/ping", async ({ desktop }) => ({
        reply: await (desktop?.native as { ping: () => Promise<string> }).ping(),
      }))
      .listen({ hostname: "127.0.0.1", port: ${port} });`
  );
  await installSdk(root, mode);
  await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), sdkRunHeader(root));
  return {
    root,
    shellPids,
    readPids: async () =>
      (await Bun.file(shellPids).text()).trim().split("\n").filter(Boolean).map(Number),
    // Detached like a terminal job, so Ctrl-C reaches the whole foreground group.
    start: (command: string[]) =>
      Bun.spawn(command, {
        cwd: root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
      }),
    async session(windowUrl: string) {
      const bootstrap = await fetch(windowUrl, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
      const { origin } = new URL(windowUrl);
      return {
        origin,
        get: async (path: string) =>
          (await (await fetch(`${origin}${path}`, { headers: { cookie } })).json()) as {
            value: string;
            pid: number;
            dataDir: string;
          },
        post: async (path: string) =>
          await (
            await fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin } })
          ).json(),
      };
    },
  };
}

// The suite drives Ctrl-C through POSIX process groups (negative PIDs), which Windows lacks.
const posix = test.skipIf(process.platform === "win32");

async function interrupt(child: Bun.Subprocess): Promise<number> {
  process.kill(-child.pid, "SIGINT");
  return await child.exited;
}

posix.each([
  ["furin dev --desktop", [process.execPath, CORE_CLI, "dev", "--desktop"]],
  ["bun --hot src/server.ts", [process.execPath, "--hot", "src/server.ts"]],
] as const)(
  "%s hot-reloads backend edits while the desktop shell keeps running",
  async (_name, launcher) => {
    const project = await createProject();
    let child: Bun.Subprocess | undefined;
    try {
      if (launcher.includes("--hot")) {
        await writeFile(
          join(project.root, "bunfig.toml"),
          'preload = ["@teyik0/furin-electrobun/preload"]\n'
        );
      }
      child = project.start([...launcher]);
      const windowUrl = await until(
        () => Bun.file(join(project.root, "window-url")).text(),
        "window"
      );
      const app = await project.session(windowUrl);
      const first = await app.get("/value");
      expect(first.value).toBe("first");
      expect(first.dataDir).toBe(join(project.root, ".data"));
      expect((await fetch(`${app.origin}/value`)).status).toBe(403);
      expect(await app.post("/minimize")).toEqual({ minimized: true });
      expect(await app.post("/ping")).toEqual({ reply: "pong" });
      if (launcher.includes("--hot")) {
        // Without --desktop, the system browser also receives a single-use owner session.
        const browserUrl = await until(
          () => Bun.file(join(project.root, "browser-url")).text(),
          "browser"
        );
        expect((await fetch(browserUrl, { redirect: "manual" })).status).toBe(303);
      } else {
        expect(await Bun.file(join(project.root, "browser-url")).exists()).toBe(false);
      }
      const [shell = 0] = await project.readPids();

      await writeFile(join(project.root, "src/value.ts"), 'export const value = "second";');
      const second = await until(async () => {
        const next = await app.get("/value");
        return next.value === "second" ? next : undefined;
      }, "backend reload");
      expect(second.pid).toBe(first.pid);
      expect(await project.readPids()).toEqual([shell]);

      await writeFile(
        join(project.root, "src/desktop.ts"),
        nativeEntry(project.shellPids, "pong again")
      );
      const [, next = 0] = await until(async () => {
        const pids = await project.readPids();
        return pids.length === 2 ? pids : undefined;
      }, "shell relaunch");
      expect(next).not.toBe(shell);
      expect(alive(shell)).toBe(false);
      expect(
        await until(async () => {
          const { reply } = (await app.post("/ping")) as { reply: string };
          return reply === "pong again" ? reply : undefined;
        }, "relaunched native commands")
      ).toBe("pong again");
      expect((await app.get("/value")).pid).toBe(first.pid);

      expect(await interrupt(child)).toBe(0);
      await until(async () => (alive(next) ? undefined : true), "shell exit");
    } finally {
      if (child?.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  60_000
);

posix(
  "furin dev delivers native open events to the current backend onOpen hook",
  async () => {
    const project = await createProject();
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    const opens = join(project.root, "backend-opens");
    let app: Awaited<ReturnType<typeof project.session>>;
    // The native shell receives an SDK open-url event; the backend must handle it.
    const open = async (url: string) => {
      await app.post(`/open?url=${encodeURIComponent(url)}`);
      return await until(async () => {
        const events = (await Bun.file(opens).text()).trim().split("\n");
        const last = JSON.parse(events.at(-1) ?? "{}");
        return last.url === url ? { count: events.length, last } : undefined;
      }, `backend open ${url}`);
    };
    try {
      app = await project.session(
        await until(() => Bun.file(join(project.root, "window-url")).text(), "window")
      );
      expect(await open("fixture://one")).toEqual({
        count: 1,
        last: { type: "url", url: "fixture://one", value: "first" },
      });

      await writeFile(join(project.root, "src/value.ts"), 'export const value = "second";');
      await until(
        async () => ((await app.get("/value")).value === "second" ? true : undefined),
        "backend reload"
      );
      expect(await open("fixture://two")).toEqual({
        count: 2,
        last: { type: "url", url: "fixture://two", value: "second" },
      });

      await writeFile(join(project.root, "src/desktop.ts"), nativeEntry(project.shellPids, "two"));
      await until(async () => {
        const { reply } = (await app.post("/ping").catch(() => ({}))) as { reply?: string };
        return reply === "two" ? reply : undefined;
      }, "relaunched shell");
      expect(await open("fixture://three")).toEqual({
        count: 3,
        last: { type: "url", url: "fixture://three", value: "second" },
      });
      // Native listeners saw each SDK event once: Furin did not re-emit what the backend handled.
      expect(await Bun.file(join(project.root, "native-opens")).text()).toBe(
        "fixture://one\nfixture://two\nfixture://three\n"
      );
      expect(await interrupt(child)).toBe(0);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  60_000
);

posix(
  "a native window construction failure quits the shell and ends development",
  async () => {
    const project = await createProject("failed-window");
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    try {
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "hung")]);
      expect(code).not.toBe("hung");
      expect(await Bun.file(join(project.root, "quit")).text()).toBe("1");
      const [shell = 0] = await project.readPids();
      expect(alive(shell)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  30_000
);

posix(
  "a native shell whose quit hangs is terminated when development stops",
  async () => {
    const project = await createProject("hung-quit");
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    try {
      await until(() => Bun.file(join(project.root, "window-url")).text(), "window");
      const [shell = 0] = await project.readPids();
      expect(await interrupt(child)).toBe(0);
      await until(async () => (alive(shell) ? undefined : true), "forced shell exit");
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  30_000
);

posix(
  "a native edit during a shell rebuild relaunches one shell after that build",
  async () => {
    const project = await createProject();
    const builds = join(project.root, "builds");
    // Every rebuild after the first is slow and announces itself, so an edit can land mid-build.
    await writeFile(
      join(project.root, "node_modules/electrobun/bin/electrobun.cjs"),
      `if (process.argv[2] === "build") {
      const fs = require("node:fs");
      const count = fs.existsSync(${JSON.stringify(builds)}) ? fs.readFileSync(${JSON.stringify(builds)}, "utf8").length : 0;
      fs.appendFileSync(${JSON.stringify(builds)}, "b");
      if (count > 0) await Bun.sleep(1500);
    }
    ${sdkRunHeader(project.root)}`
    );
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    try {
      await until(() => Bun.file(join(project.root, "window-url")).text(), "window");
      await writeFile(join(project.root, "src/desktop.ts"), nativeEntry(project.shellPids, "two"));
      await until(
        async () => ((await Bun.file(builds).text()).length === 2 ? true : undefined),
        "slow rebuild"
      );
      await writeFile(
        join(project.root, "src/desktop.ts"),
        nativeEntry(project.shellPids, "three")
      );
      const app = await project.session(
        await until(async () => {
          const url = await Bun.file(join(project.root, "window-url")).text();
          return (await project.readPids()).length === 2 ? url : undefined;
        }, "second shell")
      );
      expect(await app.post("/ping")).toEqual({ reply: "three" });
      const pids = await project.readPids();
      expect(pids.map(alive)).toEqual([false, true]);
      // Outlast another slow rebuild: no second concurrent shell may follow.
      await Bun.sleep(2000);
      expect(await project.readPids()).toEqual(pids);
      expect(await interrupt(child)).toBe(0);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  60_000
);

posix(
  "a native edit before a relaunched shell connects relaunches it again",
  async () => {
    const project = await createProject();
    const runs = join(project.root, "runs");
    // The second shell announces its launch, then delays its channel connection.
    await writeFile(
      join(project.root, "node_modules/electrobun/bin/electrobun.cjs"),
      `if (process.argv[2] === "run") {
      const fs = require("node:fs");
      const count = fs.existsSync(${JSON.stringify(runs)}) ? fs.readFileSync(${JSON.stringify(runs)}, "utf8").length : 0;
      fs.appendFileSync(${JSON.stringify(runs)}, "r");
      if (count === 1) await Bun.sleep(1500);
    }
    ${sdkRunHeader(project.root)}`
    );
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    try {
      await until(() => Bun.file(join(project.root, "window-url")).text(), "window");
      await writeFile(join(project.root, "src/desktop.ts"), nativeEntry(project.shellPids, "two"));
      await until(
        async () => ((await Bun.file(runs).text()).length === 2 ? true : undefined),
        "second shell launch"
      );
      await writeFile(
        join(project.root, "src/desktop.ts"),
        nativeEntry(project.shellPids, "three")
      );
      const pids = await until(async () => {
        const all = await project.readPids();
        return all.length === 3 ? all : undefined;
      }, "third shell");
      expect(pids.map(alive)).toEqual([false, false, true]);
      expect(await interrupt(child)).toBe(0);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  60_000
);

posix(
  "fixing a native import after a failed rebuild relaunches the shell",
  async () => {
    const project = await createProject();
    const imported = join(project.root, "src/native-value.ts");
    await writeFile(imported, 'export const reply = "one";');
    await writeFile(
      join(project.root, "src/desktop.ts"),
      `import { appendFileSync } from "node:fs";
    import { reply } from "./native-value";
    appendFileSync(${JSON.stringify(project.shellPids)}, process.pid + "\\n");
    export default { ping: async () => reply };`
    );
    const failed = join(project.root, "failed-build");
    // Like the SDK, a shell build fails while the native graph does not compile.
    await writeFile(
      join(project.root, "node_modules/electrobun/bin/electrobun.cjs"),
      `if (process.argv[2] === "build" && require("node:fs").readFileSync(${JSON.stringify(imported)}, "utf8").includes("(")) {
      require("node:fs").writeFileSync(${JSON.stringify(failed)}, "failed");
      process.exit(1);
    }
    ${sdkRunHeader(project.root)}`
    );
    const child = project.start([process.execPath, CORE_CLI, "dev", "--desktop"]);
    try {
      const app = await project.session(
        await until(() => Bun.file(join(project.root, "window-url")).text(), "window")
      );
      expect(await app.post("/ping")).toEqual({ reply: "one" });
      await writeFile(imported, "export const reply = (;");
      const [first = 0] = await project.readPids();
      await until(async () => (alive(first) ? undefined : true), "shell exit");
      await until(
        async () => ((await Bun.file(failed).exists()) ? true : undefined),
        "failed build"
      );
      await writeFile(imported, 'export const reply = "fixed";');
      expect(
        await until(async () => {
          const { reply } = (await app.post("/ping").catch(() => ({}))) as { reply?: string };
          return reply === "fixed" ? reply : undefined;
        }, "repaired shell")
      ).toBe("fixed");
      expect(await interrupt(child)).toBe(0);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await rm(project.root, { recursive: true, force: true });
    }
  },
  60_000
);
