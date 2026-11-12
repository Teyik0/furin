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
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
export default { ping: async () => ${JSON.stringify(reply)} };`;

/** A desktop project whose native entry records each shell process it runs in. */
async function createProject(mode?: "hung-quit") {
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
    import { desktopApp } from "@teyik0/furin-electrobun/server";
    import { value } from "./value";
    export default new Elysia()
      .use(desktopApp({ window: { title: "Fixture" } }))
      .get("/value", () => ({ value, pid: process.pid, dataDir: process.env.FURIN_APP_DATA_DIR }))
      .post("/minimize", async ({ desktop }) => {
        await desktop?.window.minimize();
        return { minimized: await desktop?.window.isMinimized() };
      })
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

async function interrupt(child: Bun.Subprocess): Promise<number> {
  process.kill(-child.pid, "SIGINT");
  return await child.exited;
}

test.each([
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

test("a native shell whose quit hangs is terminated when development stops", async () => {
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
}, 30_000);
