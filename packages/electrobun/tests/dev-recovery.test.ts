// biome-ignore-all lint/performance/noAwaitInLoops: Observe real supervisor diagnostics and readiness before editing again.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSdk, sdkRunHeader } from "./fixtures/sdk";

async function fixture(initialValue: string, nativeAlias?: boolean) {
  const root = await mkdtemp(join(tmpdir(), "furin-dev-recovery-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules/@teyik0"), { recursive: true });
  await symlink(
    join(import.meta.dir, ".."),
    join(root, "node_modules/@teyik0/furin-electrobun"),
    "dir"
  );
  await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
  await writeFile(
    join(root, ".signals.ts"),
    'process.on("message", signal => { if(signal === "SIGINT") process.emit(signal); });'
  );
  await writeFile(
    join(root, "bunfig.toml"),
    `preload = [${JSON.stringify(join(root, ".signals.ts"))}, "@teyik0/furin-electrobun/preload"]\n`
  );
  await writeFile(
    join(root, "furin.config.ts"),
    `export default {desktop:{
      app:{name:"Recovery",identifier:"local.furin.recovery"},
      ${nativeAlias ? `build:{bun:{entrypoint:"src/desktop.ts",alias:{"native-helper":${JSON.stringify(join(root, "src/native-helper.ts"))}}}},` : ""}
      dataDir:${JSON.stringify(join(root, ".data"))}
    }};`
  );
  await writeFile(join(root, "src/value.ts"), initialValue);
  await writeFile(
    join(root, "src/server.ts"),
    `import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
    import {desktopApp} from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
    import {appendFileSync} from "node:fs";
    import {value} from "./value";
    let started = false;
    export default new Elysia().use(desktopApp()).onStart(() => {started=true;appendFileSync(${JSON.stringify(join(root, ".starts"))}, "start\\n");}).onStop(() => {appendFileSync(${JSON.stringify(join(root, ".stops"))}, "stop\\n");}).get("/",()=>({value,started,pid:process.pid}));
    if(import.meta.main) throw new Error("Launcher evaluated the application");`
  );
  await installSdk(root);
  await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), sdkRunHeader(root));
  if (nativeAlias) {
    await writeFile(join(root, "src/native-helper.ts"), 'export const value = "native first";');
    await writeFile(
      join(root, "src/desktop.ts"),
      `import {value} from "native-helper";
      import {ApplicationMenu} from "electrobun/main";
      import {appendFileSync} from "node:fs";
      ApplicationMenu.setApplicationMenu([]);
      appendFileSync(${JSON.stringify(join(root, ".native-values"))}, value+"\\n");`
    );
    // Exercise the SDK command boundary with its actual Bun alias build option.
    await writeFile(
      join(root, "node_modules/electrobun/bin/electrobun.cjs"),
      sdkRunHeader(root).replace(
        'await import(require("node:path").resolve(generated, config.build.bun.entrypoint));',
        `const result = await Bun.build({entrypoints:[generated+"/main.ts"],target:"bun",plugins:[{name:"sdk-alias",setup(build){build.onResolve({filter:/.*/},args=>{const target=config.build.bun.alias?.[args.path];if(target)return {path:target};});}}]});
        if (!result.success) throw new AggregateError(result.logs);
        await Bun.write(generated+"/native-bundle.js",result.outputs[0]);
        await import(generated+"/native-bundle.js");`
      )
    );
  }
  const child = Bun.spawn([process.execPath, "--hot", "src/server.ts"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    ipc: () => undefined,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  let diagnostic = "";
  const output = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      diagnostic += decoder.decode(chunk, { stream: true });
    }
    diagnostic += decoder.decode();
  })();
  const waitFor = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 8000;
    while (!(await check())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Development did not recover (${child.exitCode}): ${diagnostic}`);
      }
      await Bun.sleep(20);
    }
  };
  const interrupt = () => {
    if (process.platform === "win32") {
      child.send("SIGINT");
    } else {
      child.kill("SIGINT");
    }
  };
  return {
    root,
    child,
    async compilationFailed(filename: string) {
      await waitFor(() => Promise.resolve(diagnostic.includes(`${filename}:1:`)));
      expect(diagnostic).toContain("Unexpected");
      expect(child.exitCode, diagnostic).toBeNull();
      expect(child.signalCode).toBeNull();
    },
    async ready(previous: string | undefined) {
      const ready = Bun.file(join(root, ".furin/electrobun/ready.json"));
      await waitFor(async () => {
        try {
          const generation: { url: string } = await ready.json();
          return generation.url !== previous;
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
          }
          throw error;
        }
      });
      const generation: { origin: string; url: string } = await ready.json();
      const bootstrap = await fetch(generation.url, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) {
        throw new Error("Missing recovered session");
      }
      const response = (await (await fetch(generation.origin, { headers: { cookie } })).json()) as {
        value: string;
        started: boolean;
        pid: number;
      };
      expect(response.started).toBe(true);
      return { ...generation, ...response, cookie };
    },
    async stop() {
      interrupt();
      expect(await child.exited, diagnostic).toBe(0);
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        interrupt();
      }
      await child.exited;
      await output;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("desktop preload recovers automatically after an invalid backend save", async () => {
  const dev = await fixture('export const value = "first";');
  try {
    const first = await dev.ready(undefined);
    expect(first.value).toBe("first");
    await writeFile(join(dev.root, "src/value.ts"), "export const value = ;");
    await dev.compilationFailed("value.ts");
    await writeFile(join(dev.root, "src/value.ts"), 'export const value = "repaired";');
    const repaired = await dev.ready(first.url);
    expect(repaired.value).toBe("repaired");
    expect(repaired.pid).not.toBe(first.pid);
    expect(await Bun.file(join(dev.root, ".starts")).text()).toBe("start\nstart\n");
    expect(await Bun.file(join(dev.root, ".stops")).text()).toBe("stop\n");
  } finally {
    await dev.close();
  }
}, 25_000);

test("an initially invalid import can be repaired before any dependency graph exists", async () => {
  const dev = await fixture("export const value = ;");
  try {
    await dev.compilationFailed("value.ts");
    expect(await Bun.file(join(dev.root, "window-url")).exists()).toBe(false);
    expect(await Bun.file(join(dev.root, ".starts")).exists()).toBe(false);
    await writeFile(join(dev.root, "src/value.ts"), 'export const value = "repaired";');
    const repaired = await dev.ready(undefined);
    expect(repaired.value).toBe("repaired");
    expect(await Bun.file(join(dev.root, ".starts")).text()).toBe("start\n");

    // This import was not in the last successful graph either.
    await writeFile(join(dev.root, "src/new.ts"), "export const value = ;");
    await writeFile(join(dev.root, "src/value.ts"), 'export {value} from "./new";');
    await dev.compilationFailed("new.ts");
    await writeFile(join(dev.root, "src/new.ts"), 'export const value = "new dependency";');
    const next = await dev.ready(repaired.url);
    expect(next.value).toBe("new dependency");

    await writeFile(join(dev.root, "src/frontend.ts"), "export const label = 1;");
    await Bun.sleep(400);
    const unchanged = await (await fetch(next.origin, { headers: { cookie: next.cookie } })).json();
    expect(unchanged).toHaveProperty("pid", next.pid);
    await dev.stop();
  } finally {
    await dev.close();
  }
}, 25_000);

test("Ctrl-C stops the supervisor while it waits for a compilation repair", async () => {
  const dev = await fixture("export const value = ;");
  try {
    await dev.compilationFailed("value.ts");
    await dev.stop();
    expect(dev.child.signalCode).toBeNull();
  } finally {
    await dev.close();
  }
}, 25_000);

test("native aliased helper edits restart once while frontend edits retain the process", async () => {
  const dev = await fixture('export const value = "first";', true);
  try {
    const first = await dev.ready(undefined);
    await writeFile(join(dev.root, "src/frontend.ts"), "export const label = 1;");
    await Bun.sleep(500);
    expect(await Bun.file(join(dev.root, ".starts")).text()).toBe("start\n");
    const unchanged = await (
      await fetch(first.origin, { headers: { cookie: first.cookie } })
    ).json();
    expect(unchanged).toHaveProperty("pid", first.pid);
    await writeFile(
      join(dev.root, "src/native-helper.ts"),
      'export const value = "native changed";'
    );
    const next = await dev.ready(first.url);
    expect(next.pid).not.toBe(first.pid);
    await Bun.sleep(500);
    expect(await Bun.file(join(dev.root, ".native-values")).text()).toBe(
      "native first\nnative changed\n"
    );
    expect(await Bun.file(join(dev.root, ".starts")).text()).toBe("start\nstart\n");
    expect(await Bun.file(join(dev.root, ".stops")).text()).toBe("stop\n");
    await dev.stop();
  } finally {
    await dev.close();
  }
}, 25_000);
