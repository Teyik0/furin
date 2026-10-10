import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSdk, sdkRunHeader } from "./fixtures/sdk";

test("bun --hot src/server.ts starts one desktop/browser owner without evaluating the launcher app", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-preload-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let output: Promise<string[]> | undefined;
  const ready = async (previous?: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child?.exitCode !== null) {
        // biome-ignore lint/performance/noAwaitInLoops: Drain a terminated child's diagnostics before reporting failure.
        const diagnostic = await output;
        throw new Error(`Development exited: ${diagnostic?.join("\n")}`);
      }
      const file = Bun.file(join(root, ".furin/electrobun/ready.json"));
      if (await file.exists()) {
        const generation: { origin: string; url: string } = await file.json();
        if (generation.url !== previous) {
          return generation;
        }
      }
      await Bun.sleep(20);
    }
    throw new Error("Desktop preload readiness expired.");
  };
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
    await symlink(
      join(import.meta.dir, ".."),
      join(root, "node_modules/@teyik0/furin-electrobun"),
      "dir"
    );
    await writeFile(join(root, "bunfig.toml"), 'preload = ["@teyik0/furin-electrobun/preload"]\n');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default {desktop:{
        app:{name:"Fixture",identifier:"local.furin.preload"},
        window:{width:800,height:600},dataDir:${JSON.stringify(join(root, "data"))}
      }};`
    );
    await writeFile(join(root, "src/value.ts"), 'export const value = "first";');
    await writeFile(
      join(root, "src/server.ts"),
      `import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import {desktopApp} from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      import {value} from "./value";
      import {appendFileSync} from "node:fs";
      export default new Elysia().use(desktopApp({
        onStartup(){appendFileSync(${JSON.stringify(join(root, "starts"))}, "start\\n");},
        onShutdown(){appendFileSync(${JSON.stringify(join(root, "stops"))}, "stop\\n");}
      })).get("/",()=>({value,pid:process.pid}));
      if(import.meta.main) throw new Error("Launcher evaluated the application");`
    );
    await installSdk(root);
    await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), sdkRunHeader(root));
    child = Bun.spawn([process.execPath, "--hot", "src/server.ts"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const first = await ready();
    const browserUrl = await Bun.file(join(root, "browser-url")).text();
    const windowUrl = await Bun.file(join(root, "window-url")).text();
    expect(browserUrl).not.toBe(windowUrl);
    const responses = await Promise.all(
      [browserUrl, windowUrl].map((url) => fetch(url, { redirect: "manual" }))
    );
    const cookies = responses.map((response) => {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${first.origin}/`);
      return response.headers.get("set-cookie")?.split(";")[0] ?? "";
    });
    expect(cookies[0]).toBe(cookies[1]);
    const [cookie] = cookies;
    const original = (await (
      await fetch(first.origin, { headers: { cookie: cookie ?? "" } })
    ).json()) as { value: string; pid: number };
    expect(original.value).toBe("first");
    expect(await Bun.file(join(root, "starts")).text()).toBe("start\n");
    await writeFile(join(root, "src/value.ts"), 'export const value = "second";');
    const second = await ready(first.url);
    const bootstrap = await fetch(second.url, { redirect: "manual" });
    const fresh = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const replacement = (await (
      await fetch(second.origin, { headers: { cookie: fresh } })
    ).json()) as { value: string; pid: number };
    expect(replacement.value).toBe("second");
    expect(replacement.pid).not.toBe(original.pid);
    expect(await Bun.file(join(root, "starts")).text()).toBe("start\nstart\n");
    const entry = join(root, "src/server.ts");
    await writeFile(
      entry,
      (await Bun.file(entry).text()).replace("({value,pid:", '({value:"third",pid:')
    );
    const third = await ready(second.url);
    const thirdBootstrap = await fetch(third.url, { redirect: "manual" });
    const thirdCookie = thirdBootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const last = (await (
      await fetch(third.origin, { headers: { cookie: thirdCookie } })
    ).json()) as { value: string; pid: number };
    expect(last.value).toBe("third");
    expect(last.pid).not.toBe(replacement.pid);
    expect(await Bun.file(join(root, "starts")).text()).toBe("start\nstart\nstart\n");
    await writeFile(join(root, ".furin/electrobun/control"), "stop");
    expect(await child.exited, (await output).join("\n")).toBe(0);
    expect(await Bun.file(join(root, "stops")).text()).toBe("stop\nstop\nstop\n");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const control = join(root, ".furin/electrobun/control");
      if (await Bun.file(control).exists()) {
        await writeFile(control, "stop");
        await Promise.race([child.exited, Bun.sleep(6000)]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);

test.each([
  ["plain", "src/server.ts", true, false],
  ["hot", "other.ts", true, false],
  ["hot", "src/server.ts", false, false],
  ["hot", "src/server.ts", true, true],
] as const)(
  "desktop preload stays inert for %s / %s / desktop=%s / managed=%s",
  async (mode, entry, configured, managed) => {
    const root = await mkdtemp(join(tmpdir(), "furin-preload-inert-"));
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
      await symlink(
        join(import.meta.dir, ".."),
        join(root, "node_modules/@teyik0/furin-electrobun"),
        "dir"
      );
      await writeFile(
        join(root, "bunfig.toml"),
        'preload = ["@teyik0/furin-electrobun/preload"]\n'
      );
      await writeFile(
        join(root, "furin.config.ts"),
        configured ? "export default {desktop:{}};" : "export default {};"
      );
      const source = `await Bun.write(${JSON.stringify(join(root, "ran"))}, "ran"); process.exit(0);`;
      await writeFile(join(root, "src/server.ts"), source);
      await writeFile(join(root, "other.ts"), source);
      const child = Bun.spawn([process.execPath, ...(mode === "hot" ? ["--hot"] : []), entry], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
        env: { ...process.env, ...(managed ? { FURIN_DESKTOP_DEV: "managed" } : {}) },
      });
      const [code, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(0);
      expect(await Bun.file(join(root, "ran")).text()).toBe("ran");
      expect(await Bun.file(join(root, ".furin")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
