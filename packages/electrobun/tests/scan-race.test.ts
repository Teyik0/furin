import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCommand } from "../src/cli";

test("dependency scans reconcile importer edits without writing build artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-scan-race-"));
  const cwd = process.cwd();
  const original = Bun.build;
  const phases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  let scans = 0;
  let dev: Promise<void> | undefined;
  let failure: unknown;
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Scan fixture deadline expired")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const edit = async (name: string, contents: string) => {
    const changed = Promise.withResolvers<void>();
    const observer = watch(root, { recursive: true }, (_event, filename) => {
      if (filename === name) {
        changed.resolve();
      }
    });
    try {
      await writeFile(join(root, name), contents);
      await bounded(changed.promise);
      await Bun.sleep(0); // Let the supervisor's notification run in the same I/O turn.
    } finally {
      observer.close();
    }
  };
  const ready = async (previous?: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (failure) {
        throw failure;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Observe a new public readiness generation.
        const value: { origin: string; url: string } = await Bun.file(
          join(root, ".furin/electrobun/ready.json")
        ).json();
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
    throw new Error("Backend generation missing");
  };
  try {
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out/server.js"), "consumer output");
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default {
      serverEntry:"server.ts", desktop:{
        app:{name:"Race",identifier:"local.furin.race"},hostEntry:"host.ts",
        window:{width:800,height:600},dataDir:${JSON.stringify(join(root, ".data"))}
      }};`
    );
    await writeFile(join(root, "value.ts"), 'export const value = "old";');
    await writeFile(join(root, "middle.ts"), 'export const value = "fresh";');
    await writeFile(join(root, "deep.ts"), 'export const value = "fresh";');
    await writeFile(
      join(root, "server.ts"),
      `
      import {Elysia} from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
      import {desktopApp} from ${JSON.stringify(join(import.meta.dir, "../src/server.ts"))};
      import {value} from "./value";
      export default new Elysia().use(desktopApp()).get("/",()=>value);`
    );
    await writeFile(
      join(root, "host.ts"),
      `
      import {runDesktopHost} from ${JSON.stringify(join(import.meta.dir, "../src/host.ts"))};
      const sdk={Utils:{paths:{appData:${JSON.stringify(root)}},quit:process.exit},default:{events:{on(){}}}};
      await runDesktopHost(sdk,async({startBackend})=>{await startBackend();});`
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
      if(process.argv[2]!=="run")process.exit(0);
      const config=(await import(process.cwd()+"/electrobun.config.ts")).default;
      await import(config.build.bun.entrypoint);`
    );
    // Delay completion of the real compiler at its public boundary; do not fake its graph.
    Bun.build = async (options) => {
      const result = await original(options);
      const phase = scans;
      scans += 1;
      if (phase < 2) {
        phases[phase]?.resolve();
        await releases[phase]?.promise;
      }
      return result;
    };
    process.chdir(root);
    dev = desktopCommand("dev", root).catch((error) => {
      failure = error;
    });
    await bounded(phases[0].promise);
    await edit("value.ts", 'export {value} from "./middle";');
    releases[0]?.resolve();
    await bounded(phases[1].promise);
    await edit("middle.ts", 'export {value} from "./deep";');
    releases[1]?.resolve();
    const first = await ready();
    const bootstrap = await fetch(first.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    expect(await (await fetch(first.origin, { headers: { cookie: cookie ?? "" } })).text()).toBe(
      "fresh"
    );
    await edit("deep.ts", 'export const value = "updated";');
    const second = await ready(first.url);
    const next = await fetch(second.url, { redirect: "manual" });
    const nextCookie = next.headers.get("set-cookie")?.split(";")[0];
    expect(
      await (await fetch(second.origin, { headers: { cookie: nextCookie ?? "" } })).text()
    ).toBe("updated");
    expect(await Bun.file(join(root, "out/server.js")).text()).toBe("consumer output");
    expect(await readdir(join(root, "out"))).toEqual(["server.js"]);
    expect(await Bun.file(join(root, "server.js")).exists()).toBe(false);
  } finally {
    for (const release of releases) {
      release.resolve();
    }
    Bun.build = original;
    try {
      if (dev) {
        process.emit("SIGTERM");
        await dev;
      }
    } finally {
      process.chdir(cwd);
      await rm(root, { recursive: true, force: true });
    }
  }
  if (failure) {
    throw failure;
  }
}, 20_000);
