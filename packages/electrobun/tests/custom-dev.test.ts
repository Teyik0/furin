// biome-ignore-all lint/performance/noAwaitInLoops: Observe public process and HTTP readiness sequentially.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCommand } from "../src/cli";

test("custom dev hosts retain their backend for frontend edits and drain before backend replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin custom dev "));
  let dev: Promise<void> | undefined;
  let failure: unknown;
  const readyPath = join(root, ".furin/electrobun/ready.json");
  const ready = async (previous?: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (failure) {
        throw failure;
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
    throw new Error("Custom host did not become ready");
  };
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","version":"1.0.0","type":"module"}'
    );
    await writeFile(
      join(root, "furin.desktop.config.ts"),
      `export default {
      app: { name: "Fixture", identifier: "local.furin.custom" },
      window: { width: 800, height: 600 }, hostEntry: "src/host.ts",
      dataDir: ${JSON.stringify(join(root, ".data"))}
    };`
    );
    await writeFile(join(root, "src/value.tsx"), 'export const value = "first";');
    await writeFile(join(root, "src/frontend.ts"), 'export const label = "Before";');
    await writeFile(
      join(root, "src/page.tsx"),
      'import { label } from "./frontend"; export default () => <p>{label}</p>;'
    );
    await writeFile(
      join(root, "src/server.ts"),
      `
      import { createDesktopApp } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir))};
      import { value } from "./value";
      export default createDesktopApp().get("/", () => ({ value, pid: process.pid, cwd: process.cwd(), args: process.execArgv }));
      export async function onShutdown() {
        await Bun.write(${JSON.stringify(join(root, ".closed"))}, String(process.pid));
      }
    `
    );
    await writeFile(
      join(root, "src/host.ts"),
      `
      import { getDesktopDevelopment, startDesktopBackend } from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      const development = await getDesktopDevelopment();
      if (!development) throw new Error("Missing development context");
      const backend = await startDesktopBackend(() => import(development.serverEntry), ${JSON.stringify(join(root, ".data"))}, "dev");
      await development.ready(backend, async () => { await backend.stop(); process.exit(0); });
    `
    );
    const sdk = join(root, "node_modules/electrobun");
    await mkdir(join(sdk, "bin"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      '{"name":"electrobun","exports":{"./package.json":"./package.json"}}'
    );
    await writeFile(
      join(sdk, "bin/electrobun.cjs"),
      `
      if (process.argv[2] !== "run") process.exit(0);
      const config = (await import(process.cwd() + "/electrobun.config.ts")).default;
      await import(config.build.bun.entrypoint);
    `
    );
    await writeFile(join(root, "bunfig.toml"), "smol = true\n");
    dev = desktopCommand("dev", root).catch((error) => {
      failure = error;
    });
    const first = await ready();
    expect((await fetch(first.origin)).status).toBe(403);
    const bootstrap = await fetch(first.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing private session");
    }
    const original = (await (await fetch(first.origin, { headers: { cookie } })).json()) as {
      value: string;
      pid: number;
      cwd: string;
      args: string[];
    };
    expect(original.value).toBe("first");
    expect(original.args).toContain(`--config=${join(root, "bunfig.toml")}`);
    expect(await realpath(original.cwd)).toBe(await realpath(root));
    await writeFile(join(root, "src/page.tsx"), "export default () => <p>Updated</p>;");
    await writeFile(join(root, "src/frontend.ts"), 'export const label = "After";');
    await writeFile(join(root, "src/style.css"), "body { color: red; }");
    await Bun.sleep(500);
    expect(await (await fetch(first.origin, { headers: { cookie } })).json()).toEqual(original);
    await writeFile(join(root, "src/value.tsx"), 'export const value = "second";');
    const second = await ready(first.url);
    const secondBootstrap = await fetch(second.url, { redirect: "manual" });
    const nextCookie = secondBootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!nextCookie) {
      throw new Error("Missing replacement session");
    }
    const updated = (await (
      await fetch(second.origin, { headers: { cookie: nextCookie } })
    ).json()) as { value: string; pid: number };
    expect(updated.value).toBe("second");
    expect(updated.pid).not.toBe(original.pid);
    expect(await Bun.file(join(root, ".closed")).text()).toBe(String(original.pid));
    expect(() => process.kill(original.pid, 0)).toThrow();
    expect((await fetch(second.origin, { headers: { cookie } })).status).toBe(403);
    await writeFile(join(root, "src/nested.tsx"), 'export const value = "third";');
    await writeFile(join(root, "src/value.tsx"), 'export { value } from "./nested";');
    const third = await ready(second.url);
    await writeFile(join(root, "src/nested.tsx"), 'export const value = "fourth";');
    const fourth = await ready(third.url);
    const finalBootstrap = await fetch(fourth.url, { redirect: "manual" });
    const finalCookie = finalBootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!finalCookie) {
      throw new Error("Missing final session");
    }
    expect(
      await (await fetch(fourth.origin, { headers: { cookie: finalCookie } })).json()
    ).toHaveProperty("value", "fourth");
    await rename(join(root, "src/nested.tsx"), join(root, "src/nested.ts"));
    const renamed = await ready(fourth.url);
    await writeFile(join(root, "src/nested.ts"), 'export const value = "fifth";');
    const fifth = await ready(renamed.url);
    const fifthBootstrap = await fetch(fifth.url, { redirect: "manual" });
    const fifthCookie = fifthBootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!fifthCookie) {
      throw new Error("Missing renamed dependency session");
    }
    expect(
      await (await fetch(fifth.origin, { headers: { cookie: fifthCookie } })).json()
    ).toHaveProperty("value", "fifth");
  } finally {
    if (dev) {
      process.emit("SIGTERM");
      await dev;
    }
    await rm(root, { recursive: true, force: true });
  }
  if (failure) {
    throw failure;
  }
}, 20_000);
