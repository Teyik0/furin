import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOST_IMPORT = /from ("[^"]+standard-host\.ts")/;

test("package build removes stale outputs and emits config and server exports", async () => {
  const packageRoot = join(import.meta.dir, "..");
  const root = await mkdtemp(join(packageRoot, ".build-output-"));
  try {
    await cp(join(packageRoot, "src"), join(root, "src"), { recursive: true });
    for (const name of ["build.ts", "tsconfig.json", "tsconfig.dts.json"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Copy the build inputs before invoking the build.
      await cp(join(packageRoot, name), join(root, name));
    }
    await cp(join(packageRoot, "../../tsconfig.base.json"), join(root, "base.json"));
    await writeFile(
      join(root, "tsconfig.json"),
      (await Bun.file(join(root, "tsconfig.json")).text()).replace(
        "../../tsconfig.base.json",
        "./base.json"
      )
    );
    await mkdir(join(root, "dist"));
    await Promise.all(
      ["removed.js", "removed.d.ts"].map((name) => writeFile(join(root, "dist", name), "stale"))
    );
    const child = Bun.spawn([process.execPath, "build.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`Package build failed (${code}):\n${stdout}\n${stderr}`);
    }
    for (const name of ["removed.js", "removed.d.ts"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify each stale output is absent.
      expect(await Bun.file(join(root, "dist", name)).exists()).toBe(false);
    }
    for (const name of ["config.js", "config.d.ts", "server.js", "server.d.ts"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify each public output exists.
      expect(await Bun.file(join(root, "dist", name)).exists()).toBe(true);
    }
    // Built entrypoints bundle the generator: it must still find its shipped assets.
    const probe = await Bun.build({
      entrypoints: [join(root, "src/prepare.ts")],
      external: ["elysia", "elysia/*"],
      naming: "prepare-probe.js",
      outdir: join(root, "dist"),
      target: "bun",
    });
    expect(probe.success).toBe(true);
    const { prepareDesktop } = await import(join(root, "dist/prepare-probe.js"));
    const project = join(root, "project");
    await mkdir(project);
    const generated: string = await prepareDesktop(
      project,
      { app: { name: "Probe", identifier: "local.furin.probe", version: "1.0.0" } },
      { mode: "dev", root: project, serverEntry: join(project, "src/server.ts") }
    );
    expect(await Bun.file(join(generated, "runtime.ts")).exists()).toBe(true);
    const main = await Bun.file(join(generated, "main.ts")).text();
    // Throws when main.ts no longer imports the standard host.
    const [, host] = HOST_IMPORT.exec(main) as RegExpExecArray;
    expect(await Bun.file(JSON.parse(host as string)).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
