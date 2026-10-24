import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";

const CORE_VERSION = /^\^?\d+\.\d+\.\d+/;

async function run(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, GIT_EDITOR: "true" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`bun ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  }
  return stdout;
}

// Release-only: exercises the real registry and installs the generated project.
test.skipIf(process.env.FURIN_SCAFFOLDER_RELEASE_SMOKE !== "1").each(["simple", "full"])(
  "the packed scaffolder installs independently and generates a buildable %s project",
  async (template) => {
    const root = await mkdtemp(join(tmpdir(), "furin-scaffolder-release-"));
    try {
      const packageRoot = resolve(import.meta.dir, "..");
      const archive = join(root, "create-furin.tgz");
      await run(packageRoot, ["run", "build"]);
      await run(packageRoot, ["pm", "pack", "--filename", archive]);
      const consumer = join(root, "consumer");
      await mkdir(consumer);
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ private: true, dependencies: { "create-furin": `file:${archive}` } })
      );
      await run(consumer, ["install", "--ignore-scripts"]);
      await rm(join(consumer, "node_modules"), { recursive: true });
      await run(consumer, ["install", "--frozen-lockfile", "--ignore-scripts"]);
      const cli = join(consumer, "node_modules/create-furin/dist/index.js");
      expect((await run(consumer, [cli, "--version"])).trim()).toBe(version);
      await run(consumer, [cli, "generated", "--template", template, "--yes", "--no-install"]);
      const project = join(consumer, "generated");
      const manifest: { dependencies: { "@teyik0/furin": string } } = await Bun.file(
        join(project, "package.json")
      ).json();
      expect(manifest.dependencies["@teyik0/furin"]).toMatch(CORE_VERSION);
      await run(project, ["install"]);
      await run(project, ["run", "build"]);
      await run(project, ["run", "tscheck"]);
      expect(await Bun.file(join(project, ".furin/build/bun/server")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  300_000
);
