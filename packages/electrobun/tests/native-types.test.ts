import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desktopCommand } from "../src/cli";
import { installSdk } from "./fixtures/sdk";

const PACKAGE = join(import.meta.dir, "..");

test("prepare types desktop.native from the native entrypoint without a user declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-native-types-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1.0.0","type":"module"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default {
      desktop: { app: { name: "Types", identifier: "local.furin.native-types" }, build: { bun: { entrypoint: "src/desktop.ts" } } }
    };`
    );
    await installSdk(root);
    await writeFile(join(root, "node_modules/electrobun/bin/electrobun.cjs"), "process.exit(0);");
    await Promise.all(
      ["elysia", "@types/bun"].map(async (name) => {
        const target = join(root, "node_modules", name);
        await mkdir(dirname(target), { recursive: true });
        await symlink(dirname(Bun.resolveSync(`${name}/package.json`, PACKAGE)), target);
      })
    );
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/desktop.ts"),
      `import { defineNative } from "@teyik0/furin-electrobun/host";
      export default defineNative({ greet: async (name: string) => ({ message: name }) });`
    );
    await writeFile(
      join(root, "src/api.ts"),
      `import { desktopContext } from "@teyik0/furin-electrobun/server";
      import { Elysia } from "elysia";
      export const api = new Elysia().use(desktopContext).post("/", async ({ desktop }) => {
        const result: { message: string } | undefined = await desktop?.native.greet("Relay");
        // @ts-expect-error greet expects a string
        await desktop?.native.greet(1);
        // @ts-expect-error unknown native command
        await desktop?.native.missing();
        return result;
      });`
    );
    const sdk = join(PACKAGE, ".furin/sdk/.hutch/devkit/api/sdks/main");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: "./.furin/electrobun/tsconfig.json",
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "esnext",
          types: ["bun"],
          paths: {
            "@teyik0/furin-electrobun/*": [join(PACKAGE, "src/*.ts")],
            "electrobun/main": [join(sdk, "index.ts")],
            "electrobun/main/rpc": [join(sdk, "entries/rpc.ts")],
          },
        },
        include: ["src/**/*.ts"],
      })
    );
    await desktopCommand("prepare", root);
    const compiler = join(
      dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
      "bin/tsc"
    );
    const child = Bun.spawn([process.execPath, compiler, "-p", join(root, "tsconfig.json")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
