import { expect, test } from "bun:test";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyExternalPackages } from "../src/external";

const sdk = process.env.FURIN_ELECTROBUN_SDK_CLI;
const devkit = process.env.FURIN_ELECTROBUN_SDK_DEVKIT;

async function assertMaterialized(path: string): Promise<void> {
  const info = await lstat(path);
  expect(info.isSymbolicLink()).toBe(false);
  if (info.isDirectory()) {
    await Promise.all((await readdir(path)).map((name) => assertMaterialized(join(path, name))));
  }
}

async function findFile(root: string, match: (name: string) => boolean): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && match(path)) {
      return path;
    }
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: Stop scanning once the requested artifact is found.
      const found = await findFile(path, match);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

// Validated only with a macOS arm64 SDK 2.0.2 devkit and its npm CLI; never opens a GUI.
test.skipIf(!(sdk && devkit && process.platform === "darwin" && process.arch === "arm64"))(
  "macOS arm64 SDK stable archive retains materialized external runtime packages",
  async () => {
    if (!(sdk && devkit)) {
      throw new Error("Provide FURIN_ELECTROBUN_SDK_CLI and FURIN_ELECTROBUN_SDK_DEVKIT.");
    }
    const root = await mkdtemp(join(tmpdir(), "furin-external-sdk-"));
    const logs: string[] = [];
    async function run(command: string[], cwd: string): Promise<string> {
      const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      logs.push(`${command.join(" ")} (exit ${code})\n${stdout}\n${stderr}`);
      if (code !== 0) {
        throw new Error(`SDK subprocess failed (${code}).`);
      }
      return stdout;
    }
    try {
      const source = join(root, "source");
      const fixture = join(source, "node_modules/native-fixture");
      const one = join(fixture, "node_modules/@fixture/dep");
      const two = join(source, "node_modules/@fixture/dep");
      const project = join(root, "project");
      await mkdir(one, { recursive: true });
      await mkdir(two, { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "native-fixture",
          version: "1.0.0",
          main: "index.js",
          dependencies: { "@fixture/dep": "1.0.0" },
        })
      );
      await writeFile(join(fixture, "index.js"), "export { default } from '@fixture/dep';");
      const nativeBytes = new Uint8Array([0, 255, 17, 42, 0, 128]);
      await writeFile(join(fixture, "addon.node"), nativeBytes);
      await writeFile(join(fixture, "asset.txt"), "real-sdk-asset");
      await symlink("asset.txt", join(fixture, "linked.asset"));
      await Promise.all(
        (
          [
            [one, 1],
            [two, 2],
          ] as const
        ).map(async ([path, version]) => {
          await writeFile(
            join(path, "package.json"),
            JSON.stringify({
              name: "@fixture/dep",
              version: `${version}.0.0`,
              main: "index.js",
            })
          );
          await writeFile(join(path, "index.js"), `export default ${version};`);
        })
      );
      await copyExternalPackages(source, project, ["native-fixture", "@fixture/dep"]);
      await assertMaterialized(join(project, "node_modules"));
      await rm(source, { recursive: true, force: true });
      await cp(devkit, join(project, ".hutch/devkit"), { recursive: true, dereference: true });
      await writeFile(join(project, "package.json"), '{"type":"module"}');
      await writeFile(
        join(project, "hutch.config.ts"),
        'export default { electrobun: { version: "2.0.2" } };'
      );
      await writeFile(join(project, "main.ts"), "export const inert = true;");
      await writeFile(
        join(project, "electrobun.config.ts"),
        `export default ${JSON.stringify({
          app: {
            name: "ExternalFixture",
            identifier: "local.furin.externalfixture",
            version: "0.1.0",
          },
          build: {
            mainProcess: "bun",
            bun: { entrypoint: "main.ts" },
            copy: { node_modules: "node_modules" },
            mac: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" },
            linux: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" },
            win: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" },
          },
        })};`
      );
      for (const command of ["prepare", "build"]) {
        // biome-ignore lint/performance/noAwaitInLoops: SDK preparation must finish before the build starts.
        await run([process.execPath, sdk, command, "--env=stable"], project);
      }
      const archive = await findFile(
        join(project, "build"),
        (path) => path.includes("/Contents/Resources/") && path.endsWith(".tar.zst")
      );
      expect(archive).not.toBe("");
      const extracted = join(root, "extracted");
      const tar = Bun.zstdDecompressSync(await Bun.file(archive).bytes());
      await new Bun.Archive(tar).extract(extracted);
      const manifest = await findFile(extracted, (path) =>
        path.endsWith("/native-fixture/package.json")
      );
      expect(manifest).not.toBe("");
      const modules = dirname(dirname(manifest));
      expect((await lstat(join(modules, "native-fixture"))).isDirectory()).toBe(true);
      await assertMaterialized(modules);
      expect(new Uint8Array(await readFile(join(modules, "native-fixture/addon.node")))).toEqual(
        nativeBytes
      );
      expect(await readFile(join(modules, "native-fixture/linked.asset"), "utf8")).toBe(
        "real-sdk-asset"
      );
      const packagedBun = await findFile(extracted, (path) => basename(path) === "bun");
      expect(packagedBun).not.toBe("");
      expect((await run([packagedBun, "--version"], extracted)).trim()).toBe("1.4.0");
      const app = dirname(modules);
      await writeFile(
        join(app, "verify.ts"),
        "import one from 'native-fixture'; import two from '@fixture/dep'; if (one !== 1 || two !== 2) throw new Error('wrong versions'); console.log('external-runtime-ok');"
      );
      expect((await run([packagedBun, join(app, "verify.ts")], app)).trim()).toBe(
        "external-runtime-ok"
      );
    } catch (cause) {
      throw new Error(`SDK archive verification failed.\n${logs.join("\n")}`, { cause });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000
);
